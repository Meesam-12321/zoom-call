// Click-to-call, mandatory call outcomes, follow-up tasks, the Today view, callback reminders and call lists.
import express from 'express';
import { nowIso } from './db.js';
import { sendWorkbook } from './excel.js';
import { STAGES, TASK_TYPES } from './fields.js';
import { contactQuery, stamp } from './leads.js';
import { clean, cleanText, toE164 } from './phone.js';
import { TASK_SELECT, UNLOGGED_DAYS, invalidNumbers, visibleCompany, visibleContact } from './queries.js';
import { HttpError, contactName } from './records.js';
import { zoomCallFields } from './sync.js';
import { todayBounds, zonedDateTime } from './time.js';

const DAY_MS = 86_400_000;
// Stages in order; Lost and Nurture sit outside this line.
const PIPELINE = ['new', 'attempted', 'connected', 'interested', 'meeting_booked', 'demo_done', 'proposal_sent', 'won'];
const TASK_TYPE_KEYS = new Set(TASK_TYPES.map(([key]) => key));
const STAGE_LABELS = Object.fromEntries(STAGES);
// Outcomes that end the calling, so a reminder to call again makes no sense.
const NO_REMINDER = new Set(['lost', 'invalid_number', 'dnc']);

export function dialUrl(scheme, e164) {
  if (scheme === 'tel') return `tel:${e164}`;
  if (scheme === 'callto') return `callto:${e164}`;
  return `zoomphonecall://${e164}`;
}

export function pendingCall(store, userId) {
  return store.get(
    `SELECT cl.*, ct.first_name, ct.last_name, co.name AS company_name
     FROM calls cl LEFT JOIN contacts ct ON ct.id = cl.contact_id LEFT JOIN companies co ON co.id = cl.company_id
     WHERE cl.user_id = ? AND cl.disposition IS NULL ORDER BY cl.started_at DESC LIMIT 1`,
    userId,
  ) || null;
}

/** The stage a lead moves to after an outcome. Leads only move forward; Won is final. */
export function nextStage(current, disposition, meetingBooked) {
  if (current === 'won') return current;
  const { action, connected } = disposition;
  if (action === 'lost') return 'lost';
  if (action === 'nurture') return 'nurture';
  if (action === 'positive') {
    const target = meetingBooked ? 'meeting_booked' : 'interested';
    return current === 'lost' || current === 'nurture' || PIPELINE.indexOf(current) < PIPELINE.indexOf(target) ? target : current;
  }
  if (connected) return current === 'new' || current === 'attempted' ? 'connected' : current;
  return current === 'new' ? 'attempted' : current;
}

/** Saves a call's outcome and applies what it means: attempts, follow-up task, stage, invalid number or Do Not Call. */
export function applyOutcome(store, user, call, input) {
  const disposition = store.get('SELECT * FROM dispositions WHERE key = ? AND active = 1', String(input.disposition || ''));
  if (!disposition) throw new HttpError(400, 'Choose the outcome of this call.');
  const company = store.get('SELECT * FROM companies WHERE id = ?', call.company_id);
  const contact = call.contact_id ? store.get('SELECT * FROM contacts WHERE id = ?', call.contact_id) : null;
  const { action } = disposition;
  const time = nowIso();
  const notes = cleanText(input.notes);
  const meetingBooked = action === 'positive' && Boolean(input.meetingBooked);

  // Times are entered in the lead's local time.
  const zone = company.time_zone || store.setting('business_tz');
  let callbackAt = null;
  if (action === 'callback') {
    callbackAt = zonedDateTime(input.callbackAt, zone);
    if (!callbackAt) throw new HttpError(400, 'Enter the date and time to call back.');
  }
  // A reminder the person picked themselves replaces the automatic call task, and alerts them when it is due.
  const remindAt = input.remindAt && action !== 'callback' && !NO_REMINDER.has(action) ? zonedDateTime(input.remindAt, zone) : null;
  if (input.remindAt && action !== 'callback' && !NO_REMINDER.has(action) && !remindAt) throw new HttpError(400, 'Enter the date and time for the reminder.');
  const lostReason = action === 'lost' ? clean(input.lostReason) : null;
  if (action === 'lost' && !lostReason) throw new HttpError(400, 'Choose why the lead is lost.');

  // A call recorded after a newer one (filled in later, say from the Zoom call log) is history: it is saved and counted,
  // but the lead's latest outcome, open tasks and stage stay as the newer call left them.
  const historic = Boolean(store.get(
    'SELECT 1 FROM calls WHERE id != ? AND disposition IS NOT NULL AND started_at > ? AND company_id = ? AND contact_id IS ?',
    call.id, call.started_at, company.id, contact?.id ?? null,
  ));

  store.update('calls', call.id, { disposition: disposition.key, notes, meeting_booked: meetingBooked ? 1 : 0, outcome_at: time });
  if (contact) {
    store.update('contacts', contact.id, {
      attempts: contact.attempts + 1,
      ...(historic ? {} : { last_called_at: call.started_at, last_disposition: disposition.key }),
      updated_at: time,
    });
  }
  // This call takes care of the lead's open call tasks; the outcome decides the next one.
  if (!historic) {
    store.run(
      `UPDATE tasks SET status = 'done', completed_at = ?, call_id = coalesce(call_id, ?)
       WHERE status = 'open' AND type = 'call' AND company_id = ? AND (contact_id IS ? OR contact_id IS NULL)`,
      time, call.id, company.id, contact?.id ?? null,
    );
  }

  let task = null;
  const addTask = (fields) => {
    const id = store.insert('tasks', {
      contact_id: contact?.id ?? null,
      company_id: company.id,
      user_id: company.owner_id ?? call.user_id,
      source: disposition.key,
      call_id: call.id,
      created_at: time,
      ...fields,
    });
    task = store.get('SELECT * FROM tasks WHERE id = ?', id);
    store.log(user.id, 'task', id, 'created', { title: fields.title, due_at: fields.due_at, from: disposition.label });
  };
  const inDays = (n) => new Date(Date.now() + n * DAY_MS).toISOString();

  const automatic = !historic && !remindAt && !input.noFollowUp;
  let companyBlocked = false;
  if (action === 'retry' && automatic) addTask({ type: 'call', title: disposition.task_title || 'Retry call', due_at: inDays(disposition.retry_days ?? 1) });
  else if (action === 'callback') addTask({ type: 'call', title: disposition.task_title || 'Callback', due_at: callbackAt.toISOString(), is_callback: 1 });
  else if (action === 'positive' && !historic) addTask({ type: 'email', title: disposition.task_title || 'Book the meeting and send a follow-up email', due_at: time });
  else if (action === 'nurture' && automatic) addTask({ type: 'call', title: disposition.task_title || 'Nurture follow-up call', due_at: inDays(disposition.retry_days ?? 30) });
  else if (action === 'invalid_number') {
    store.run('INSERT OR IGNORE INTO invalid_numbers (e164, flagged_by, flagged_at) VALUES (?, ?, ?)', call.phone_e164, user.id, time);
    store.log(user.id, 'number', null, 'flagged_invalid', { phone: call.phone_e164, company: company.name });
  } else if (action === 'dnc') {
    // Opt-outs are permanent: only an admin can clear the flag later.
    if (contact) {
      store.update('contacts', contact.id, { do_not_call: 1, dnc_at: time });
      store.log(user.id, 'contact', contact.id, 'do_not_call_set', { via: disposition.label });
      store.run("UPDATE tasks SET status = 'canceled', completed_at = ? WHERE status = 'open' AND contact_id = ?", time, contact.id);
    }
    // Blocking the store's main number blocks the company too.
    companyBlocked = !contact || call.phone_e164 === company.hq_phone_e164;
    if (companyBlocked) {
      store.update('companies', company.id, { do_not_call: 1, dnc_at: time, updated_at: time });
      store.log(user.id, 'company', company.id, 'do_not_call_set', { via: disposition.label });
      store.run("UPDATE tasks SET status = 'canceled', completed_at = ? WHERE status = 'open' AND company_id = ?", time, company.id);
    }
  }

  if (remindAt) addTask({ type: 'call', title: (action !== 'positive' && disposition.task_title) || 'Call back', due_at: remindAt.toISOString(), is_callback: 1 });

  const deal = store.get('SELECT * FROM deals WHERE company_id = ?', company.id);
  let stage = historic ? deal.stage : nextStage(deal.stage, disposition, meetingBooked);
  let reason = action === 'lost' && !historic ? lostReason : deal.lost_reason;
  if (companyBlocked && deal.stage !== 'won') {
    stage = 'lost';
    reason = 'Do not call';
  }
  if (stage !== deal.stage || reason !== deal.lost_reason) {
    store.update('deals', deal.id, { stage, lost_reason: reason, updated_at: time });
    const changes = { stage: [deal.stage, stage] };
    if (reason !== deal.lost_reason) changes.lost_reason = [deal.lost_reason, reason];
    store.log(user.id, 'deal', deal.id, 'stage_changed', { ...changes, via: disposition.label });
  }
  store.log(user.id, 'call', call.id, 'outcome', { outcome: disposition.label, company: company.name, ...(notes && { notes: notes.slice(0, 300) }) });
  return { disposition: disposition.key, stage: { from: deal.stage, to: stage, label: STAGE_LABELS[stage] }, task };
}

function contactPhones(contact, company) {
  return [contact?.mobile_e164, contact?.direct_e164, company?.hq_phone_e164].filter(Boolean);
}

/** Call-list members in list order, limited to leads the user can see. */
function listMembers(store, user, listId) {
  return store.all(
    `SELECT lc.position, ct.id, ct.first_name, ct.last_name, ct.job_title, ct.mobile_e164, ct.direct_e164, ct.attempts,
        ct.last_called_at, ct.last_disposition, ct.do_not_call, co.id AS company_id, co.name AS company_name, co.city, co.state,
        co.hq_phone_e164, co.do_not_call AS company_dnc, co.time_zone, co.priority, d.stage
     FROM list_contacts lc
     JOIN contacts ct ON ct.id = lc.contact_id
     JOIN companies co ON co.id = ct.company_id
     LEFT JOIN deals d ON d.company_id = co.id
     WHERE lc.list_id = ? ${user.role === 'admin' ? '' : 'AND co.owner_id = ?'}
     ORDER BY lc.position`,
    listId,
    ...(user.role === 'admin' ? [] : [user.id]),
  );
}

/** What a call list shows beside each lead: the latest note, the next follow-up, and a Zoom call nobody has recorded yet. */
function withActivity(store, listId, members) {
  const lastCall = new Map();
  const lastNote = new Map();
  const calls = store.all(
    `SELECT lc.contact_id AS member, c.id, c.notes, c.started_at, c.user_id
     FROM list_contacts lc
     JOIN contacts ct ON ct.id = lc.contact_id
     JOIN calls c ON c.contact_id = ct.id OR (c.contact_id IS NULL AND c.company_id = ct.company_id)
     WHERE lc.list_id = ? AND c.disposition IS NOT NULL ORDER BY c.started_at`,
    listId,
  );
  for (const { member, ...call } of calls) {
    lastCall.set(member, call);
    if (call.notes) lastNote.set(member, call);
  }
  // Soonest last, so the soonest open call task wins for each contact and company.
  const tasks = new Map();
  const open = store.all(
    `SELECT t.id, t.title, t.due_at, t.is_callback, t.contact_id, t.company_id FROM tasks t
     WHERE t.status = 'open' AND t.type = 'call'
       AND t.company_id IN (SELECT ct.company_id FROM list_contacts lc JOIN contacts ct ON ct.id = lc.contact_id WHERE lc.list_id = ?)
     ORDER BY t.due_at DESC`,
    listId,
  );
  for (const task of open) tasks.set(task.contact_id ? `contact ${task.contact_id}` : `company ${task.company_id}`, task);
  // Only calls newer than the lead's last recorded one: the rest stay in the Zoom call log.
  const zoom = new Map();
  const unlogged = store.all(
    `SELECT lc.contact_id AS member, z.uuid, z.callee_number AS number, z.start_time, z.duration, z.result
     FROM list_contacts lc
     JOIN contacts ct ON ct.id = lc.contact_id
     JOIN companies co ON co.id = ct.company_id
     JOIN zoom_calls z ON z.direction = 'outbound' AND z.callee_number IN (ct.mobile_e164, ct.direct_e164, co.hq_phone_e164)
     WHERE lc.list_id = ? AND z.start_time >= ? AND z.start_time > coalesce(ct.last_called_at, '')
       AND NOT EXISTS (SELECT 1 FROM calls cl WHERE cl.zoom_uuid = z.uuid)
     ORDER BY z.start_time`,
    listId,
    new Date(Date.now() - UNLOGGED_DAYS * DAY_MS).toISOString(),
  );
  for (const { member, ...call } of unlogged) zoom.set(member, call);
  return members.map((m) => ({
    ...m,
    last_call: lastCall.get(m.id) ?? null,
    last_note: lastNote.get(m.id) ?? null,
    task: tasks.get(`contact ${m.id}`) ?? tasks.get(`company ${m.company_id}`) ?? null,
    zoom: zoom.get(m.id) ?? null,
  }));
}

function visibleList(store, id) {
  const list = store.get('SELECT * FROM lists WHERE id = ?', Number(id));
  if (!list) throw new HttpError(404, 'Call list not found.');
  return list;
}

function addToList(store, user, list, contactIds) {
  let position = store.get('SELECT coalesce(MAX(position), 0) AS n FROM list_contacts WHERE list_id = ?', list.id).n;
  let added = 0;
  store.tx(() => {
    for (const id of contactIds) {
      added += Number(store.run('INSERT OR IGNORE INTO list_contacts (list_id, contact_id, position) VALUES (?, ?, ?)', list.id, id, ++position).changes);
    }
    if (added) store.log(user.id, 'list', list.id, 'contacts_added', { count: added });
  });
  return added;
}

export function callingRoutes(store) {
  const r = express.Router();
  const businessTz = () => store.setting('business_tz');
  const ownCall = (req) => {
    const call = store.get('SELECT * FROM calls WHERE id = ?', Number(req.params.id));
    if (!call || (call.user_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Call not found.');
    return call;
  };

  // ----- calls
  r.get('/calls/pending', (req, res) => res.json({ call: pendingCall(store, req.user.id) }));

  r.post('/calls/start', (req, res) => {
    const pending = pendingCall(store, req.user.id);
    if (pending) throw new HttpError(409, 'Save the outcome of your last call before starting the next one.', { pending });
    const { contactId, companyId, phone, listId, force } = req.body;
    const contact = contactId ? visibleContact(store, req.user, contactId) : null;
    const company = contact ? store.get('SELECT * FROM companies WHERE id = ?', contact.company_id) : visibleCompany(store, req.user, companyId);
    const e164 = toE164(phone);
    if (!e164 || !contactPhones(contact, company).includes(e164)) throw new HttpError(400, "Pick one of this lead's phone numbers.");
    if (contact?.do_not_call || company.do_not_call) throw new HttpError(403, 'This lead is on the Do Not Call list.');
    if (invalidNumbers(store, [e164]).length) {
      throw new HttpError(409, 'This number was marked as a wrong number. Mark it valid on the lead page to call it again.');
    }
    const max = store.setting('max_attempts');
    if (contact && contact.attempts >= max && !force) {
      throw new HttpError(409, `This lead has already had ${contact.attempts} attempts (the maximum is ${max}).`, { maxAttempts: true });
    }
    const list = listId ? store.get('SELECT id FROM lists WHERE id = ?', Number(listId)) : null;
    const id = store.insert('calls', {
      user_id: req.user.id,
      contact_id: contact?.id ?? null,
      company_id: company.id,
      list_id: list?.id ?? null,
      phone_e164: e164,
      started_at: nowIso(),
    });
    store.log(req.user.id, 'call', id, 'started', { phone: e164, company: company.name, ...(contact && { contact: contactName(contact) }) });
    res.json({ call: pendingCall(store, req.user.id), dialUrl: dialUrl(store.setting('dial_scheme'), e164) });
  });

  // A call made outside the CRM (dialed by hand in Zoom), recorded afterwards. Unlike /calls/start nothing blocks it:
  // the call already happened, so Do Not Call, a wrong-number flag or the attempt limit must not lose the record.
  r.post('/calls/log', (req, res) => {
    const { contactId, companyId, listId, zoomUuid } = req.body;
    const contact = contactId ? visibleContact(store, req.user, contactId) : null;
    const company = contact ? store.get('SELECT * FROM companies WHERE id = ?', contact.company_id) : visibleCompany(store, req.user, companyId);
    const zoom = zoomUuid ? store.get('SELECT * FROM zoom_calls WHERE uuid = ?', String(zoomUuid)) : null;
    if (zoomUuid && !zoom) throw new HttpError(404, 'That Zoom call was not found.');
    if (zoom && store.get('SELECT 1 FROM calls WHERE zoom_uuid = ?', zoom.uuid)) throw new HttpError(409, 'That Zoom call has already been recorded.');
    const e164 = zoom ? (zoom.direction === 'inbound' ? zoom.caller_number : zoom.callee_number) : toE164(req.body.phone);
    if (!e164 || !contactPhones(contact, company).includes(e164)) throw new HttpError(400, "Pick one of this lead's phone numbers.");
    const list = listId ? store.get('SELECT id FROM lists WHERE id = ?', Number(listId)) : null;
    // A Zoom call belongs to whoever made it, even if someone else writes the note.
    const dialer = zoom?.caller_email ? store.get('SELECT id FROM users WHERE lower(email) = lower(?) AND active = 1', zoom.caller_email) : null;
    res.json(store.tx(() => {
      const id = store.insert('calls', {
        user_id: dialer?.id ?? req.user.id,
        contact_id: contact?.id ?? null,
        company_id: company.id,
        list_id: list?.id ?? null,
        phone_e164: e164,
        started_at: zoom?.start_time || nowIso(),
        ...(zoom ? zoomCallFields(zoom) : {}),
      });
      store.log(req.user.id, 'call', id, 'logged', { phone: e164, company: company.name, ...(contact && { contact: contactName(contact) }) });
      const result = applyOutcome(store, req.user, store.get('SELECT * FROM calls WHERE id = ?', id), req.body);
      return { ...result, call: store.get('SELECT id, notes, disposition, started_at, user_id FROM calls WHERE id = ?', id) };
    }));
  });

  r.get('/calls/:id', (req, res) => res.json({ call: ownCall(req) }));

  // The note on a call, written or changed at any time.
  r.patch('/calls/:id', (req, res) => {
    const call = ownCall(req);
    const notes = cleanText(req.body.notes);
    store.tx(() => {
      store.update('calls', call.id, { notes });
      store.log(req.user.id, 'call', call.id, 'note_changed', { ...(notes && { notes: notes.slice(0, 300) }) });
    });
    res.json({ notes });
  });

  r.post('/calls/:id/outcome', (req, res) => {
    const call = ownCall(req);
    if (call.disposition) throw new HttpError(409, 'This call already has an outcome.');
    res.json(store.tx(() => applyOutcome(store, req.user, call, req.body)));
  });

  r.post('/calls/:id/discard', (req, res) => {
    const call = ownCall(req);
    if (call.disposition) throw new HttpError(409, 'This call already has an outcome.');
    if (call.zoom_uuid) throw new HttpError(409, 'Zoom logged this call, so it needs an outcome.');
    store.tx(() => {
      store.run('DELETE FROM calls WHERE id = ?', call.id);
      store.log(req.user.id, 'call', call.id, 'discarded', { phone: call.phone_e164 });
    });
    res.json({ ok: true });
  });

  // ----- tasks
  const taskOwner = (req) => {
    if (req.user.role !== 'admin') return req.user.id;
    return req.query.user === 'all' || !req.query.user ? null : Number(req.query.user);
  };

  r.get('/today', (req, res) => {
    const userId = taskOwner(req);
    const { start, end } = todayBounds(businessTz());
    const mine = userId ? 'AND t.user_id = ?' : '';
    const owner = userId ? [userId] : [];
    const tasks = store.all(`${TASK_SELECT} WHERE t.status = 'open' ${mine} AND t.due_at < ? ORDER BY t.due_at`, ...owner, end.toISOString());
    const leadScope = userId ? 'AND co.owner_id = ?' : '';
    const newLeads = `FROM contacts ct JOIN companies co ON co.id = ct.company_id
      WHERE ct.attempts = 0 AND ct.do_not_call = 0 AND co.do_not_call = 0 ${leadScope}`;
    res.json({
      overdue: tasks.filter((t) => t.due_at < start.toISOString()),
      today: tasks.filter((t) => t.due_at >= start.toISOString()),
      newLeads: store.all(
        `SELECT ct.id, ct.first_name, ct.last_name, ct.job_title, ct.mobile_e164, ct.direct_e164, co.id AS company_id,
           co.name AS company_name, co.city, co.state, co.priority, co.hq_phone_e164, co.time_zone
         ${newLeads} ORDER BY co.priority IS NULL, co.priority, co.name COLLATE NOCASE, ct.id LIMIT 25`,
        ...owner,
      ),
      newLeadsTotal: store.get(`SELECT COUNT(*) AS n ${newLeads}`, ...owner).n,
      pending: pendingCall(store, req.user.id),
    });
  });

  r.get('/tasks', (req, res) => {
    const userId = taskOwner(req);
    const { end } = todayBounds(businessTz());
    const mine = userId ? 'AND t.user_id = ?' : '';
    const owner = userId ? [userId] : [];
    const view = req.query.view;
    const tasks = view === 'done'
      ? store.all(`${TASK_SELECT} WHERE t.status != 'open' ${mine} ORDER BY t.completed_at DESC LIMIT 200`, ...owner)
      : view === 'upcoming'
        ? store.all(`${TASK_SELECT} WHERE t.status = 'open' ${mine} AND t.due_at >= ? ORDER BY t.due_at LIMIT 500`, ...owner, end.toISOString())
        : store.all(`${TASK_SELECT} WHERE t.status = 'open' ${mine} ORDER BY t.due_at LIMIT 500`, ...owner);
    res.json({ tasks });
  });

  r.get('/tasks/export', async (req, res) => {
    const userId = taskOwner(req);
    const tasks = store.all(`${TASK_SELECT} WHERE t.status = 'open' ${userId ? 'AND t.user_id = ?' : ''} ORDER BY t.due_at`, ...(userId ? [userId] : []));
    await sendWorkbook(res, 'tasks', [{
      name: 'Open tasks',
      columns: [['due', 'Due', 18], ['type', 'Type'], ['title', 'Task', 36], ['contact', 'Contact', 24], ['company_name', 'Company', 30], ['user_name', 'Assigned to'], ['callback', 'Callback']],
      rows: tasks.map((t) => ({ ...t, due: stamp(t.due_at, businessTz()), contact: [t.first_name, t.last_name].filter(Boolean).join(' '), callback: t.is_callback ? 'Yes' : '' })),
    }]);
  });

  r.post('/tasks', (req, res) => {
    const { contact_id: contactId, company_id: companyId, type = 'call' } = req.body;
    const contact = contactId ? visibleContact(store, req.user, contactId) : null;
    const company = contact ? store.get('SELECT * FROM companies WHERE id = ?', contact.company_id) : visibleCompany(store, req.user, companyId);
    if (!TASK_TYPE_KEYS.has(type)) throw new HttpError(400, 'Unknown task type.');
    const title = clean(req.body.title);
    if (!title) throw new HttpError(400, 'Describe the task.');
    const due = zonedDateTime(req.body.due, businessTz());
    if (!due) throw new HttpError(400, 'Pick when the task is due.');
    const assignee = req.user.role === 'admin' && req.body.user_id ? Number(req.body.user_id) : company.owner_id ?? req.user.id;
    const id = store.insert('tasks', {
      type, title, due_at: due.toISOString(), contact_id: contact?.id ?? null, company_id: company.id, user_id: assignee,
      is_callback: req.body.is_callback ? 1 : 0, source: 'manual', created_at: nowIso(),
    });
    store.log(req.user.id, 'task', id, 'created', { title, due_at: due.toISOString(), company: company.name });
    res.json({ id });
  });

  r.patch('/tasks/:id', (req, res) => {
    const task = store.get('SELECT t.*, co.owner_id FROM tasks t LEFT JOIN companies co ON co.id = t.company_id WHERE t.id = ?', Number(req.params.id));
    if (!task || (req.user.role !== 'admin' && task.user_id !== req.user.id && task.owner_id !== req.user.id)) throw new HttpError(404, 'Task not found.');
    const cols = {};
    if ('status' in req.body) {
      if (!['open', 'done', 'canceled'].includes(req.body.status)) throw new HttpError(400, 'Unknown task status.');
      cols.status = req.body.status;
      cols.completed_at = req.body.status === 'open' ? null : nowIso();
    }
    if ('due' in req.body) {
      const due = zonedDateTime(req.body.due, businessTz());
      if (!due) throw new HttpError(400, 'Pick when the task is due.');
      cols.due_at = due.toISOString();
      cols.reminded_at = null;
    }
    if ('title' in req.body) {
      cols.title = clean(req.body.title);
      if (!cols.title) throw new HttpError(400, 'Describe the task.');
    }
    store.tx(() => {
      store.update('tasks', task.id, cols);
      store.log(req.user.id, 'task', task.id, cols.status ? `marked_${cols.status}` : 'updated', { title: task.title });
    });
    res.json({ ok: true });
  });

  // Callbacks due within 10 minutes (each is returned once), plus the call still waiting for an outcome.
  r.get('/reminders', (req, res) => {
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    const reminders = store.all(
      `${TASK_SELECT} WHERE t.status = 'open' AND t.is_callback = 1 AND t.user_id = ? AND t.reminded_at IS NULL AND t.due_at <= ? ORDER BY t.due_at`,
      req.user.id,
      soon,
    );
    const time = nowIso();
    for (const task of reminders) store.run('UPDATE tasks SET reminded_at = ? WHERE id = ?', time, task.id);
    res.json({ reminders, pending: pendingCall(store, req.user.id) });
  });

  // ----- call lists
  r.get('/lists', (req, res) => {
    const admin = req.user.role === 'admin';
    const { start } = todayBounds(businessTz());
    const members = `FROM list_contacts lc JOIN contacts ct ON ct.id = lc.contact_id JOIN companies co ON co.id = ct.company_id
      WHERE lc.list_id = l.id ${admin ? '' : 'AND co.owner_id = ?'}`;
    const scope = admin ? [] : [req.user.id];
    const lists = store.all(
      `SELECT l.id, l.name, l.created_at, l.created_by, u.name AS created_by_name,
         (SELECT COUNT(*) ${members}) AS total,
         (SELECT COUNT(*) ${members} AND ct.last_called_at >= ?) AS called_today,
         (SELECT COUNT(*) ${members} AND ct.attempts = 0) AS never_called
       FROM lists l LEFT JOIN users u ON u.id = l.created_by ORDER BY l.id DESC`,
      ...scope, ...scope, start.toISOString(), ...scope,
    );
    res.json({ lists: admin ? lists : lists.filter((l) => l.total > 0 || l.created_by === req.user.id) });
  });

  r.post('/lists', (req, res) => {
    const name = clean(req.body.name);
    if (!name) throw new HttpError(400, 'Name the list.');
    const id = store.tx(() => {
      const listId = store.insert('lists', { name, created_by: req.user.id, created_at: nowIso() });
      store.log(req.user.id, 'list', listId, 'created', { name });
      return listId;
    });
    res.json({ id });
  });

  r.get('/lists/:id', (req, res) => {
    const list = visibleList(store, req.params.id);
    res.json({ list, contacts: withActivity(store, list.id, listMembers(store, req.user, list.id)) });
  });

  r.patch('/lists/:id', (req, res) => {
    const list = visibleList(store, req.params.id);
    const name = clean(req.body.name);
    if (!name) throw new HttpError(400, 'Name the list.');
    store.update('lists', list.id, { name });
    store.log(req.user.id, 'list', list.id, 'renamed', { name: [list.name, name] });
    res.json({ ok: true });
  });

  r.delete('/lists/:id', (req, res) => {
    const list = visibleList(store, req.params.id);
    if (req.user.role !== 'admin' && list.created_by !== req.user.id) throw new HttpError(403, 'Only admins or the creator can delete this list.');
    store.tx(() => {
      store.run('DELETE FROM lists WHERE id = ?', list.id);
      store.log(req.user.id, 'list', list.id, 'deleted', { name: list.name });
    });
    res.json({ ok: true });
  });

  // Add contacts by id, by company id (all their contacts) or by the Leads page filters.
  r.post('/lists/:id/add', (req, res) => {
    const list = visibleList(store, req.params.id);
    let ids = [];
    if (Array.isArray(req.body.contactIds)) {
      ids = req.body.contactIds.map(Number).filter((id) => {
        try {
          return Boolean(visibleContact(store, req.user, id));
        } catch {
          return false;
        }
      });
    } else if (Array.isArray(req.body.companyIds)) {
      for (const companyId of req.body.companyIds) {
        const company = visibleCompany(store, req.user, companyId);
        ids.push(...store.all('SELECT id FROM contacts WHERE company_id = ? ORDER BY id', company.id).map((c) => c.id));
      }
    } else if (req.body.filter) {
      const { sql, params } = contactQuery(store, req.user, req.body.filter);
      ids = store.all(`SELECT id FROM (${sql}) ORDER BY company_name COLLATE NOCASE, id`, ...params).map((c) => c.id);
    }
    res.json({ added: addToList(store, req.user, list, ids) });
  });

  r.post('/lists/:id/remove', (req, res) => {
    const list = visibleList(store, req.params.id);
    const ids = (req.body.contactIds || []).map(Number);
    store.tx(() => {
      for (const id of ids) store.run('DELETE FROM list_contacts WHERE list_id = ? AND contact_id = ?', list.id, id);
      store.log(req.user.id, 'list', list.id, 'contacts_removed', { count: ids.length });
    });
    res.json({ ok: true });
  });

  // The next lead to dial: not blocked, has a callable number, not called today and under the attempt limit.
  r.get('/lists/:id/next', (req, res) => {
    const list = visibleList(store, req.params.id);
    const members = listMembers(store, req.user, list.id);
    const invalid = new Set(store.all('SELECT e164 FROM invalid_numbers').map((row) => row.e164));
    const today = todayBounds(businessTz()).start.toISOString();
    const max = store.setting('max_attempts');
    const ready = (m) => !m.do_not_call && !m.company_dnc && !(m.last_called_at >= today) && m.attempts < max
      && [m.mobile_e164, m.direct_e164, m.hq_phone_e164].some((n) => n && !invalid.has(n));
    const after = Number(req.query.after) || 0;
    const start = after ? members.findIndex((m) => m.id === after) + 1 : 0;
    const order = [...members.slice(start), ...members.slice(0, start)].filter((m) => m.id !== after);
    const next = order.find(ready);
    res.json({ contactId: next?.id ?? null, remaining: members.filter(ready).length, total: members.length });
  });

  r.get('/lists/:id/export', async (req, res) => {
    const list = visibleList(store, req.params.id);
    const labels = Object.fromEntries(store.all('SELECT key, label FROM dispositions').map((d) => [d.key, d.label]));
    await sendWorkbook(res, `list-${list.id}`, [{
      name: list.name,
      columns: [
        ['position', '#', 6], ['contact', 'Contact', 24], ['job_title', 'Job title', 26], ['company_name', 'Company', 30],
        ['city', 'City'], ['state', 'State', 8], ['phone', 'Phone', 18], ['stage', 'Stage'], ['attempts', 'Attempts', 10],
        ['last_called', 'Last called', 18], ['last_outcome', 'Last outcome', 24], ['last_note', 'Last note', 48], ['next', 'Next follow-up', 18],
      ],
      rows: withActivity(store, list.id, listMembers(store, req.user, list.id)).map((m, i) => ({
        ...m,
        position: i + 1,
        contact: [m.first_name, m.last_name].filter(Boolean).join(' '),
        phone: m.mobile_e164 || m.direct_e164 || m.hq_phone_e164 || '',
        stage: STAGE_LABELS[m.stage] || m.stage,
        last_called: stamp(m.last_called_at, businessTz()),
        last_outcome: labels[m.last_disposition] || '',
        last_note: m.last_note?.notes || '',
        next: stamp(m.task?.due_at, businessTz()),
      })),
    }]);
  });

  return r;
}

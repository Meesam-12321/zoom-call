// Calls made by hand in Zoom, recorded afterwards: notes against each call, reminders and snoozing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import ExcelJS from 'exceljs';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';
import { linkZoomCalls, saveZoomCalls } from '../server/sync.js';

const TZ = 'America/New_York';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let store;
let server;
let base;
let admin;
let caller;
let zoomItems = [];

function as() {
  let cookie = '';
  return async (route, { method = 'GET', body, expect = 200 } = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { 'X-CRM': '1', cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, expect, `${method} ${route}: ${JSON.stringify(data)}`);
    return data;
  };
}

/** "YYYY-MM-DDTHH:MM" in the business time zone, as a date-time input sends it. */
function local(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

let serial = 0;
/** A new lead with its own number, on its own call list. */
async function newLead() {
  serial++;
  const phone = `+1813555${String(1000 + serial)}`;
  const { id: companyId } = await admin('/companies', { method: 'POST', body: { name: `Store ${serial}`, hq_phone: phone, city: 'Tampa', state: 'FL' } });
  const { id: contactId } = await admin('/contacts', { method: 'POST', body: { company_id: companyId, first_name: 'Pat', last_name: `Lee ${serial}` } });
  const { id: listId } = await admin('/lists', { method: 'POST', body: { name: `List ${serial}` } });
  await admin(`/lists/${listId}/add`, { method: 'POST', body: { contactIds: [contactId] } });
  return { companyId, contactId, listId, phone };
}

const log = (who, lead, body, expect = 200) => who('/calls/log', { method: 'POST', expect, body: { contactId: lead.contactId, phone: lead.phone, listId: lead.listId, ...body } });
const row = async (lead) => (await admin(`/lists/${lead.listId}`)).contacts[0];
const zoomCall = (lead, uuid, start, extra = {}) => ({
  call_history_uuid: uuid,
  direction: 'outbound',
  caller_did_number: '+12395550100',
  callee_did_number: lead.phone,
  caller_email: 'nobody@example.com',
  start_time: new Date(start).toISOString(),
  answer_time: new Date(start + 5000).toISOString(),
  end_time: new Date(start + 95_000).toISOString(),
  duration: 90,
  call_result: 'connected',
  recording_status: 'non_recorded',
  ...extra,
});

before(async () => {
  store = new Store(':memory:');
  const zoom = { configured: () => true, callHistory: async () => ({ items: zoomItems, at: Date.now() }) };
  server = createApp(store, { zoom }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  admin = as();
  caller = as();
  await admin('/auth/setup', { method: 'POST', body: { name: 'Admin', email: 'admin@example.com', password: 'admin-pass-1' } });
  await admin('/users', { method: 'POST', body: { name: 'Sam', email: 'sam@example.com', password: 'caller-pass-1', role: 'caller' } });
  await caller('/auth/login', { method: 'POST', body: { email: 'sam@example.com', password: 'caller-pass-1' } });
});

after(() => server.close());

test("a call made by hand is saved with its note, and the lead's list row shows it", async () => {
  const lead = await newLead();
  const { call, task, stage } = await log(admin, lead, { disposition: 'no_answer', notes: "Didn't pick up." });
  assert.equal(call.notes, "Didn't pick up.");
  assert.equal(task.title, 'Retry call', 'the outcome still creates its usual follow-up');
  assert.deepEqual([stage.from, stage.to], ['new', 'attempted']);
  assert.equal((await admin('/calls/pending')).call, null, 'nothing is left waiting for an outcome');

  const shown = await row(lead);
  assert.equal(shown.attempts, 1);
  assert.equal(shown.last_disposition, 'no_answer');
  assert.equal(shown.last_note.notes, "Didn't pick up.");
  assert.equal(shown.last_call.id, call.id);
  assert.equal(shown.task.title, 'Retry call');

  await log(admin, { ...lead, phone: '+18135550000' }, { disposition: 'no_answer' }, 400);
  await log(admin, lead, { notes: 'No outcome chosen' }, 400);
});

test('"had a conversation" counts as connected and creates no follow-up', async () => {
  const lead = await newLead();
  const { task, stage } = await log(admin, lead, { disposition: 'conversation', notes: 'Had a conversation.' });
  assert.equal(task, null);
  assert.equal(stage.to, 'connected');
  assert.equal((await row(lead)).task, null);
});

test('the conversation outcome reaches existing databases once, and stays off if an admin removes it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-')), 'crm.db');
  const old = new Store(file);
  old.run("DELETE FROM dispositions WHERE key = 'conversation'");
  old.db.close();
  const upgraded = new Store(file);
  assert.equal(upgraded.get("SELECT action, connected, active FROM dispositions WHERE key = 'conversation'").action, 'none');
  upgraded.run("UPDATE dispositions SET active = 0 WHERE key = 'conversation'");
  upgraded.db.close();
  const again = new Store(file);
  assert.equal(again.get("SELECT active FROM dispositions WHERE key = 'conversation'").active, 0);
  assert.equal(again.get("SELECT COUNT(*) AS n FROM dispositions WHERE key = 'conversation'").n, 1);
  again.db.close();
});

test('asked to call back in 2 days: a reminder is set, fires once, and snoozing makes it fire again', async () => {
  const lead = await newLead();
  const inTwoDays = Date.now() + 2 * DAY;
  const { task } = await log(admin, lead, { disposition: 'callback', notes: 'Asked to call back in 2 days.', callbackAt: local(inTwoDays) });
  assert.equal(task.is_callback, 1);
  assert.ok(Math.abs(Date.parse(task.due_at) - inTwoDays) < 2 * MINUTE, 'due in two days');
  assert.ok(!(await admin('/reminders')).reminders.some((r) => r.id === task.id), 'not yet');

  // Due within 10 minutes: it fires, and only once.
  await admin(`/tasks/${task.id}`, { method: 'PATCH', body: { due: local(Date.now() + 5 * MINUTE) } });
  assert.ok((await admin('/reminders')).reminders.some((r) => r.id === task.id));
  assert.ok(!(await admin('/reminders')).reminders.some((r) => r.id === task.id));

  // Snoozed for a day it goes quiet; when it comes due again it fires again.
  await admin(`/tasks/${task.id}`, { method: 'PATCH', body: { due: local(Date.now() + DAY) } });
  assert.ok(!(await admin('/reminders')).reminders.some((r) => r.id === task.id));
  assert.ok((await row(lead)).task.due_at > new Date(Date.now() + 23 * 60 * MINUTE).toISOString(), 'the list shows the new time');
  await admin(`/tasks/${task.id}`, { method: 'PATCH', body: { due: local(Date.now() + 5 * MINUTE) } });
  assert.ok((await admin('/reminders')).reminders.some((r) => r.id === task.id));

  // Canceling it leaves nothing on the list.
  await admin(`/tasks/${task.id}`, { method: 'PATCH', body: { status: 'canceled' } });
  assert.equal((await row(lead)).task, null);
});

test('a reminder picked by hand replaces the automatic follow-up; "no reminder" drops it', async () => {
  const lead = await newLead();
  const inThreeDays = Date.now() + 3 * DAY;
  const { task } = await log(admin, lead, { disposition: 'no_answer', remindAt: local(inThreeDays) });
  assert.equal(task.is_callback, 1, 'a chosen reminder alerts, unlike an automatic retry');
  assert.ok(Math.abs(Date.parse(task.due_at) - inThreeDays) < 2 * MINUTE);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM tasks WHERE company_id = ? AND status = 'open'", lead.companyId).n, 1);

  const none = await log(admin, lead, { disposition: 'no_answer', noFollowUp: true });
  assert.equal(none.task, null);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM tasks WHERE company_id = ? AND status = 'open'", lead.companyId).n, 0, 'the new call closed the older reminder too');

  await log(admin, lead, { disposition: 'no_answer', remindAt: 'soon' }, 400);
  const lost = await log(admin, lead, { disposition: 'negative', lostReason: 'Not interested', remindAt: local(inThreeDays) });
  assert.equal(lost.task, null, 'a lost lead gets no reminder');
});

test('a Zoom call nobody recorded is flagged on the list until a note claims it', async () => {
  const lead = await newLead();
  const started = Date.now() - 20 * MINUTE;
  saveZoomCalls(store, [
    zoomCall(lead, 'zoom-old', started - 3 * 3_600_000, { duration: 30 }),
    zoomCall(lead, 'zoom-new', started, { caller_email: 'sam@example.com' }),
  ]);

  const flagged = await row(lead);
  assert.equal(flagged.zoom.uuid, 'zoom-new', 'the newest one');
  assert.equal(flagged.zoom.duration, 90);
  assert.deepEqual((await admin(`/contacts/${lead.contactId}`)).zoomCalls.map((z) => z.uuid), ['zoom-new', 'zoom-old']);

  const { call } = await log(admin, lead, { disposition: 'conversation', notes: 'Spoke to Pat.', zoomUuid: 'zoom-new', phone: undefined });
  const saved = store.get('SELECT * FROM calls WHERE id = ?', call.id);
  assert.equal(saved.zoom_uuid, 'zoom-new');
  assert.equal(saved.duration, 90);
  assert.equal(saved.started_at, new Date(started).toISOString(), "it takes Zoom's time");
  assert.equal(saved.answered, 1);
  const sam = store.get("SELECT id FROM users WHERE email = 'sam@example.com'");
  assert.equal(saved.user_id, sam.id, 'it belongs to whoever dialed it, not whoever wrote the note');

  const after = await row(lead);
  assert.equal(after.zoom, null, 'older unrecorded calls do not nag: they stay in the Zoom call log');
  assert.equal(after.last_note.notes, 'Spoke to Pat.');
  assert.deepEqual((await admin(`/contacts/${lead.contactId}`)).zoomCalls.map((z) => z.uuid), ['zoom-old'], 'but it can still be chosen');

  await log(admin, lead, { disposition: 'conversation', zoomUuid: 'zoom-new' }, 409);
  await log(admin, lead, { disposition: 'conversation', zoomUuid: 'no-such-call' }, 404);
  const other = await newLead();
  await log(admin, other, { disposition: 'conversation', zoomUuid: 'zoom-old', phone: undefined }, 400);
});

test('recording an older call after a newer one leaves the latest state alone', async () => {
  const lead = await newLead();
  const now = Date.now();
  saveZoomCalls(store, [zoomCall(lead, 'older', now - 2 * 3_600_000), zoomCall(lead, 'newer', now - 3_600_000)]);
  await log(admin, lead, { disposition: 'positive', meetingBooked: true, notes: 'Meeting on Friday.', zoomUuid: 'newer', remindAt: local(now + DAY) });
  const open = store.all("SELECT id FROM tasks WHERE company_id = ? AND status = 'open'", lead.companyId).length;

  const { task, stage } = await log(admin, lead, { disposition: 'negative', lostReason: 'Not interested', notes: 'Said no at first.', zoomUuid: 'older' });
  assert.equal(task, null);
  assert.equal(stage.to, 'meeting_booked', 'the older call does not mark the lead lost');
  assert.equal(store.all("SELECT id FROM tasks WHERE company_id = ? AND status = 'open'", lead.companyId).length, open, 'open tasks stay open');
  const shown = await row(lead);
  assert.equal(shown.last_disposition, 'positive');
  assert.equal(shown.attempts, 2, 'it still counts as an attempt');
  assert.equal(shown.last_note.notes, 'Meeting on Friday.');
});

test('a call recorded by hand is matched to its Zoom record when that arrives later', async () => {
  const lead = await newLead();
  const { call } = await log(admin, lead, { disposition: 'conversation', notes: 'Logged before Zoom had it.' });
  saveZoomCalls(store, [zoomCall(lead, 'late-record', Date.now() - 20 * MINUTE)]);
  linkZoomCalls(store);
  assert.equal(store.get('SELECT zoom_uuid FROM calls WHERE id = ?', call.id).zoom_uuid, 'late-record');

  // A call placed with the Call button started when Zoom opened, so it does not claim a record from 20 minutes earlier.
  const other = await newLead();
  const { call: dialed } = await admin('/calls/start', { method: 'POST', body: { contactId: other.contactId, phone: other.phone } });
  saveZoomCalls(store, [zoomCall(other, 'earlier-record', Date.now() - 20 * MINUTE)]);
  linkZoomCalls(store);
  assert.equal(store.get('SELECT zoom_uuid FROM calls WHERE id = ?', dialed.id).zoom_uuid, null);
  await admin(`/calls/${dialed.id}/discard`, { method: 'POST' });
});

test('the attempt limit and Do Not Call block dialing, but not recording a call that already happened', async () => {
  const lead = await newLead();
  store.run('UPDATE contacts SET attempts = 8 WHERE id = ?', lead.contactId);
  await admin('/calls/start', { method: 'POST', expect: 409, body: { contactId: lead.contactId, phone: lead.phone } });
  assert.equal((await log(admin, lead, { disposition: 'no_answer', notes: 'One more try.' })).call.notes, 'One more try.');

  await admin(`/contacts/${lead.contactId}/dnc`, { method: 'POST', body: { on: true } });
  await admin('/calls/start', { method: 'POST', expect: 403, body: { contactId: lead.contactId, phone: lead.phone, force: true } });
  assert.equal((await log(admin, lead, { disposition: 'no_answer', notes: 'Dialed by mistake.' })).call.notes, 'Dialed by mistake.');
});

test('a note can be changed afterwards by whoever made the call or an admin, and callers only reach their own leads', async () => {
  const lead = await newLead();
  await log(caller, lead, { disposition: 'no_answer' }, 404);

  const sam = store.get("SELECT id FROM users WHERE email = 'sam@example.com'");
  await admin('/companies/assign', { method: 'POST', body: { ids: [lead.companyId], owner_id: sam.id } });
  const { call } = await log(caller, lead, { disposition: 'no_answer' });
  assert.equal(call.notes, null);
  assert.equal((await caller(`/calls/${call.id}`, { method: 'PATCH', body: { notes: 'Rang out twice.' } })).notes, 'Rang out twice.');
  assert.equal((await row(lead)).last_note.notes, 'Rang out twice.');
  assert.equal((await admin(`/calls/${call.id}`, { method: 'PATCH', body: { notes: 'Rang out twice, no voicemail.' } })).notes, 'Rang out twice, no voicemail.');

  const { call: adminCall } = await log(admin, lead, { disposition: 'no_answer' });
  await caller(`/calls/${adminCall.id}`, { method: 'PATCH', expect: 404, body: { notes: 'Not my call' } });

  assert.equal((await admin(`/calls/${call.id}`, { method: 'PATCH', body: { notes: '   ' } })).notes, null, 'a note can be cleared');
  assert.ok(store.get("SELECT 1 FROM activity WHERE entity = 'call' AND action = 'note_changed' AND entity_id = ?", call.id), 'changes are in the activity log');
});

test('the Zoom call log offers a note on calls to leads, for any call shown, and then shows it', async () => {
  const lead = await newLead();
  const started = Date.now() - 1000;
  zoomItems = [zoomCall(lead, 'log-call', started), zoomCall({ phone: '+15555550123' }, 'not-a-lead', started)];
  assert.equal(store.get("SELECT 1 FROM zoom_calls WHERE uuid = 'log-call'"), undefined, 'not synced yet');

  const before = await admin('/zoom/calls?preset=today&tz=UTC&refresh=1');
  const shown = before.calls.find((c) => c.id === 'log-call');
  assert.equal(shown.lead.companyId, lead.companyId);
  assert.equal(shown.recorded, null);
  assert.equal(before.calls.find((c) => c.id === 'not-a-lead').lead, null);

  await log(admin, lead, { disposition: 'conversation', notes: 'From the log.', zoomUuid: 'log-call', phone: undefined });
  const later = await admin('/zoom/calls?preset=today&tz=UTC');
  assert.equal(later.calls.find((c) => c.id === 'log-call').recorded.notes, 'From the log.');
  assert.equal(later.calls.find((c) => c.id === 'not-a-lead').recorded, null);
  zoomItems = [];
});

test('the call list export carries the last note and next follow-up', async () => {
  const lead = await newLead();
  await log(admin, lead, { disposition: 'no_answer', notes: 'Rang out.' });
  const res = await fetch(`${base}/lists/${lead.listId}/export`, { headers: { cookie: await sessionCookie() } });
  assert.equal(res.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const sheet = workbook.worksheets[0];
  const headers = sheet.getRow(1).values;
  const row2 = sheet.getRow(2).values;
  assert.equal(row2[headers.indexOf('Last note')], 'Rang out.');
  assert.ok(row2[headers.indexOf('Next follow-up')], 'the retry task is listed');
});

async function sessionCookie() {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'X-CRM': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'admin-pass-1' }) });
  return res.headers.get('set-cookie').split(';')[0];
}

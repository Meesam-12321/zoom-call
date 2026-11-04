// Read queries shared by several routes: visibility checks, call history, tasks and the activity log.
import { HttpError, withExtra } from './records.js';

/** Callers only see companies (and their contacts) they own; admins see everything. */
export function visibleCompany(store, user, id) {
  const company = store.get('SELECT * FROM companies WHERE id = ?', Number(id));
  if (!company || (user.role !== 'admin' && company.owner_id !== user.id)) throw new HttpError(404, 'Company not found.');
  return company;
}

export function visibleContact(store, user, id) {
  const contact = store.get('SELECT ct.*, co.owner_id FROM contacts ct JOIN companies co ON co.id = ct.company_id WHERE ct.id = ?', Number(id));
  if (!contact || (user.role !== 'admin' && contact.owner_id !== user.id)) throw new HttpError(404, 'Contact not found.');
  return contact;
}

export function callHistory(store, where, ...params) {
  return store.all(
    `SELECT cl.*, u.name AS user_name, ct.first_name, ct.last_name, co.name AS company_name, d.label AS disposition_label, d.connected
     FROM calls cl
     LEFT JOIN users u ON u.id = cl.user_id
     LEFT JOIN contacts ct ON ct.id = cl.contact_id
     LEFT JOIN companies co ON co.id = cl.company_id
     LEFT JOIN dispositions d ON d.key = cl.disposition
     WHERE ${where} ORDER BY cl.started_at DESC LIMIT 100`,
    ...params,
  );
}

export const TASK_SELECT = `SELECT t.*, ct.first_name, ct.last_name, ct.job_title, ct.mobile_e164, ct.direct_e164,
    ct.do_not_call AS contact_dnc, co.name AS company_name, co.hq_phone_e164, co.time_zone, co.do_not_call AS company_dnc,
    u.name AS user_name
  FROM tasks t
  LEFT JOIN contacts ct ON ct.id = t.contact_id
  LEFT JOIN companies co ON co.id = t.company_id
  LEFT JOIN users u ON u.id = t.user_id`;

export function activityFor(store, pairs) {
  const clauses = pairs.map(() => '(a.entity = ? AND a.entity_id = ?)').join(' OR ');
  return store.all(
    `SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE ${clauses} ORDER BY a.id DESC LIMIT 100`,
    ...pairs.flat(),
  ).map((row) => ({ ...row, details: row.details ? JSON.parse(row.details) : null }));
}

/** How far back a call dialed by hand in Zoom is still offered for a note. Older ones stay reachable from the Zoom call log. */
export const UNLOGGED_DAYS = 14;

/** Recent calls to these numbers in Zoom's history that no CRM call has claimed: dialed by hand, with no note yet. */
export function unloggedZoomCalls(store, numbers) {
  const list = [...new Set(numbers.filter(Boolean))];
  if (!list.length) return [];
  return store.all(
    `SELECT z.uuid, z.callee_number AS number, z.start_time, z.duration, z.result FROM zoom_calls z
     WHERE z.direction = 'outbound' AND z.start_time >= ? AND z.callee_number IN (${list.map(() => '?').join(', ')})
       AND NOT EXISTS (SELECT 1 FROM calls cl WHERE cl.zoom_uuid = z.uuid)
     ORDER BY z.start_time DESC LIMIT 10`,
    new Date(Date.now() - UNLOGGED_DAYS * 86_400_000).toISOString(),
    ...list,
  );
}

export function invalidNumbers(store, numbers) {
  const list = numbers.filter(Boolean);
  if (!list.length) return [];
  return store.all(`SELECT e164 FROM invalid_numbers WHERE e164 IN (${list.map(() => '?').join(', ')})`, ...list).map((row) => row.e164);
}

/** Everything a page needs to show one lead: the contact (if any), its company, pipeline entry, calls and tasks. */
export function leadDetail(store, company, contact = null) {
  const companyCalls = 'cl.company_id = ?';
  return {
    contact: withExtra(contact),
    company: withExtra(company),
    owner: company.owner_id ? store.get('SELECT id, name FROM users WHERE id = ?', company.owner_id) : null,
    deal: store.get('SELECT * FROM deals WHERE company_id = ?', company.id),
    contacts: store.all(
      "SELECT * FROM contacts WHERE company_id = ? ORDER BY (role_type = 'decision_maker') DESC, id",
      company.id,
    ),
    calls: contact
      ? callHistory(store, 'cl.contact_id = ? OR (cl.company_id = ? AND cl.contact_id IS NULL)', contact.id, company.id)
      : callHistory(store, companyCalls, company.id),
    tasks: store.all(
      `${TASK_SELECT} WHERE t.company_id = ? AND (t.status = 'open' OR t.completed_at >= ?) ORDER BY t.status = 'open' DESC, t.due_at`,
      company.id,
      new Date(Date.now() - 14 * 86_400_000).toISOString(),
    ),
    lists: contact
      ? store.all('SELECT l.id, l.name FROM list_contacts lc JOIN lists l ON l.id = lc.list_id WHERE lc.contact_id = ? ORDER BY l.name', contact.id)
      : [],
    invalid: invalidNumbers(store, [contact?.mobile_e164, contact?.direct_e164, company.hq_phone_e164]),
    zoomCalls: unloggedZoomCalls(store, [contact?.mobile_e164, contact?.direct_e164, company.hq_phone_e164]),
  };
}

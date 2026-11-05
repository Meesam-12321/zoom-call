// Finding what an incoming import row duplicates: the CRM record it matches, which fields match, and where that record came from.
import { formatPhone } from './phone.js';
import { contactName } from './records.js';

const lower = (value) => String(value ?? '').toLowerCase();
const same = (a, b) => Boolean(a) && Boolean(b) && lower(a) === lower(b);

/** One way two records can match: the field, its label, the shared value, and a query for the ids of records sharing it. */
const rule = (field, label, value, sql, ...params) => ({ field, label, value, sql: `${sql} ORDER BY id LIMIT 25`, params });

/**
 * Runs the rules (falsy entries are skipped) and returns [id, matched fields] for the existing record that matches on the
 * most fields, or null. On a tie the record the earlier rule found wins, so an identical email beats an identical phone number.
 */
function bestMatch(store, rules) {
  const found = new Map();
  for (const { sql, params, ...match } of rules.filter(Boolean)) {
    for (const { id } of store.all(sql, ...params)) found.set(id, [...(found.get(id) ?? []), match]);
  }
  return [...found].sort((a, b) => b[1].length - a[1].length)[0] ?? null;
}

/** Where an existing record came from: the file it was imported from (none if it was typed in), when, and the call lists it is on. */
function origin(record, lists, filename) {
  return {
    file: record.source,
    at: record.created_at,
    lists: lists.map((list) => list.name),
    sameFile: same(record.source, filename),
  };
}

/**
 * The company in the CRM that an incoming company row duplicates (same name, or same HQ phone number), or null.
 * `weak` means only the phone number matches: chains and call centres share one number between several companies.
 */
export function matchCompany(store, cols, filename) {
  const found = bestMatch(store, [
    cols.name_key && rule('name', 'Company name', cols.name, 'SELECT id FROM companies WHERE name_key = ?', cols.name_key),
    cols.hq_phone_e164 && rule('phone', 'HQ phone number', formatPhone(cols.hq_phone_e164), 'SELECT id FROM companies WHERE hq_phone_e164 = ?', cols.hq_phone_e164),
  ]);
  if (!found) return null;
  const [id, matched] = found;
  const company = store.get('SELECT * FROM companies WHERE id = ?', id);
  const lists = store.all(
    'SELECT DISTINCT l.id, l.name FROM contacts ct JOIN list_contacts lc ON lc.contact_id = ct.id JOIN lists l ON l.id = lc.list_id WHERE ct.company_id = ? ORDER BY l.id LIMIT 3',
    id,
  );
  return { id, label: company.name, matched, weak: !matched.some((m) => m.field === 'name'), ...origin(company, lists, filename) };
}

/**
 * The contact in the CRM that an incoming contact row duplicates (same email, same phone number, or same name at the same
 * company), or null. `companyId` is the company the row belongs to, when it is already in the CRM.
 * `weak` means the names disagree (neither first nor last name is the same): two people can share a mailbox or a number.
 */
export function matchContact(store, cols, companyId, filename) {
  const phones = [...new Set([cols.mobile_e164, cols.direct_e164].filter(Boolean))];
  const found = bestMatch(store, [
    cols.email && rule('email', 'Email', cols.email, 'SELECT id FROM contacts WHERE email = ? COLLATE NOCASE', cols.email),
    ...phones.map((phone) => rule('phone', 'Phone number', formatPhone(phone), 'SELECT id FROM contacts WHERE mobile_e164 = ? OR direct_e164 = ?', phone, phone)),
    companyId && rule(
      'name', 'Name and company', contactName(cols),
      `SELECT id FROM contacts WHERE company_id = ? AND lower(coalesce(first_name, '')) = ? AND lower(coalesce(last_name, '')) = ?`,
      companyId, lower(cols.first_name), lower(cols.last_name),
    ),
  ]);
  if (!found) return null;
  const [id, matched] = found;
  const contact = store.get('SELECT ct.*, co.name AS company_name FROM contacts ct JOIN companies co ON co.id = ct.company_id WHERE ct.id = ?', id);
  const lists = store.all('SELECT l.name FROM list_contacts lc JOIN lists l ON l.id = lc.list_id WHERE lc.contact_id = ? ORDER BY l.id LIMIT 3', id);
  return {
    id,
    label: `${contactName(contact)} · ${contact.company_name}`,
    matched,
    weak: !(same(cols.first_name, contact.first_name) || same(cols.last_name, contact.last_name)),
    ...origin(contact, lists, filename),
  };
}

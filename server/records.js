// Normalizing, creating and updating companies and contacts (shared by the CRM routes and the importer).
import { nowIso } from './db.js';
import { COMPANY_FIELDS, CONTACT_FIELDS, ROLE_TYPES } from './fields.js';
import { clean, cleanText, extractEmail, guessTimeZone, stateCode, toE164 } from './phone.js';
import { isValidTimeZone } from './time.js';

export class HttpError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const COMPANY_KEYS = new Set(COMPANY_FIELDS.map(([key]) => key));
const CONTACT_KEYS = new Set(CONTACT_FIELDS.map(([key]) => key));
const ROLE_KEYS = new Set(ROLE_TYPES.map(([key]) => key));
const LONG_TEXT = new Set(['about', 'notes']);
// Columns derived from others; they are not shown in change history.
const DERIVED = new Set(['name_key', 'hq_phone_e164', 'mobile_e164', 'direct_e164', 'updated_at']);

/** Matching key for company names: case, punctuation and suffixes such as "Inc." are ignored. */
export function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:inc|llc|ltd|co|corp|corporation|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const contactName = (c) => [c.first_name, c.middle_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unnamed contact';

function strictEmail(value) {
  if (!value) return null;
  const found = extractEmail(value);
  if (!found) throw new HttpError(400, `"${value}" is not a valid email address.`);
  return found;
}

/** Role from a value like "Decision maker"; without one, clear owner-level titles of named people count as decision makers. */
export function roleType(value, title, lastName) {
  const text = clean(value)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (text && ROLE_KEYS.has(text)) return text;
  if (text === 'dm') return 'decision_maker';
  if (!text && lastName && /\b(?:owner|president|ceo|founder|principal|partner|vp|general manager|director)\b/i.test(title || '')) return 'decision_maker';
  return 'other';
}

/** Database columns for the company fields present in `input`. Throws HttpError(400) for invalid values. */
export function companyColumns(input) {
  const cols = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!COMPANY_KEYS.has(key)) continue;
    const value = LONG_TEXT.has(key) ? cleanText(raw) : clean(raw);
    if (key === 'name') {
      if (!value) throw new HttpError(400, 'Company name is required.');
      cols.name = value;
      cols.name_key = nameKey(value);
    } else if (key === 'hq_phone') {
      cols.hq_phone = value;
      cols.hq_phone_e164 = toE164(value);
    } else if (key === 'state') cols.state = stateCode(value);
    else if (key === 'email') cols.email = strictEmail(value);
    else if (key === 'lead_score') {
      const score = Number.parseInt(value, 10);
      cols.lead_score = Number.isFinite(score) ? score : null;
    } else if (key === 'time_zone') {
      if (value && !isValidTimeZone(value)) throw new HttpError(400, `Unknown time zone "${value}".`);
      cols.time_zone = value;
    } else cols[key] = value;
  }
  return cols;
}

/** Database columns for the contact fields present in `input` (Do Not Call is changed separately). */
export function contactColumns(input) {
  const cols = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!CONTACT_KEYS.has(key) || key === 'do_not_call') continue;
    const value = LONG_TEXT.has(key) ? cleanText(raw) : clean(raw);
    if (key === 'mobile') {
      cols.mobile = value;
      cols.mobile_e164 = toE164(value);
    } else if (key === 'direct_line') {
      cols.direct_line = value;
      cols.direct_e164 = toE164(value);
    } else if (key === 'email') cols.email = strictEmail(value);
    else if (key === 'role_type') cols.role_type = roleType(value);
    else cols[key] = value;
  }
  return cols;
}

/** Only columns that are empty on the existing record: an import "merge" never overwrites CRM data. */
export function blanksOnly(existing, cols) {
  return Object.fromEntries(
    Object.entries(cols).filter(([key, value]) => value !== null && value !== undefined && (existing[key] === null || existing[key] === undefined || existing[key] === '')),
  );
}

/** Adds keys from `extra` that the stored JSON object does not have yet. */
export function mergeExtra(stored, extra) {
  const current = JSON.parse(stored || '{}');
  for (const [key, value] of Object.entries(extra || {})) if (value && !current[key]) current[key] = value;
  return JSON.stringify(current);
}

function changesBetween(existing, cols) {
  const changes = {};
  for (const [key, value] of Object.entries(cols)) {
    if ((existing[key] ?? null) !== (value ?? null)) changes[key] = [existing[key] ?? null, value ?? null];
  }
  return changes;
}

const visibleChanges = (changes) => Object.fromEntries(Object.entries(changes).filter(([key]) => !DERIVED.has(key)));

export function createCompany(store, userId, cols, { ownerId = null, extra = {}, action = 'created' } = {}) {
  if (!cols.name) throw new HttpError(400, 'Company name is required.');
  const time = nowIso();
  const timeZone = cols.time_zone || guessTimeZone({ state: cols.state, city: cols.city, phone: cols.hq_phone_e164 });
  const id = store.insert('companies', { ...cols, time_zone: timeZone, owner_id: ownerId, extra: JSON.stringify(extra), created_at: time, updated_at: time });
  store.insert('deals', { company_id: id, stage: 'new', updated_at: time });
  store.log(userId, 'company', id, action, { name: cols.name });
  return id;
}

/** Applies `cols`, re-guesses the time zone when location fields change, and logs what changed. */
export function updateCompany(store, userId, existing, cols, { action = 'updated' } = {}) {
  const changes = changesBetween(existing, cols);
  if (['state', 'city', 'hq_phone_e164'].some((key) => key in changes) && !('time_zone' in cols)) {
    const next = { ...existing, ...cols };
    const guess = guessTimeZone({ state: next.state, city: next.city, phone: next.hq_phone_e164 });
    if (guess && guess !== existing.time_zone) changes.time_zone = [existing.time_zone, guess];
  }
  if (!Object.keys(changes).length) return changes;
  store.update('companies', existing.id, { ...Object.fromEntries(Object.entries(changes).map(([key, [, value]]) => [key, value])), updated_at: nowIso() });
  store.log(userId, 'company', existing.id, action, visibleChanges(changes));
  return changes;
}

export function createContact(store, userId, companyId, cols, { extra = {}, action = 'created' } = {}) {
  const time = nowIso();
  const id = store.insert('contacts', { role_type: 'other', ...cols, company_id: companyId, extra: JSON.stringify(extra), created_at: time, updated_at: time });
  store.log(userId, 'contact', id, action, { name: contactName(cols) });
  return id;
}

export function updateContact(store, userId, existing, cols, { action = 'updated' } = {}) {
  const changes = changesBetween(existing, cols);
  if (!Object.keys(changes).length) return changes;
  store.update('contacts', existing.id, { ...Object.fromEntries(Object.entries(changes).map(([key, [, value]]) => [key, value])), updated_at: nowIso() });
  store.log(userId, 'contact', existing.id, action, visibleChanges(changes));
  return changes;
}

/** Parses the stored `extra` JSON (spreadsheet columns kept from the import) into an object. */
export const withExtra = (row) => row && { ...row, extra: JSON.parse(row.extra || '{}') };

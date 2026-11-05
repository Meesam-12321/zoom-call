// Excel/CSV import: upload → map columns (HV template, saved presets or automatic) → validation report and
// duplicate decisions → import. Contacts are linked to companies by company name.
// A row that matches a record already in the CRM is flagged as a potential duplicate (which fields match, and which file
// that record came from) and is never created a second time unless someone chooses "create anyway".
import crypto from 'node:crypto';
import express from 'express';
import { requireAdmin } from './auth.js';
import { nowIso } from './db.js';
import { matchCompany, matchContact } from './duplicates.js';
import { readWorkbook } from './excel.js';
import { COMPANY_FIELDS, CONTACT_FIELDS } from './fields.js';
import { clean, cleanText, extractEmail } from './phone.js';
import {
  HttpError, blanksOnly, companyColumns, contactColumns, contactName, createCompany, createContact, mergeExtra, roleType,
  updateCompany, updateContact,
} from './records.js';
import { isValidTimeZone } from './time.js';

const UPLOAD_TTL_MS = 60 * 60_000;
const uploads = new Map(); // token → { filename, sheets, at }

const COMPANY_TARGETS = COMPANY_FIELDS.map(([key]) => `company.${key}`);
const CONTACT_TARGETS = CONTACT_FIELDS.map(([key]) => `contact.${key}`);
const VALID_TARGETS = new Set(['', 'extra', ...COMPANY_TARGETS, ...CONTACT_TARGETS]);

const normalizeHeader = (header) => String(header).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Spreadsheet headers (normalized) for each CRM field, best match first. Each field takes at most one column.
const SYNONYMS = {
  'company.name': ['company name', 'company', 'business name', 'account name', 'organization', 'organisation', 'store name'],
  'company.department': ['pt department', 'company department'],
  'company.industry': ['industry'],
  'company.status': ['company status'],
  'company.category': ['company category', 'category'],
  'company.revenue_range': ['revenue range'],
  'company.revenue': ['revenue', 'annual revenue'],
  'company.employee_range': ['employees range', 'employee range', 'employees', 'company size', 'headcount'],
  'company.website': ['website', 'website url', 'company website', 'web', 'url', 'domain'],
  'company.region': ['region', 'country'],
  'company.state': ['location province state', 'state', 'province', 'state province'],
  'company.address': ['address', 'company address', 'street address', 'store address'],
  'company.linkedin_url': ['linkedin company profile url', 'company linkedin', 'company linkedin url', 'linkedin company url'],
  'company.hq_phone': ['company hq number', 'hq phone', 'hq number', 'company phone', 'store phone', 'main phone', 'business phone', 'public business phone', 'phone', 'phone number'],
  'company.date_founded': ['date founded', 'founded', 'year founded', 'established'],
  'company.about': ['about company', 'about', 'company description', 'description'],
  'company.area': ['florida region', 'area', 'territory', 'sales region', 'market'],
  'company.city': ['city', 'town'],
  'company.email': ['store email', 'company email', 'business email', 'public business email', 'general email'],
  'company.opening_hours': ['opening hours', 'hours', 'business hours', 'store hours'],
  'company.facebook_url': ['facebook page', 'facebook', 'facebook url'],
  'company.instagram_url': ['instagram', 'instagram url', 'instagram page'],
  'company.priority': ['priority', 'priority tier', 'tier'],
  'company.evidence_notes': ['evidence additional notes', 'evidence', 'additional notes', 'company notes'],
  'company.key_people': ['owners key people', 'key people', 'owners', 'owner decision maker name', 'decision makers'],
  'company.contacts_listed': ['contacts listed'],
  'company.source_urls': ['research source urls', 'source urls', 'sources'],
  'company.time_zone': ['time zone', 'timezone'],
  'company.lead_score': ['lead score', 'score'],
  'contact.first_name': ['first name', 'firstname', 'first'],
  'contact.middle_name': ['middle name', 'middle'],
  'contact.last_name': ['last name', 'lastname', 'surname', 'last'],
  'contact.job_title': ['job title', 'title', 'position', 'designation'],
  'contact.department': ['department'],
  'contact.management_level': ['management level', 'seniority'],
  'contact.email': ['email', 'email address', 'work email', 'contact email', 'e mail'],
  'contact.employment_status': ['employment status'],
  'contact.mobile': ['mobile', 'mobile phone', 'mobile number', 'cell', 'cell phone'],
  'contact.direct_line': ['direct', 'direct line', 'direct phone', 'direct dial', 'direct number', 'phone', 'phone number', 'work phone'],
  'contact.linkedin_url': ['linkedin profile', 'linkedin', 'linkedin url', 'linkedin profile url'],
  'contact.current_address': ['current address', 'contact address'],
  'contact.location': ['location', 'contact location'],
  'contact.email_type': ['email type'],
  'contact.notes': ['research first call note', 'first call note', 'notes', 'note', 'comments'],
  'contact.source_urls': ['source urls', 'sources'],
  'contact.role_type': ['role type'],
  'contact.do_not_call': ['do not call', 'dnc'],
};
const KNOWN_HEADERS = new Set(Object.values(SYNONYMS).flat());
const ROW_NUMBER = /^(?:no|#|sr|sl|s no|row|row number)$/;

// The HV template: Company Information + Contact Information; the other tabs are research summaries.
export const HV_PRESET = {
  name: 'HV template',
  sheets: { 'Company Information': { type: 'companies' }, 'Contact Information': { type: 'contacts' } },
};

/** The header row is the one (in the first 60) with the most recognisable column names. */
function findHeaderRow(rows) {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const cells = rows[i].filter(Boolean);
    if (cells.length < 2) continue;
    const score = cells.filter((cell) => KNOWN_HEADERS.has(normalizeHeader(cell))).length * 10 + cells.length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

function prepareSheet({ name, rows }) {
  const headerIndex = findHeaderRow(rows);
  const headerCells = rows[headerIndex] || [];
  const body = rows.slice(headerIndex + 1);
  const width = body.reduce((max, row) => Math.max(max, row.length), headerCells.length);
  const headers = [];
  const columns = [];
  const seen = new Map();
  for (let c = 0; c < width; c++) {
    const text = String(headerCells[c] || '').replace(/\s+/g, ' ').trim();
    if (!text && !body.some((row) => clean(row[c]))) continue;
    const label = text || `Column ${c + 1}`;
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    headers.push(n > 1 ? `${label} (${n})` : label);
    columns.push(c);
  }
  const records = [];
  body.forEach((row, i) => {
    if (!row.some((value) => clean(value))) return;
    const record = { _row: headerIndex + i + 2 };
    columns.forEach((c, j) => {
      record[headers[j]] = row[c] ?? '';
    });
    records.push(record);
  });
  return { name, headerRow: headerIndex + 1, headers, records };
}

function autoMapping(headers, type) {
  const targets = type === 'contacts' ? [...CONTACT_TARGETS, ...COMPANY_TARGETS] : COMPANY_TARGETS;
  const normalized = headers.map(normalizeHeader);
  const mapping = Object.fromEntries(headers.map((header, i) => [header, ROW_NUMBER.test(normalized[i]) ? '' : 'extra']));
  for (const target of targets) {
    for (const synonym of SYNONYMS[target] || []) {
      const i = normalized.findIndex((n, j) => n === synonym && mapping[headers[j]] === 'extra');
      if (i >= 0) {
        mapping[headers[i]] = target;
        break;
      }
    }
  }
  return mapping;
}

function autoSheetConfig(sheet) {
  const asContacts = autoMapping(sheet.headers, 'contacts');
  const targets = Object.values(asContacts);
  if (targets.includes('contact.first_name') || targets.includes('contact.last_name')) return { type: 'contacts', columns: asContacts };
  const asCompanies = autoMapping(sheet.headers, 'companies');
  return { type: Object.values(asCompanies).includes('company.name') ? 'companies' : 'skip', columns: asCompanies };
}

/** Column mapping for every sheet: from a preset when given (sheets it does not name are skipped), else automatic. */
function configFor(sheets, preset) {
  const config = { sheets: {} };
  for (const sheet of sheets) {
    const rule = preset?.sheets?.[sheet.name];
    if (!rule) {
      config.sheets[sheet.name] = preset ? { type: 'skip', columns: autoMapping(sheet.headers, 'companies') } : autoSheetConfig(sheet);
      continue;
    }
    const columns = autoMapping(sheet.headers, rule.type === 'contacts' ? 'contacts' : 'companies');
    for (const header of sheet.headers) if (rule.columns && header in rule.columns) columns[header] = rule.columns[header];
    config.sheets[sheet.name] = { type: rule.type, columns };
  }
  return config;
}

function savedPresets(store) {
  return store.all('SELECT * FROM presets ORDER BY id DESC').map((p) => ({ id: p.id, name: p.name, ...JSON.parse(p.config) }));
}

const presetList = (store) => [{ id: 'hv', name: 'HV template (built in)' }, ...savedPresets(store).map(({ id, name }) => ({ id, name }))];

function findPreset(store, id) {
  if (id === 'hv') return { id: 'hv', ...HV_PRESET };
  return savedPresets(store).find((p) => p.id === Number(id)) || null;
}

/** A saved preset whose sheets are all in the file (newest first), else the HV template if it fits. */
function matchPreset(store, sheets) {
  const names = new Set(sheets.map((s) => s.name));
  const fits = (preset) => Object.keys(preset.sheets).length && Object.keys(preset.sheets).every((name) => names.has(name));
  return savedPresets(store).find(fits) || (fits(HV_PRESET) ? { id: 'hv', ...HV_PRESET } : null);
}

function validConfig(upload, config) {
  const out = { sheets: {} };
  for (const sheet of upload.sheets) {
    const requested = config?.sheets?.[sheet.name];
    const type = ['companies', 'contacts'].includes(requested?.type) ? requested.type : 'skip';
    const columns = {};
    const used = new Map();
    for (const header of sheet.headers) {
      const target = requested?.columns?.[header] ?? 'extra';
      if (!VALID_TARGETS.has(target) || (type === 'companies' && target.startsWith('contact.'))) {
        throw new HttpError(400, `Column "${header}" on "${sheet.name}" can't be imported as that field.`);
      }
      if (type !== 'skip' && target && target !== 'extra') {
        if (used.has(target)) throw new HttpError(400, `On "${sheet.name}", both "${used.get(target)}" and "${header}" are set to the same field.`);
        used.set(target, header);
      }
      columns[header] = target;
    }
    if (type !== 'skip' && !used.has('company.name')) {
      throw new HttpError(400, `On "${sheet.name}", choose the column that holds the company name.`);
    }
    out.sheets[sheet.name] = { type, columns };
  }
  if (!Object.values(out.sheets).some((s) => s.type !== 'skip')) throw new HttpError(400, 'Choose at least one sheet to import.');
  return out;
}

function companyFromRow(raw, sheet, row, issue) {
  if (raw.email !== undefined && !extractEmail(raw.email)) {
    issue(sheet, row, 'invalid_email', `Company email "${clean(raw.email)}" is not a valid address, so it was left out`);
    delete raw.email;
  }
  if (raw.time_zone !== undefined && !isValidTimeZone(clean(raw.time_zone))) delete raw.time_zone;
  return companyColumns(raw);
}

function contactFromRow(raw, sheet, row, issue) {
  if (raw.email !== undefined && !extractEmail(raw.email)) {
    issue(sheet, row, 'invalid_email', `Email "${clean(raw.email)}" is not a valid address, so it was left out`);
    delete raw.email;
  }
  const doNotCall = /^(?:y|yes|true|1|x|dnc|do not call)$/i.test(clean(raw.do_not_call) || '');
  const cols = contactColumns(raw);
  if (!('role_type' in raw)) cols.role_type = roleType(null, cols.job_title, cols.last_name);
  if (doNotCall) Object.assign(cols, { do_not_call: 1, dnc_at: nowIso() });
  return cols;
}

/** Turns mapped rows into company and contact records, merging rows that repeat within the file. */
function buildRecords(upload, config) {
  const companies = new Map();
  const contacts = [];
  const contactKeys = new Map();
  const issues = [];
  const issue = (sheet, row, kind, text) => issues.push({ sheet, row, kind, text });
  let mergedRows = 0;

  for (const sheet of upload.sheets) {
    const { type, columns } = config.sheets[sheet.name];
    if (type === 'skip') continue;
    for (const record of sheet.records) {
      const row = record._row;
      const company = {};
      const contact = {};
      const extra = {};
      for (const header of sheet.headers) {
        const target = columns[header];
        const raw = record[header];
        if (!target || clean(raw) === null) continue;
        if (target === 'extra') extra[header] = cleanText(raw);
        else if (target.startsWith('company.')) company[target.slice(8)] = raw;
        else contact[target.slice(8)] = raw;
      }
      const companyCols = companyFromRow(company, sheet.name, row, issue);

      if (type === 'companies') {
        if (!companyCols.name) {
          issue(sheet.name, row, 'missing_name', 'No company name, so this row was skipped');
          continue;
        }
        const twin = companies.get(companyCols.name_key);
        if (twin) {
          Object.assign(twin.cols, blanksOnly(twin.cols, companyCols));
          for (const [key, value] of Object.entries(extra)) twin.extra[key] ??= value;
          mergedRows++;
        } else companies.set(companyCols.name_key, { key: companyCols.name_key, cols: companyCols, extra, sheet: sheet.name, row });
        continue;
      }

      const cols = contactFromRow(contact, sheet.name, row, issue);
      if (!cols.first_name && !cols.last_name) {
        issue(sheet.name, row, 'missing_name', 'No contact name, so this row was skipped');
        continue;
      }
      const { name = null, name_key: companyKey = null, ...companyFields } = companyCols;
      const key = [companyKey, cols.first_name?.toLowerCase(), cols.last_name?.toLowerCase(), cols.email].join('|');
      const twin = contactKeys.get(key);
      if (twin) {
        Object.assign(twin.cols, blanksOnly(twin.cols, cols));
        Object.assign(twin.companyCols, blanksOnly(twin.companyCols, companyFields));
        for (const [k, value] of Object.entries(extra)) twin.extra[k] ??= value;
        mergedRows++;
        continue;
      }
      const entry = { sheet: sheet.name, row, cols, extra, companyName: name, companyKey, companyCols: companyFields };
      contactKeys.set(key, entry);
      contacts.push(entry);
    }
  }
  return { companies, contacts, issues, mergedRows };
}

/** What to do with a row by default: a match is merged into the existing record, or skipped when the evidence is weak; it is never created again. */
const suggest = (match) => (!match ? 'create' : match.weak ? 'skip' : 'merge');

/** Links contacts to companies and finds the existing CRM records that each row duplicates (`filename` is the file being imported). */
function analyze(store, built, filename) {
  const issue = (sheet, row, kind, text) => built.issues.push({ sheet, row, kind, text });
  const companyByKey = (key) => store.get('SELECT id, name, hq_phone_e164 FROM companies WHERE name_key = ? ORDER BY id LIMIT 1', key);

  // Contact sheets can carry company columns (e.g. "Store Phone"): they fill gaps in the file's company rows.
  for (const c of built.contacts) {
    const fileCompany = c.companyKey && built.companies.get(c.companyKey);
    if (fileCompany) Object.assign(fileCompany.cols, blanksOnly(fileCompany.cols, c.companyCols));
  }

  for (const rec of built.companies.values()) {
    rec.match = matchCompany(store, rec.cols, filename);
    rec.suggested = suggest(rec.match);
    rec.ref = `company:${rec.key}`;
    if (!rec.cols.hq_phone_e164) issue(rec.sheet, rec.row, 'missing_phone', `${rec.cols.name}: no valid HQ phone number`);
  }

  for (const c of built.contacts) {
    const fileCompany = c.companyKey && built.companies.get(c.companyKey);
    const dbCompany = !fileCompany && c.companyKey ? companyByKey(c.companyKey) : null;
    c.inFile = Boolean(fileCompany);
    c.companyId = dbCompany?.id ?? null;
    c.ref = `contact:${c.sheet}:${c.row}`;
    c.match = matchContact(store, c.cols, fileCompany?.match?.id ?? dbCompany?.id ?? null, filename);
    c.suggested = suggest(c.match);
    const label = contactName(c.cols);
    // A contact that is already in the CRM doesn't need its company to be found: nothing is created for it.
    if (!fileCompany && !dbCompany && !c.match) {
      issue(c.sheet, c.row, 'unmatched_company', c.companyName
        ? `${label}: company "${c.companyName}" is not in the file or the CRM`
        : `${label}: no company name`);
    }
    const companyPhone = fileCompany?.cols.hq_phone_e164 || dbCompany?.hq_phone_e164 || c.companyCols.hq_phone_e164;
    if (!c.cols.mobile_e164 && !c.cols.direct_e164 && !companyPhone) {
      issue(c.sheet, c.row, 'missing_phone', `${label}: no phone number for the contact or the company`);
    }
  }
}

// Duplicates worth a look come first: weak matches, then rows matching other uploads, then rows already synced from this same file.
const urgency = (d) => (d.existing.weak ? 0 : d.existing.sameFile ? 2 : 1);

function report(built) {
  const companies = [...built.companies.values()];
  const kinds = ['missing_phone', 'invalid_email', 'unmatched_company', 'missing_name'];
  return {
    companies: { total: companies.length, new: companies.filter((c) => !c.match).length, duplicates: companies.filter((c) => c.match).length },
    contacts: {
      total: built.contacts.length,
      new: built.contacts.filter((c) => !c.match).length,
      duplicates: built.contacts.filter((c) => c.match).length,
      unmatched: built.contacts.filter((c) => !c.match && !c.inFile && !c.companyId).length,
    },
    mergedRows: built.mergedRows,
    issueCounts: Object.fromEntries(kinds.map((kind) => [kind, built.issues.filter((i) => i.kind === kind).length])),
    issues: built.issues.slice(0, 500),
    // `existing` is the record in the CRM: its id and label, the fields that match (with the shared values), whether the match
    // is weak, and where the record came from (file, date, call lists).
    duplicates: [
      ...companies.filter((c) => c.match).map((c) => ({
        ref: c.ref, kind: 'company', label: c.cols.name, sheet: c.sheet, row: c.row, existing: c.match, suggested: c.suggested,
      })),
      ...built.contacts.filter((c) => c.match).map((c) => ({
        ref: c.ref, kind: 'contact', label: `${contactName(c.cols)} · ${c.companyName || 'no company'}`, sheet: c.sheet, row: c.row, existing: c.match, suggested: c.suggested,
      })),
    ].sort((a, b) => urgency(a) - urgency(b)).slice(0, 1000),
  };
}

function commit(store, user, built, { decisions, ownerId, listName, createMissingCompanies, filename }) {
  return store.tx(() => {
    const result = { companies: { created: 0, merged: 0, skipped: 0 }, contacts: { created: 0, merged: 0, skipped: 0, unmatched: 0 }, list: null };
    const decide = (rec) => (rec.match ? (['skip', 'merge', 'create'].includes(decisions[rec.ref]) ? decisions[rec.ref] : rec.suggested) : 'create');
    // The existing record keeps a note of the later file that repeated it, what matched and what was done about it.
    const flag = (entity, rec, decision) => store.log(user.id, entity, rec.match.id, 'duplicate in import', {
      file: filename, sheet: rec.sheet, row: rec.row, matched: rec.match.matched.map((m) => m.label).join(', '), result: decision,
    });
    const companyIds = new Map();

    for (const rec of built.companies.values()) {
      const decision = decide(rec);
      if (rec.match) flag('company', rec, decision);
      if (decision === 'create') {
        companyIds.set(rec.key, createCompany(store, user.id, rec.cols, { ownerId, extra: rec.extra, action: 'imported', source: filename }));
        result.companies.created++;
        continue;
      }
      const existing = store.get('SELECT * FROM companies WHERE id = ?', rec.match.id);
      companyIds.set(rec.key, existing.id);
      if (decision === 'skip') {
        result.companies.skipped++;
        continue;
      }
      const cols = blanksOnly(existing, rec.cols);
      if (!existing.owner_id && ownerId) cols.owner_id = ownerId;
      updateCompany(store, user.id, existing, cols, { action: 'merged from import' });
      store.update('companies', existing.id, { extra: mergeExtra(existing.extra, rec.extra) });
      result.companies.merged++;
    }

    const listContactIds = [];
    for (const c of built.contacts) {
      const decision = decide(c);
      if (c.match) flag('contact', c, decision);
      // A contact merged into (or skipped for) a contact already in the CRM keeps that contact's company.
      const existingContact = c.match && decision !== 'create';
      let companyId = (c.companyKey && companyIds.get(c.companyKey)) || c.companyId;
      if (!companyId && !existingContact && createMissingCompanies && c.companyName) {
        companyId = createCompany(store, user.id, { ...c.companyCols, name: c.companyName, name_key: c.companyKey }, { ownerId, action: 'imported', source: filename });
        companyIds.set(c.companyKey, companyId);
        result.companies.created++;
      }
      if (!companyId && !existingContact) {
        result.contacts.unmatched++;
        continue;
      }
      if (companyId && !c.inFile && Object.keys(c.companyCols).length) {
        const company = store.get('SELECT * FROM companies WHERE id = ?', companyId);
        updateCompany(store, user.id, company, blanksOnly(company, c.companyCols), { action: 'merged from import' });
      }
      if (decision === 'create') {
        listContactIds.push(createContact(store, user.id, companyId, c.cols, { extra: c.extra, action: 'imported', source: filename }));
        result.contacts.created++;
      } else if (decision === 'merge') {
        const existing = store.get('SELECT * FROM contacts WHERE id = ?', c.match.id);
        const cols = blanksOnly(existing, c.cols);
        if (c.cols.do_not_call && !existing.do_not_call) Object.assign(cols, { do_not_call: 1, dnc_at: c.cols.dnc_at });
        updateContact(store, user.id, existing, cols, { action: 'merged from import' });
        store.update('contacts', existing.id, { extra: mergeExtra(existing.extra, c.extra) });
        listContactIds.push(existing.id);
        result.contacts.merged++;
      } else result.contacts.skipped++;
    }

    if (listName && listContactIds.length) {
      const listId = store.insert('lists', { name: listName, created_by: user.id, created_at: nowIso() });
      [...new Set(listContactIds)].forEach((id, i) => {
        store.run('INSERT OR IGNORE INTO list_contacts (list_id, contact_id, position) VALUES (?, ?, ?)', listId, id, i + 1);
      });
      store.log(user.id, 'list', listId, 'created', { name: listName, from: filename });
      result.list = { id: listId, name: listName };
    }
    store.log(user.id, 'import', null, 'completed', { file: filename, companies: result.companies, contacts: result.contacts });
    return result;
  });
}

/**
 * Imports a whole file in one step with its matching preset (or automatic mapping), accepting the suggested action
 * for every duplicate. Used by the command-line importer (scripts/import.js).
 */
export async function importWorkbook(store, user, buffer, filename, { ownerId = null, listName = null, createMissingCompanies = false } = {}) {
  const sheets = (await readWorkbook(buffer, filename)).map(prepareSheet).filter((sheet) => sheet.records.length);
  const upload = { filename, sheets };
  const preset = matchPreset(store, sheets);
  const built = buildRecords(upload, validConfig(upload, configFor(sheets, preset)));
  analyze(store, built, filename);
  const checked = report(built);
  const result = commit(store, user, built, { decisions: {}, ownerId, listName, createMissingCompanies, filename });
  return { preset: preset?.name ?? 'automatic matching', report: checked, result };
}

function getUpload(token) {
  const upload = uploads.get(String(token || ''));
  if (!upload) throw new HttpError(410, 'This upload has expired. Upload the file again.');
  return upload;
}

export function importRoutes(store) {
  const r = express.Router();
  r.use('/import', requireAdmin);

  r.post('/import/parse', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Choose a file to upload.');
    const filename = decodeURIComponent(req.get('X-Filename') || 'upload.xlsx').slice(0, 200);
    const sheets = (await readWorkbook(req.body, filename)).map(prepareSheet).filter((sheet) => sheet.records.length);
    if (!sheets.length) throw new HttpError(400, 'That file has no rows to import.');
    for (const [token, upload] of uploads) if (Date.now() - upload.at > UPLOAD_TTL_MS || uploads.size > 10) uploads.delete(token);
    const token = crypto.randomBytes(16).toString('hex');
    uploads.set(token, { filename, sheets, at: Date.now() });
    const preset = matchPreset(store, sheets);
    res.json({
      token,
      filename,
      preset: preset && { id: preset.id, name: preset.name },
      presets: presetList(store),
      sheets: sheets.map((s) => ({ name: s.name, headerRow: s.headerRow, headers: s.headers, rowCount: s.records.length, samples: s.records.slice(0, 3) })),
      config: configFor(sheets, preset),
    });
  });

  r.post('/import/apply-preset', (req, res) => {
    const upload = getUpload(req.body.token);
    res.json({ config: configFor(upload.sheets, req.body.presetId === 'auto' ? null : findPreset(store, req.body.presetId)) });
  });

  r.post('/import/check', (req, res) => {
    const upload = getUpload(req.body.token);
    const built = buildRecords(upload, validConfig(upload, req.body.config));
    analyze(store, built, upload.filename);
    res.json(report(built));
  });

  r.post('/import/commit', (req, res) => {
    const upload = getUpload(req.body.token);
    const built = buildRecords(upload, validConfig(upload, req.body.config));
    analyze(store, built, upload.filename);
    const ownerId = Number(req.body.ownerId) || null;
    if (ownerId && !store.get('SELECT 1 FROM users WHERE id = ? AND active = 1', ownerId)) throw new HttpError(400, 'Unknown user.');
    const result = commit(store, req.user, built, {
      decisions: req.body.decisions || {},
      ownerId,
      listName: clean(req.body.listName),
      createMissingCompanies: Boolean(req.body.createMissingCompanies),
      filename: upload.filename,
    });
    uploads.delete(req.body.token);
    res.json(result);
  });

  r.get('/import/presets', (req, res) => res.json({ presets: presetList(store) }));

  r.post('/import/presets', (req, res) => {
    const upload = getUpload(req.body.token);
    const name = clean(req.body.name);
    if (!name) throw new HttpError(400, 'Name the preset.');
    const { sheets } = validConfig(upload, req.body.config);
    const preset = { sheets: Object.fromEntries(Object.entries(sheets).filter(([, sheet]) => sheet.type !== 'skip')) };
    store.run(
      'INSERT INTO presets (name, config, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET config = excluded.config',
      name, JSON.stringify(preset), nowIso(),
    );
    store.log(req.user.id, 'preset', null, 'saved', { name });
    res.json({ presets: presetList(store) });
  });

  r.delete('/import/presets/:id', (req, res) => {
    const preset = store.get('SELECT * FROM presets WHERE id = ?', Number(req.params.id));
    if (preset) {
      store.run('DELETE FROM presets WHERE id = ?', preset.id);
      store.log(req.user.id, 'preset', null, 'deleted', { name: preset.name });
    }
    res.json({ presets: presetList(store) });
  });

  return r;
}

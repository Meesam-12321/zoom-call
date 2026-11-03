// Companies, contacts and pipeline deals: search and filters, record pages, edits and Excel exports.
import express from 'express';
import { requireAdmin } from './auth.js';
import { nowIso } from './db.js';
import { sendWorkbook } from './excel.js';
import { ROLE_TYPES, STAGES } from './fields.js';
import { clean, cleanText, guessTimeZone } from './phone.js';
import { activityFor, leadDetail, visibleCompany, visibleContact } from './queries.js';
import { HttpError, companyColumns, contactColumns, createCompany, createContact, updateCompany, updateContact } from './records.js';
import { parseDay, todayBounds, zonedParts } from './time.js';

const PAGE_SIZE = 50;
const STAGE_KEYS = new Set(STAGES.map(([key]) => key));
const STAGE_LABELS = Object.fromEntries(STAGES);
const ROLE_LABELS = Object.fromEntries(ROLE_TYPES);

/** "2026-11-03 15:46" in the business time zone (Excel exports). */
export function stamp(iso, tz) {
  if (!iso) return '';
  const p = zonedParts(new Date(iso), tz);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

function lastCalledFilter(value, column, tz) {
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  if (value === 'never') return [`${column} IS NULL`];
  if (value === 'today') return [`${column} >= ?`, todayBounds(tz).start.toISOString()];
  if (value === 'week') return [`${column} >= ?`, week];
  if (value === 'older') return [`${column} < ?`, week];
  return null;
}

function scopeFilters(user, f, add) {
  if (user.role !== 'admin') add('co.owner_id = ?', user.id);
  else if (f.owner === 'none') add('co.owner_id IS NULL');
  else if (f.owner) add('co.owner_id = ?', Number(f.owner));
  if (f.state) add('co.state = ?', f.state);
  if (f.stage) add('d.stage = ?', f.stage);
  if (f.priority) add('co.priority = ?', f.priority);
}

/** Contacts matching the Leads page filters (also used to add a filtered set to a call list). */
export function contactQuery(store, user, f = {}) {
  const where = [];
  const params = [];
  const add = (sql, ...values) => {
    where.push(sql);
    params.push(...values);
  };
  scopeFilters(user, f, add);
  const q = String(f.q || '').trim();
  if (q) {
    const like = `%${q}%`;
    const digits = q.replace(/\D/g, '');
    const phone = digits.length >= 3 ? `%${digits}%` : null;
    add(
      `(ct.first_name LIKE ? OR ct.last_name LIKE ? OR (coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '')) LIKE ?
        OR ct.email LIKE ? OR co.name LIKE ? OR co.city LIKE ? OR ct.mobile_e164 LIKE ? OR ct.direct_e164 LIKE ? OR co.hq_phone_e164 LIKE ?)`,
      like, like, like, like, like, like, phone, phone, phone,
    );
  }
  if (f.role) add('ct.role_type = ?', f.role);
  if (f.disposition === 'none') add('ct.last_disposition IS NULL');
  else if (f.disposition) add('ct.last_disposition = ?', f.disposition);
  const called = lastCalledFilter(f.lastCalled, 'ct.last_called_at', store.setting('business_tz'));
  if (called) add(...called);
  if (f.dnc === 'yes') add('(ct.do_not_call = 1 OR co.do_not_call = 1)');
  else if (f.dnc === 'no') add('ct.do_not_call = 0 AND co.do_not_call = 0');
  if (f.list) add('ct.id IN (SELECT contact_id FROM list_contacts WHERE list_id = ?)', Number(f.list));
  return {
    sql: `SELECT ct.*, co.name AS company_name, co.city, co.state, co.time_zone, co.priority, co.hq_phone, co.hq_phone_e164,
        co.do_not_call AS company_dnc, co.owner_id, u.name AS owner_name, d.stage
      FROM contacts ct
      JOIN companies co ON co.id = ct.company_id
      LEFT JOIN deals d ON d.company_id = co.id
      LEFT JOIN users u ON u.id = co.owner_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params,
  };
}

const CONTACT_SORTS = {
  company: 'co.name COLLATE NOCASE, ct.id',
  priority: 'co.priority IS NULL, co.priority, co.name COLLATE NOCASE, ct.id',
  name: 'ct.first_name COLLATE NOCASE, ct.last_name COLLATE NOCASE',
  last_called: 'ct.last_called_at IS NULL, ct.last_called_at DESC',
  attempts: 'ct.attempts DESC, co.name COLLATE NOCASE',
  newest: 'ct.id DESC',
};

export function companyQuery(store, user, f = {}) {
  const where = [];
  const params = [];
  const add = (sql, ...values) => {
    where.push(sql);
    params.push(...values);
  };
  scopeFilters(user, f, add);
  const q = String(f.q || '').trim();
  if (q) {
    const like = `%${q}%`;
    const digits = q.replace(/\D/g, '');
    add('(co.name LIKE ? OR co.city LIKE ? OR co.website LIKE ? OR co.email LIKE ? OR co.hq_phone_e164 LIKE ?)', like, like, like, like, digits.length >= 3 ? `%${digits}%` : null);
  }
  if (f.dnc === 'yes') add('co.do_not_call = 1');
  else if (f.dnc === 'no') add('co.do_not_call = 0');

  const outer = [];
  const outerParams = [];
  if (f.disposition === 'none') outer.push('x.last_disposition IS NULL');
  else if (f.disposition) {
    outer.push('x.last_disposition = ?');
    outerParams.push(f.disposition);
  }
  const called = lastCalledFilter(f.lastCalled, 'x.last_called_at', store.setting('business_tz'));
  if (called) {
    outer.push(called[0]);
    outerParams.push(...called.slice(1));
  }
  return {
    sql: `SELECT * FROM (
        SELECT co.*, u.name AS owner_name, d.stage, d.value AS deal_value,
          (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = co.id) AS contact_count,
          (SELECT MAX(cl.started_at) FROM calls cl WHERE cl.company_id = co.id) AS last_called_at,
          (SELECT cl.disposition FROM calls cl WHERE cl.company_id = co.id AND cl.disposition IS NOT NULL ORDER BY cl.started_at DESC LIMIT 1) AS last_disposition
        FROM companies co
        LEFT JOIN deals d ON d.company_id = co.id
        LEFT JOIN users u ON u.id = co.owner_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ) x ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}`,
    params: [...params, ...outerParams],
  };
}

const COMPANY_SORTS = {
  name: 'x.name COLLATE NOCASE',
  priority: 'x.priority IS NULL, x.priority, x.name COLLATE NOCASE',
  city: 'x.city COLLATE NOCASE, x.name COLLATE NOCASE',
  last_called: 'x.last_called_at IS NULL, x.last_called_at DESC',
  newest: 'x.id DESC',
};

function paged(store, { sql, params }, sorts, query) {
  const order = sorts[query.sort] || Object.values(sorts)[0];
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const total = store.get(`SELECT COUNT(*) AS n FROM (${sql})`, ...params).n;
  const rows = store.all(`${sql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return { rows, total, page, pageSize: PAGE_SIZE };
}

const dispositionLabels = (store) => Object.fromEntries(store.all('SELECT key, label FROM dispositions').map((d) => [d.key, d.label]));

function setDoNotCall(store, user, table, row, on) {
  if (!on && user.role !== 'admin') throw new HttpError(403, 'Only admins can remove a Do Not Call flag.');
  if (Boolean(row.do_not_call) === on) return;
  const time = nowIso();
  const entity = table === 'contacts' ? 'contact' : 'company';
  store.tx(() => {
    store.update(table, row.id, { do_not_call: on ? 1 : 0, dnc_at: on ? time : null, updated_at: time });
    if (on) store.run(`UPDATE tasks SET status = 'canceled', completed_at = ? WHERE status = 'open' AND ${entity}_id = ?`, time, row.id);
    store.log(user.id, entity, row.id, on ? 'do_not_call_set' : 'do_not_call_cleared');
  });
}

function dealQuery(user, f) {
  const where = [];
  const params = [];
  const add = (sql, ...values) => {
    where.push(sql);
    params.push(...values);
  };
  scopeFilters(user, { owner: f.owner }, add);
  if (f.q) add('co.name LIKE ?', `%${String(f.q).trim()}%`);
  return {
    sql: `SELECT d.*, co.name AS company_name, co.city, co.state, co.priority, co.owner_id, u.name AS owner_name,
        ct.id AS primary_contact_id, ct.first_name, ct.last_name, ct.job_title,
        (SELECT MAX(cl.started_at) FROM calls cl WHERE cl.company_id = co.id) AS last_called_at
      FROM deals d
      JOIN companies co ON co.id = d.company_id
      LEFT JOIN users u ON u.id = co.owner_id
      LEFT JOIN contacts ct ON ct.id = coalesce(d.contact_id,
        (SELECT c2.id FROM contacts c2 WHERE c2.company_id = co.id ORDER BY (c2.role_type = 'decision_maker') DESC, c2.id LIMIT 1))
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.updated_at DESC`,
    params,
  };
}

export function leadRoutes(store) {
  const r = express.Router();
  const tz = () => store.setting('business_tz');

  // ----- contacts
  r.get('/contacts', (req, res) => res.json(paged(store, contactQuery(store, req.user, req.query), CONTACT_SORTS, req.query)));

  r.get('/contacts/export', async (req, res) => {
    const { sql, params } = contactQuery(store, req.user, req.query);
    const rows = store.all(`${sql} ORDER BY ${CONTACT_SORTS[req.query.sort] || CONTACT_SORTS.company}`, ...params);
    const labels = dispositionLabels(store);
    await sendWorkbook(res, 'contacts', [{
      name: 'Contacts',
      columns: [
        ['first_name', 'First name'], ['middle_name', 'Middle name'], ['last_name', 'Last name'], ['job_title', 'Job title', 28],
        ['department', 'Department'], ['email', 'Email', 28], ['mobile', 'Mobile', 18], ['direct_line', 'Direct line', 18],
        ['linkedin_url', 'LinkedIn URL', 30], ['location', 'Location'], ['role', 'Role type'], ['dnc', 'Do Not Call'],
        ['notes', 'Notes', 50], ['company_name', 'Company name', 30], ['city', 'City'], ['state', 'State', 8],
        ['hq_phone', 'HQ phone', 18], ['stage', 'Stage'], ['attempts', 'Attempts', 10], ['last_called', 'Last called', 18],
        ['last_outcome', 'Last outcome', 24], ['owner_name', 'Owner'],
      ],
      rows: rows.map((c) => ({
        ...c,
        role: ROLE_LABELS[c.role_type] || c.role_type,
        dnc: c.do_not_call || c.company_dnc ? 'Yes' : '',
        stage: STAGE_LABELS[c.stage] || c.stage,
        last_called: stamp(c.last_called_at, tz()),
        last_outcome: labels[c.last_disposition] || c.last_disposition || '',
      })),
    }]);
  });

  r.get('/contacts/:id', (req, res) => {
    const contact = visibleContact(store, req.user, req.params.id);
    const company = store.get('SELECT * FROM companies WHERE id = ?', contact.company_id);
    const detail = leadDetail(store, company, contact);
    res.json({ ...detail, activity: activityFor(store, [['contact', contact.id], ['company', company.id], ['deal', detail.deal?.id ?? 0]]) });
  });

  r.post('/contacts', (req, res) => {
    const company = visibleCompany(store, req.user, req.body.company_id);
    const cols = contactColumns(req.body);
    if (!cols.first_name && !cols.last_name) throw new HttpError(400, 'Enter a first or last name.');
    res.json({ id: store.tx(() => createContact(store, req.user.id, company.id, cols)) });
  });

  r.patch('/contacts/:id', (req, res) => {
    const contact = visibleContact(store, req.user, req.params.id);
    const cols = contactColumns(req.body);
    if ('company_id' in req.body) cols.company_id = visibleCompany(store, req.user, req.body.company_id).id;
    const merged = { ...contact, ...cols };
    if (!merged.first_name && !merged.last_name) throw new HttpError(400, 'A contact needs a first or last name.');
    res.json({ changes: Object.keys(store.tx(() => updateContact(store, req.user.id, contact, cols))) });
  });

  r.post('/contacts/:id/dnc', (req, res) => {
    setDoNotCall(store, req.user, 'contacts', visibleContact(store, req.user, req.params.id), Boolean(req.body.on));
    res.json({ ok: true });
  });

  r.delete('/contacts/:id', requireAdmin, (req, res) => {
    const contact = visibleContact(store, req.user, req.params.id);
    store.tx(() => {
      store.run('DELETE FROM contacts WHERE id = ?', contact.id);
      store.log(req.user.id, 'contact', contact.id, 'deleted', { name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') });
    });
    res.json({ ok: true });
  });

  // ----- companies
  r.get('/companies', (req, res) => res.json(paged(store, companyQuery(store, req.user, req.query), COMPANY_SORTS, req.query)));

  r.get('/companies/search', (req, res) => {
    const admin = req.user.role === 'admin';
    res.json({
      rows: store.all(
        `SELECT id, name, city, state FROM companies WHERE name LIKE ? ${admin ? '' : 'AND owner_id = ?'} ORDER BY name COLLATE NOCASE LIMIT 20`,
        `%${String(req.query.q || '').trim()}%`,
        ...(admin ? [] : [req.user.id]),
      ),
    });
  });

  r.get('/companies/export', async (req, res) => {
    const { sql, params } = companyQuery(store, req.user, req.query);
    const rows = store.all(`${sql} ORDER BY ${COMPANY_SORTS[req.query.sort] || COMPANY_SORTS.name}`, ...params);
    const labels = dispositionLabels(store);
    await sendWorkbook(res, 'companies', [{
      name: 'Companies',
      columns: [
        ['name', 'Company name', 30], ['industry', 'Industry'], ['status', 'Status'], ['category', 'Category'],
        ['revenue_range', 'Revenue range'], ['employee_range', 'Employee range'], ['website', 'Website', 28], ['region', 'Region'],
        ['state', 'State', 8], ['city', 'City'], ['address', 'Address', 36], ['linkedin_url', 'LinkedIn URL', 28],
        ['hq_phone', 'HQ phone', 18], ['email', 'Email', 26], ['date_founded', 'Date founded'], ['about', 'About', 50],
        ['time_zone', 'Time zone', 20], ['lead_score', 'Lead score'], ['priority', 'Priority'], ['stage', 'Stage'],
        ['owner_name', 'Owner'], ['dnc', 'Do Not Call'], ['contact_count', 'Contacts', 10], ['last_called', 'Last called', 18],
        ['last_outcome', 'Last outcome', 24],
      ],
      rows: rows.map((c) => ({
        ...c,
        stage: STAGE_LABELS[c.stage] || c.stage,
        dnc: c.do_not_call ? 'Yes' : '',
        last_called: stamp(c.last_called_at, tz()),
        last_outcome: labels[c.last_disposition] || c.last_disposition || '',
      })),
    }]);
  });

  r.get('/companies/:id', (req, res) => {
    const company = visibleCompany(store, req.user, req.params.id);
    const detail = leadDetail(store, company);
    res.json({ ...detail, activity: activityFor(store, [['company', company.id], ['deal', detail.deal?.id ?? 0]]) });
  });

  r.post('/companies', (req, res) => {
    const cols = companyColumns(req.body);
    if (!cols.name) throw new HttpError(400, 'Company name is required.');
    const existing = store.get('SELECT id, name FROM companies WHERE name_key = ?', cols.name_key);
    if (existing) throw new HttpError(409, `A company called "${existing.name}" already exists.`, { existingId: existing.id });
    // Callers own what they create, so they can see it.
    const ownerId = req.user.role === 'admin' ? Number(req.body.owner_id) || null : req.user.id;
    res.json({ id: store.tx(() => createCompany(store, req.user.id, cols, { ownerId })) });
  });

  r.patch('/companies/:id', (req, res) => {
    const company = visibleCompany(store, req.user, req.params.id);
    const cols = companyColumns(req.body);
    if ('owner_id' in req.body) {
      if (req.user.role !== 'admin') throw new HttpError(403, 'Only admins can change the owner.');
      const ownerId = Number(req.body.owner_id) || null;
      if (ownerId && !store.get('SELECT 1 FROM users WHERE id = ?', ownerId)) throw new HttpError(400, 'Unknown user.');
      cols.owner_id = ownerId;
    }
    if (cols.name_key && cols.name_key !== company.name_key) {
      const other = store.get('SELECT name FROM companies WHERE name_key = ? AND id != ?', cols.name_key, company.id);
      if (other) throw new HttpError(409, `A company called "${other.name}" already exists.`);
    }
    // An emptied time zone means "work it out again from the state, city and phone".
    if ('time_zone' in cols && !cols.time_zone) {
      const next = { ...company, ...cols };
      cols.time_zone = guessTimeZone({ state: next.state, city: next.city, phone: next.hq_phone_e164 });
    }
    res.json({ changes: Object.keys(store.tx(() => updateCompany(store, req.user.id, company, cols))) });
  });

  r.post('/companies/:id/dnc', (req, res) => {
    setDoNotCall(store, req.user, 'companies', visibleCompany(store, req.user, req.params.id), Boolean(req.body.on));
    res.json({ ok: true });
  });

  r.post('/companies/assign', requireAdmin, (req, res) => {
    const ownerId = Number(req.body.owner_id) || null;
    if (ownerId && !store.get('SELECT 1 FROM users WHERE id = ?', ownerId)) throw new HttpError(400, 'Unknown user.');
    const ids = (req.body.ids || []).map(Number).filter(Boolean);
    store.tx(() => {
      for (const id of ids) {
        const company = store.get('SELECT * FROM companies WHERE id = ?', id);
        if (company) updateCompany(store, req.user.id, company, { owner_id: ownerId });
      }
    });
    res.json({ updated: ids.length });
  });

  r.delete('/companies/:id', requireAdmin, (req, res) => {
    const company = visibleCompany(store, req.user, req.params.id);
    store.tx(() => {
      store.run('DELETE FROM companies WHERE id = ?', company.id);
      store.log(req.user.id, 'company', company.id, 'deleted', { name: company.name });
    });
    res.json({ ok: true });
  });

  // ----- pipeline
  r.get('/deals', (req, res) => {
    const { sql, params } = dealQuery(req.user, req.query);
    res.json({ deals: store.all(sql, ...params) });
  });

  r.get('/deals/export', async (req, res) => {
    const { sql, params } = dealQuery(req.user, req.query);
    await sendWorkbook(res, 'pipeline', [{
      name: 'Pipeline',
      columns: [
        ['company_name', 'Company', 30], ['contact', 'Primary contact', 24], ['stage', 'Stage'], ['value', 'Value', 12],
        ['lost_reason', 'Lost reason', 20], ['next_step', 'Next step', 36], ['next_step_date', 'Next step date', 14],
        ['city', 'City'], ['state', 'State', 8], ['owner_name', 'Owner'], ['last_called', 'Last called', 18],
      ],
      rows: store.all(sql, ...params).map((d) => ({
        ...d,
        contact: [d.first_name, d.last_name].filter(Boolean).join(' '),
        stage: STAGE_LABELS[d.stage] || d.stage,
        last_called: stamp(d.last_called_at, tz()),
      })),
    }]);
  });

  r.patch('/deals/:id', (req, res) => {
    const deal = store.get('SELECT d.*, co.owner_id FROM deals d JOIN companies co ON co.id = d.company_id WHERE d.id = ?', Number(req.params.id));
    if (!deal || (req.user.role !== 'admin' && deal.owner_id !== req.user.id)) throw new HttpError(404, 'Pipeline entry not found.');
    const body = req.body;
    const cols = {};
    if ('stage' in body) {
      if (!STAGE_KEYS.has(body.stage)) throw new HttpError(400, 'Unknown pipeline stage.');
      cols.stage = body.stage;
      if (body.stage === 'lost') {
        const reason = clean(body.lost_reason) || (deal.stage === 'lost' ? deal.lost_reason : null);
        if (!reason) throw new HttpError(400, 'Choose a lost reason.', { needsLostReason: true });
        cols.lost_reason = reason;
      }
    } else if ('lost_reason' in body) cols.lost_reason = clean(body.lost_reason);
    if ('value' in body) {
      const value = body.value === '' || body.value === null ? null : Number(body.value);
      if (value !== null && !Number.isFinite(value)) throw new HttpError(400, 'The value must be a number.');
      cols.value = value;
    }
    if ('next_step' in body) cols.next_step = cleanText(body.next_step);
    if ('next_step_date' in body) {
      const date = clean(body.next_step_date);
      if (date && !parseDay(date)) throw new HttpError(400, 'Pick a valid next step date.');
      cols.next_step_date = date;
    }
    if ('contact_id' in body) {
      const contactId = Number(body.contact_id) || null;
      if (contactId && !store.get('SELECT 1 FROM contacts WHERE id = ? AND company_id = ?', contactId, deal.company_id)) {
        throw new HttpError(400, 'The primary contact must work at this company.');
      }
      cols.contact_id = contactId;
    }
    const changes = Object.fromEntries(Object.entries(cols).filter(([key, value]) => (deal[key] ?? null) !== value).map(([key, value]) => [key, [deal[key] ?? null, value]]));
    if (Object.keys(changes).length) {
      store.tx(() => {
        store.update('deals', deal.id, { ...cols, updated_at: nowIso() });
        store.log(req.user.id, 'deal', deal.id, changes.stage ? 'stage_changed' : 'updated', changes);
      });
    }
    res.json({ deal: store.get('SELECT * FROM deals WHERE id = ?', deal.id) });
  });

  r.delete('/invalid-numbers/:e164', (req, res) => {
    const e164 = String(req.params.e164);
    if (store.run('DELETE FROM invalid_numbers WHERE e164 = ?', e164).changes) store.log(req.user.id, 'number', null, 'marked_valid', { phone: e164 });
    res.json({ ok: true });
  });

  return r;
}

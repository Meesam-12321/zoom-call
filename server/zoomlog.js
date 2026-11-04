// Data for the Zoom call log page (every Zoom Phone call in a period, by day) and an on-demand Zoom sync.
import express from 'express';
import { DEFAULT_MIN_CONNECTED_SECONDS, buildReport } from './report.js';
import { syncZoom } from './sync.js';
import { toE164 } from './phone.js';
import { isValidTimeZone, resolveRange } from './time.js';
import { HISTORY_DAYS, fetchCallHistory } from './zoom.js';

const CACHE_MS = 60_000;

// Zoom reports numbers as E.164 (+18135551234), which must match exactly: a misdial such as +162395667100 is not
// the lead at +12395667100. Anything else (e.g. a number with spaces) is read the way the importer reads numbers.
const e164 = (number) => (/^\+\d{8,15}$/.test(number || '') ? number : toE164(number));

/** CRM leads (that the user can see) whose phone numbers match the given Zoom numbers: number → { href, name }. */
function leadsByNumber(store, user, numbers) {
  const list = [...new Set(numbers.map(e164).filter(Boolean))];
  const leads = new Map();
  if (!list.length) return leads;
  const marks = list.map(() => '?').join(', ');
  const scope = user.role === 'admin' ? '' : 'AND co.owner_id = ?';
  const owner = user.role === 'admin' ? [] : [user.id];
  const contacts = store.all(
    `SELECT ct.id, ct.first_name, ct.last_name, ct.mobile_e164, ct.direct_e164, co.name AS company
     FROM contacts ct JOIN companies co ON co.id = ct.company_id
     WHERE (ct.mobile_e164 IN (${marks}) OR ct.direct_e164 IN (${marks})) ${scope}`,
    ...list, ...list, ...owner,
  );
  for (const c of contacts) {
    const name = `${[c.first_name, c.last_name].filter(Boolean).join(' ')} · ${c.company}`;
    for (const number of [c.mobile_e164, c.direct_e164]) if (number && !leads.has(number)) leads.set(number, { href: `#/contact/${c.id}`, name });
  }
  for (const co of store.all(`SELECT co.id, co.name, co.hq_phone_e164 FROM companies co WHERE co.hq_phone_e164 IN (${marks}) ${scope}`, ...list, ...owner)) {
    if (!leads.has(co.hq_phone_e164)) leads.set(co.hq_phone_e164, { href: `#/company/${co.id}`, name: co.name });
  }
  return leads;
}

export function zoomLogRoutes(store) {
  const r = express.Router();
  const cache = new Map();
  // Outgoing calls that end within this many seconds of being answered count as not connected (see report.js).
  const minSetting = Number(process.env.MIN_CONNECTED_SECONDS || NaN);
  const minConnectedSeconds = minSetting >= 0 ? minSetting : DEFAULT_MIN_CONNECTED_SECONDS;

  r.get('/zoom/calls', async (req, res) => {
    const tz = isValidTimeZone(req.query.tz) ? req.query.tz : 'UTC';
    const { preset, from, to, date } = req.query;
    const range = resolveRange({ preset, from, to, date, tz });

    const now = Date.now();
    const earliest = now - HISTORY_DAYS * 86_400_000;
    const key = `${range.from.toISOString()}|${range.to.toISOString()}`;
    let entry = cache.get(key);
    if (!entry || req.query.refresh === '1' || now - entry.at > CACHE_MS) {
      const start = Math.max(range.from.getTime(), earliest);
      const end = Math.min(range.to.getTime(), now);
      entry = { at: now, items: end > start ? await fetchCallHistory(new Date(start), new Date(end)) : [] };
      cache.set(key, entry);
      if (cache.size > 50) cache.delete(cache.keys().next().value);
    }

    const report = buildReport(entry.items, range, { minConnectedSeconds });
    const leads = leadsByNumber(store, req.user, report.calls.map((call) => call.number));
    res.json({
      ...report,
      calls: report.calls.map((call) => ({ ...call, lead: leads.get(e164(call.number)) || null })),
      fetchedAt: new Date(entry.at).toISOString(),
      beforeZoomHistory: range.from.getTime() < earliest,
    });
  });

  // Lets pages pull fresh Zoom data (durations, answered) without waiting for the next minute's sync.
  let lastSync = 0;
  r.post('/zoom/sync', async (req, res) => {
    if (!process.env.ZOOM_ACCOUNT_ID || Date.now() - lastSync < 20_000) return res.json({ linked: 0 });
    lastSync = Date.now();
    res.json({ linked: await syncZoom(store, { hours: 6 }) });
  });

  return r;
}

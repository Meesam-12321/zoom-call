import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import ExcelJS from 'exceljs';
import { createApp } from '../server/app.js';
import { nextStage } from '../server/calling.js';
import { Store } from '../server/db.js';
import { clean, extractEmail, guessTimeZone, stateCode, toE164 } from '../server/phone.js';
import { linkZoomCalls, saveZoomCalls } from '../server/sync.js';
import { resolveRange, zonedDateTime } from '../server/time.js';

test('phone numbers, emails and "NA" placeholders from spreadsheets', () => {
  assert.equal(toE164('800-228-2627 (800-228-BOBS)'), '+18002282627');
  assert.equal(toE164('(813) 359-9566 (Valrico); (863) 273-2308 (Lakeland)'), '+18133599566');
  assert.equal(toE164('+1 (863) 875-4840'), '+18638754840');
  assert.equal(toE164('NA'), null);
  assert.equal(clean('Not Found (email form only)'), null);
  assert.equal(extractEmail('Info@WolfeFlooring.com (generic)'), 'info@wolfeflooring.com');
  assert.equal(stateCode('Florida'), 'FL');
});

test('lead time zones: the Florida panhandle is Central, El Paso is Mountain', () => {
  assert.equal(guessTimeZone({ state: 'FL', city: 'Tampa', phone: '+18139332334' }), 'America/New_York');
  assert.equal(guessTimeZone({ state: 'FL', city: 'Panama City Beach' }), 'America/Chicago');
  assert.equal(guessTimeZone({ state: 'TX', phone: '+19155550100' }), 'America/Denver');
  assert.equal(guessTimeZone({ phone: '+13525550100' }), 'America/New_York', 'no state: Florida area code');
});

test("callback times are entered in the lead's local time", () => {
  assert.equal(zonedDateTime('2026-11-04T10:30', 'America/New_York').toISOString(), '2026-11-04T15:30:00.000Z');
  assert.equal(zonedDateTime('2026-07-04T10:30', 'America/New_York').toISOString(), '2026-07-04T14:30:00.000Z');
  assert.equal(zonedDateTime('soon', 'UTC'), null);
  const week = resolveRange({ preset: 'this_week', tz: 'UTC', now: new Date('2026-11-05T12:00:00Z') });
  assert.equal(week.firstDay, '2026-11-02', 'weeks start on Monday');
});

test('outcomes only move leads forward through the pipeline', () => {
  const d = (action, connected) => ({ action, connected });
  assert.equal(nextStage('new', d('retry', 0)), 'attempted');
  assert.equal(nextStage('attempted', d('retry', 1)), 'connected');
  assert.equal(nextStage('connected', d('positive', 1), true), 'meeting_booked');
  assert.equal(nextStage('meeting_booked', d('positive', 1), false), 'meeting_booked');
  assert.equal(nextStage('proposal_sent', d('lost', 1)), 'lost');
  assert.equal(nextStage('won', d('lost', 1)), 'won', 'won is final');
});

// ---------- end to end through the API

let store;
let server;
let base;

before(async () => {
  store = new Store(':memory:');
  server = createApp(store, { setupCode: '123456' }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

function as() {
  let cookie = '';
  return async (path, { method = 'GET', body, raw, headers = {}, expect = 200 } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'X-CRM': '1', cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, expect, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  };
}

// HV-style workbook: title rows above the headers, "NA" placeholders, contacts linked by company name.
async function hvWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const companies = workbook.addWorksheet('Company Information');
  companies.getCell('C2').value = 'Main file only contains information about the stores';
  companies.getRow(4).values = [null, 'No', 'Company Name', 'Location/Province/State', 'City', 'Company HQ Number', 'Store Email', 'Priority', 'Owners / Key People'];
  companies.addRow([null, 1, "Bob's Carpet & Flooring", 'Florida', 'Clearwater', '800-228-2627 (800-228-BOBS)', 'NA', 'A', 'Ashlie Butler (President)']);
  companies.addRow([null, 2, 'Panhandle Floors', 'Florida', 'Pensacola', 'NA', 'not-an-email', 'B', 'NA']);
  const contacts = workbook.addWorksheet('Contact Information');
  contacts.getCell('B2').value = 'Research & Outreach Tracking';
  contacts.getRow(5).values = [null, 'No.', 'First Name', 'Last Name', 'Job Title', 'Company Name', 'Email', 'Mobile', 'Store Phone', 'Research / First-Call Note'];
  contacts.addRow([null, 1, 'Ashlie', 'Butler', 'President', "Bob's Carpet & Flooring", 'NA', 'NA', '800-228-2627', 'Priority A.']);
  contacts.addRow([null, 2, 'Store Team', 'NA', 'Ask for the owner', 'Panhandle Floors', 'NA', 'NA', 'NA', 'Call the store']);
  contacts.addRow([null, 3, 'Ghost', 'Person', 'Owner', 'Unknown Co', 'ghost@example.com', '(813) 555-0199', 'NA', 'NA']);
  const summary = workbook.addWorksheet('State Summary');
  summary.getRow(2).values = [null, 'Region', 'Stores'];
  summary.addRow([null, 'Tampa Bay', 22]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('import, calling, outcomes, visibility, Zoom matching and the dashboard', async () => {
  const admin = as();
  const caller = as();
  await admin('/auth/setup', { method: 'POST', body: { name: 'Admin', email: 'admin@example.com', password: 'admin-pass-1' } });
  const { id: callerId } = await admin('/users', { method: 'POST', body: { name: 'Caller', email: 'caller@example.com', password: 'caller-pass-1', role: 'caller' } });

  // Import: HV preset, header rows found under the title rows, validation report.
  const file = await hvWorkbook();
  const upload = { method: 'POST', raw: file, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'leads.xlsx' } };
  const parsed = await admin('/import/parse', upload);
  assert.equal(parsed.preset.id, 'hv');
  assert.deepEqual(parsed.sheets.map((s) => [s.name, s.headerRow]), [['Company Information', 4], ['Contact Information', 5], ['State Summary', 2]]);
  assert.equal(parsed.config.sheets['State Summary'].type, 'skip');
  assert.equal(parsed.config.sheets['Contact Information'].columns['Store Phone'], 'company.hq_phone');

  const check = await admin('/import/check', { method: 'POST', body: { token: parsed.token, config: parsed.config } });
  assert.deepEqual([check.companies.total, check.contacts.total, check.contacts.unmatched], [2, 3, 1]);
  assert.equal(check.issueCounts.invalid_email, 1);
  assert.equal(check.issueCounts.unmatched_company, 1);
  assert.equal(check.issueCounts.missing_phone, 2, 'Panhandle Floors and its contact have no number');

  const result = await admin('/import/commit', { method: 'POST', body: { token: parsed.token, config: parsed.config, ownerId: callerId, listName: 'Batch 1' } });
  assert.deepEqual(result.companies, { created: 2, merged: 0, skipped: 0 });
  assert.deepEqual(result.contacts, { created: 2, merged: 0, skipped: 0, unmatched: 1 });
  assert.equal(result.list.name, 'Batch 1');

  const again = await admin('/import/parse', upload);
  const recheck = await admin('/import/check', { method: 'POST', body: { token: again.token, config: again.config } });
  assert.deepEqual([recheck.companies.duplicates, recheck.contacts.duplicates], [2, 2], 're-importing finds every row');

  // The caller sees the leads assigned to them, with derived roles and time zones.
  await caller('/auth/login', { method: 'POST', body: { email: 'Caller@Example.com', password: 'caller-pass-1' } });
  const { rows } = await caller('/contacts');
  const ashlie = rows.find((c) => c.first_name === 'Ashlie');
  const storeTeam = rows.find((c) => c.first_name === 'Store Team');
  assert.equal(rows.length, 2);
  assert.equal(ashlie.role_type, 'decision_maker');
  assert.equal(ashlie.time_zone, 'America/New_York');
  assert.equal(storeTeam.time_zone, 'America/Chicago');

  // Calling: one call at a time, and every call needs an outcome.
  const first = await caller('/calls/start', { method: 'POST', body: { contactId: ashlie.id, phone: ashlie.hq_phone_e164 } });
  assert.equal(first.dialUrl, 'zoomphonecall://+18002282627');
  await caller('/calls/start', { method: 'POST', body: { contactId: ashlie.id, phone: ashlie.hq_phone_e164 }, expect: 409 });
  await caller(`/calls/${first.call.id}/outcome`, { method: 'POST', body: { disposition: 'callback' }, expect: 400 });
  const callback = await caller(`/calls/${first.call.id}/outcome`, { method: 'POST', body: { disposition: 'callback', callbackAt: '2026-12-01T10:30' } });
  assert.equal(callback.task.due_at, '2026-12-01T15:30:00.000Z');
  assert.equal(callback.task.is_callback, 1);
  assert.deepEqual([callback.stage.from, callback.stage.to], ['new', 'connected']);

  const second = await caller('/calls/start', { method: 'POST', body: { contactId: ashlie.id, phone: ashlie.hq_phone_e164 } });
  const positive = await caller(`/calls/${second.call.id}/outcome`, { method: 'POST', body: { disposition: 'positive', meetingBooked: true, notes: 'Demo Tuesday' } });
  assert.equal(positive.stage.to, 'meeting_booked');
  assert.equal(positive.task.type, 'email');
  assert.equal(store.get("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open' AND is_callback = 1").n, 0, 'the call closed the open callback');

  await caller('/calls/start', { method: 'POST', body: { contactId: storeTeam.id, phone: '+18505550100' }, expect: 400 });

  // Zoom's record of the call is matched by number and time.
  const call = store.get('SELECT * FROM calls WHERE id = ?', second.call.id);
  const t = Date.parse(call.started_at);
  saveZoomCalls(store, [{
    call_history_uuid: 'zoom-1', direction: 'outbound', callee_did_number: call.phone_e164, call_result: 'connected',
    start_time: new Date(t + 2000).toISOString(), answer_time: new Date(t + 9000).toISOString(), end_time: new Date(t + 104_000).toISOString(), duration: 95,
  }]);
  assert.equal(linkZoomCalls(store), 1);
  assert.deepEqual({ ...store.get('SELECT duration, ring_time, answered FROM calls WHERE id = ?', call.id) }, { duration: 95, ring_time: 7, answered: 1 });

  const { summary } = await caller('/analytics?range=today');
  assert.deepEqual([summary.totalCalls, summary.connected, summary.conversations, summary.meetings], [2, 2, 1, 1]);

  // Do Not Call on the store's main line blocks the company and marks the lead lost.
  const third = await caller('/calls/start', { method: 'POST', body: { contactId: ashlie.id, phone: ashlie.hq_phone_e164 } });
  const dnc = await caller(`/calls/${third.call.id}/outcome`, { method: 'POST', body: { disposition: 'do_not_call' } });
  assert.equal(dnc.stage.to, 'lost');
  await caller('/calls/start', { method: 'POST', body: { contactId: ashlie.id, phone: ashlie.hq_phone_e164 }, expect: 403 });
  await caller(`/contacts/${ashlie.id}/dnc`, { method: 'POST', body: { on: false }, expect: 403 });

  // Callers cannot see other people's leads or admin pages; other sites cannot post.
  const { id: adminCompany } = await admin('/companies', { method: 'POST', body: { name: 'Admin Only Floors', hq_phone: '(407) 555-0100' } });
  await caller(`/companies/${adminCompany}`, { expect: 404 });
  await caller('/import/presets', { expect: 403 });
  await caller('/calls/start', { method: 'POST', body: {}, headers: { 'X-CRM': '' }, expect: 403 });
  assert.ok(store.get('SELECT COUNT(*) AS n FROM activity').n > 10, 'changes are logged');
});

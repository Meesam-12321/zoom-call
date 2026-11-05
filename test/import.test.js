import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import ExcelJS from 'exceljs';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';
import { importWorkbook } from '../server/importer.js';
import { createCompany } from '../server/records.js';

// Importing a list today and another file next week: rows that repeat a lead are flagged, never added twice.

let store;
let server;
let base;
let cookie = '';

before(async () => {
  store = new Store(':memory:');
  server = createApp(store).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

async function admin(url, { method = 'GET', body, raw, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'X-CRM': '1', cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, `${method} ${url}: ${JSON.stringify(data)}`);
  return data;
}

/** HV-style workbook (Company Information + Contact Information sheets, headers on row 1). */
async function hvWorkbook({ companies = [], contacts = [] }) {
  const workbook = new ExcelJS.Workbook();
  const companySheet = workbook.addWorksheet('Company Information');
  companySheet.addRow(['Company Name', 'City', 'Company HQ Number']);
  companies.forEach((row) => companySheet.addRow(row));
  const contactSheet = workbook.addWorksheet('Contact Information');
  contactSheet.addRow(['First Name', 'Last Name', 'Company Name', 'Email', 'Mobile', 'Direct']);
  contacts.forEach((row) => contactSheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** A single contacts sheet whose company names must be matched against the CRM. */
async function contactsOnlyWorkbook(contacts) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Leads');
  sheet.addRow(['First Name', 'Last Name', 'Company Name', 'Email']);
  contacts.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const parse = (buffer, filename) => admin('/import/parse', { method: 'POST', raw: buffer, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': filename } });
const check = (parsed) => admin('/import/check', { method: 'POST', body: { token: parsed.token, config: parsed.config } });
const commit = (parsed, extra = {}) => admin('/import/commit', { method: 'POST', body: { token: parsed.token, config: parsed.config, ...extra } });
const count = (table) => store.get(`SELECT COUNT(*) AS n FROM ${table}`).n;
const found = (report, label) => report.duplicates.find((d) => d.label.startsWith(label));
const fieldLabels = (duplicate) => duplicate.existing.matched.map((m) => m.label);

const WEEK_1 = {
  companies: [
    ["Bob's Carpet & Flooring", 'Clearwater', '(813) 555-0101'],
    ['Sunshine Floors', 'Tampa', '(727) 555-0102'],
  ],
  contacts: [
    ['Ashlie', 'Butler', "Bob's Carpet & Flooring", 'ashlie@bobs.com', '(813) 555-0111', null],
    ['Dan', 'Cole', 'Sunshine Floors', 'dan@sunshine.com', null, '(727) 555-0122'],
    ['Maria', 'Ruiz', 'Sunshine Floors', null, null, null],
    // Two different people who share one mailbox (this happens in real lead lists).
    ['Paul', 'Gollner', 'Sunshine Floors', 'shared@sunshine.com', null, null],
    ['Sara', 'Freeborn', 'Sunshine Floors', 'shared@sunshine.com', null, null],
  ],
};

const WEEK_2 = {
  companies: [
    ["Bob's Carpet & Flooring Inc.", 'Clearwater', '(813) 555-0101'], // same company: name and phone
    ['Bobs Flooring Outlet', 'Largo', '(813) 555-0101'], // only the phone number matches
    ['Palm Tile', 'Jacksonville', '(904) 555-0103'], // new
  ],
  contacts: [
    ['Ashlie', 'Butler', "Bob's Carpet & Flooring Inc.", 'ASHLIE@bobs.com', '(813) 555-0111', null],
    ['Reception', 'Desk', "Bob's Carpet & Flooring Inc.", 'ashlie@bobs.com', null, null], // her email, but someone else
    ['Daniel', 'Cole', 'Sunshine Floors', null, null, '(727) 555-0122'], // Dan's direct line
    ['Maria', 'Ruiz', 'Sunshine Floors', null, null, null],
    ['Sara', 'Freeborn', 'Sunshine Floors', 'shared@sunshine.com', null, null],
    ['Tom', 'Lee', 'Palm Tile', 'tom@palm.com', null, null], // new
  ],
};

test('a second upload flags overlapping rows, names the matching fields and the file they came from', async () => {
  await admin('/auth/setup', { method: 'POST', body: { name: 'Admin', email: 'admin@example.com', password: 'admin-pass-1' } });

  // Week 1: nothing to compare with yet.
  const first = await parse(await hvWorkbook(WEEK_1), 'week1.xlsx');
  const firstCheck = await check(first);
  assert.equal(firstCheck.duplicates.length, 0);
  const created = await commit(first, { listName: 'Week 1' });
  assert.deepEqual([created.companies.created, created.contacts.created], [2, 5]);
  assert.deepEqual(
    [store.get("SELECT source FROM companies WHERE name = 'Sunshine Floors'").source, store.get("SELECT source FROM contacts WHERE first_name = 'Ashlie'").source],
    ['week1.xlsx', 'week1.xlsx'],
    'records remember the file they were imported from',
  );

  // Week 2: overlapping contacts.
  const second = await parse(await hvWorkbook(WEEK_2), 'week2.xlsx');
  const report = await check(second);
  assert.deepEqual([report.companies.total, report.companies.duplicates, report.companies.new], [3, 2, 1]);
  assert.deepEqual([report.contacts.total, report.contacts.duplicates, report.contacts.new], [6, 5, 1]);

  // Which fields match, with the shared values.
  const ashlie = found(report, 'Ashlie Butler');
  assert.deepEqual(fieldLabels(ashlie), ['Email', 'Phone number', 'Name and company']);
  assert.deepEqual(ashlie.existing.matched.map((m) => m.value), ['ashlie@bobs.com', '+1 (813) 555-0111', 'Ashlie Butler']);
  assert.equal(ashlie.existing.label, "Ashlie Butler · Bob's Carpet & Flooring");
  assert.deepEqual([ashlie.sheet, ashlie.row], ['Contact Information', 2]);
  assert.deepEqual(fieldLabels(found(report, 'Daniel Cole')), ['Phone number'], 'Dan and Daniel share a direct line');
  assert.deepEqual(fieldLabels(found(report, 'Maria Ruiz')), ['Name and company']);
  assert.deepEqual(fieldLabels(found(report, "Bob's Carpet & Flooring Inc.")), ['Company name', 'HQ phone number']);
  assert.deepEqual(fieldLabels(found(report, 'Bobs Flooring Outlet')), ['HQ phone number']);

  // Where the existing records came from: the file, when, and the call list.
  assert.equal(ashlie.existing.file, 'week1.xlsx');
  assert.deepEqual(ashlie.existing.lists, ['Week 1']);
  assert.equal(ashlie.existing.sameFile, false);
  assert.ok(Date.parse(ashlie.existing.at) > 0);
  assert.deepEqual(found(report, "Bob's Carpet & Flooring Inc.").existing.lists, ['Week 1'], 'a company shows the lists of its contacts');

  // A mailbox two people share: the row is matched to the person with the same name, not the first one with that email.
  const sara = found(report, 'Sara Freeborn');
  assert.equal(sara.existing.label, 'Sara Freeborn · Sunshine Floors');
  assert.deepEqual(fieldLabels(sara), ['Email', 'Name and company']);

  // Weak matches (only an email or number, under a different name) are listed first and are not merged by default.
  const reception = found(report, 'Reception Desk');
  assert.deepEqual([reception.existing.weak, reception.suggested], [true, 'skip']);
  assert.deepEqual([found(report, 'Bobs Flooring Outlet').existing.weak, found(report, 'Bobs Flooring Outlet').suggested], [true, 'skip']);
  assert.deepEqual(report.duplicates.slice(0, 2).map((d) => d.existing.weak), [true, true]);
  assert.equal(ashlie.suggested, 'merge');
  assert.ok(report.duplicates.every((d) => d.suggested !== 'create'), 'nothing flagged is created by default');

  // Syncing creates no second profile for any flagged row.
  const result = await commit(second, { listName: 'Week 2' });
  assert.deepEqual(result.companies, { created: 1, merged: 1, skipped: 1 });
  assert.deepEqual(result.contacts, { created: 1, merged: 4, skipped: 1, unmatched: 0 });
  assert.deepEqual([count('companies'), count('contacts')], [3, 6]);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM contacts WHERE first_name = 'Ashlie'").n, 1);
  assert.equal(store.get("SELECT source FROM contacts WHERE first_name = 'Tom'").source, 'week2.xlsx');
  assert.equal(
    store.get("SELECT COUNT(*) AS n FROM list_contacts lc JOIN lists l ON l.id = lc.list_id WHERE l.name = 'Week 2'").n,
    5,
    'the merged leads are on the new call list too',
  );

  // The existing record keeps a note of the later file that repeated it.
  const ashlieId = store.get("SELECT id FROM contacts WHERE first_name = 'Ashlie'").id;
  const note = store.get("SELECT details FROM activity WHERE entity = 'contact' AND entity_id = ? AND action = 'duplicate in import' ORDER BY id", ashlieId);
  assert.deepEqual(JSON.parse(note.details), { file: 'week2.xlsx', sheet: 'Contact Information', row: 2, matched: 'Email, Phone number, Name and company', result: 'merge' });

  // Syncing the same file again: its own leads are recognised as coming from this file.
  const again = await check(await parse(await hvWorkbook(WEEK_2), 'week2.xlsx'));
  assert.equal(found(again, 'Tom Lee').existing.sameFile, true);
  assert.equal(found(again, 'Palm Tile').existing.sameFile, true);
  assert.equal(found(again, 'Ashlie Butler').existing.sameFile, false, 'still a week 1 lead');
});

test('a flagged row is only created again when someone chooses "create anyway"', async () => {
  const before = count('contacts');
  const parsed = await parse(await hvWorkbook(WEEK_2), 'week2.xlsx');
  const report = await check(parsed);
  const reception = found(report, 'Reception Desk');
  const result = await commit(parsed, { decisions: { [reception.ref]: 'create' } });
  assert.equal(result.contacts.created, 1);
  assert.equal(count('contacts'), before + 1);

  // Ashlie's history lists every later row that repeated her and what was done with it: week 2 (merged her, skipped the
  // shared-mailbox row) and the second sync of week 2 (merged her again, created the shared-mailbox row anyway).
  const ashlieId = store.get("SELECT id FROM contacts WHERE first_name = 'Ashlie' ORDER BY id").id;
  const results = store
    .all("SELECT details FROM activity WHERE entity = 'contact' AND entity_id = ? AND action = 'duplicate in import' ORDER BY id", ashlieId)
    .map((entry) => JSON.parse(entry.details).result);
  assert.deepEqual(results, ['merge', 'skip', 'merge', 'create']);
});

test('a contact already in the CRM does not create a company just because its company name is spelled differently', async () => {
  const companies = count('companies');
  const parsed = await parse(await contactsOnlyWorkbook([['Ashlie', 'Butler', "Bob's Carpets", 'ashlie@bobs.com']]), 'contacts-only.xlsx');
  const report = await check(parsed);
  assert.equal(report.issueCounts.unmatched_company, 0);
  assert.equal(report.contacts.unmatched, 0);
  assert.deepEqual(fieldLabels(found(report, 'Ashlie Butler')), ['Email']);
  const result = await commit(parsed, { createMissingCompanies: true });
  assert.deepEqual([result.companies.created, result.contacts.created, result.contacts.merged], [0, 0, 1]);
  assert.equal(count('companies'), companies);
});

test('records imported before sources were tracked get their file from the import log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-source-'));
  const file = path.join(dir, 'old.db');
  try {
    const old = new Store(file);
    await importWorkbook(old, { id: null }, await hvWorkbook(WEEK_1), 'week1.xlsx', { listName: 'Week 1' });
    await importWorkbook(old, { id: null }, await hvWorkbook({ companies: [['Palm Tile', 'Jacksonville', '(904) 555-0103']] }), 'later.xlsx');
    createCompany(old, null, { name: 'Typed In Floors', name_key: 'typed in floors' });
    // Make it look like a database from before the source column existed.
    old.db.exec('ALTER TABLE companies DROP COLUMN source; ALTER TABLE contacts DROP COLUMN source;');
    old.db.close();

    const upgraded = new Store(file);
    const source = (table, where) => upgraded.get(`SELECT source FROM ${table} WHERE ${where}`).source;
    assert.equal(source('contacts', "first_name = 'Ashlie'"), 'week1.xlsx');
    assert.equal(source('companies', "name = 'Sunshine Floors'"), 'week1.xlsx');
    assert.equal(source('companies', "name = 'Palm Tile'"), 'later.xlsx', 'each record gets the file of its own import');
    assert.equal(source('companies', "name = 'Typed In Floors'"), null, 'records typed in by hand have no source file');
    upgraded.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Command-line import into the CRM database, with the same rules as the Import page.
// Usage: npm run import -- <file.xlsx|file.csv> [--list "Call list name"] [--owner caller@example.com]
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../server/db.js';
import { importWorkbook } from '../server/importer.js';

const root = path.resolve(import.meta.dirname, '..');
const options = {};
let file = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) options[args[i].slice(2)] = args[++i];
  else file = args[i];
}
if (!file || !fs.existsSync(file)) {
  console.error('Usage: npm run import -- <file.xlsx|file.csv> [--list "Call list name"] [--owner caller@example.com]');
  process.exit(1);
}
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const store = new Store(process.env.DB_FILE || path.join(root, 'data', 'crm.db'));
let ownerId = null;
if (options.owner) {
  ownerId = store.get('SELECT id FROM users WHERE email = ? AND active = 1', options.owner)?.id;
  if (!ownerId) {
    console.error(`There is no active user with the email ${options.owner}.`);
    process.exit(1);
  }
}

// Logged as "System" in the activity log, since nobody signed in did it.
const { preset, report, result } = await importWorkbook(store, { id: null }, fs.readFileSync(file), path.basename(file), {
  ownerId,
  listName: options.list || null,
});
const { companies, contacts, list } = result;
console.log(`Mapping: ${preset}`);
console.log(`Companies: ${companies.created} created, ${companies.merged} merged, ${companies.skipped} skipped`);
console.log(`Contacts: ${contacts.created} created, ${contacts.merged} merged, ${contacts.skipped} skipped, ${contacts.unmatched} without a company`);

// Rows that repeat a lead already in the CRM are flagged, not added twice: merged into it, or skipped when only a shared
// email or number matches under a different name. Each line says what matched and where the existing lead came from.
const flagged = report.duplicates;
if (flagged.length) {
  console.log(`Potential duplicates: ${report.companies.duplicates + report.contacts.duplicates} (none were added twice)`);
  for (const d of flagged.slice(0, 20)) {
    const matched = d.existing.matched.map((m) => `${m.label}: ${m.value}`).join(', ');
    const from = d.existing.file ? `from ${d.existing.file}` : 'added by hand';
    console.log(`  ${d.kind} "${d.label}" matches "${d.existing.label}" on ${matched} (${from}): ${d.suggested === 'skip' ? 'skipped' : 'merged'}`);
  }
  if (flagged.length > 20) console.log(`  ...and ${flagged.length - 20} more`);
}
const problems = Object.entries(report.issueCounts).filter(([, n]) => n).map(([kind, n]) => `${n} ${kind.replace(/_/g, ' ')}`);
console.log(`Problems: ${problems.length ? problems.join(', ') : 'none'}`);
if (list) console.log(`Call list: "${list.name}"`);

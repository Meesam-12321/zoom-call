// SQLite storage (node:sqlite, built into Node 22): schema, default data and small query helpers.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_DISPOSITIONS } from './fields.js';

export const nowIso = () => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'caller',
  target_calls INTEGER NOT NULL DEFAULT 0,
  target_conversations INTEGER NOT NULL DEFAULT 0,
  target_meetings INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  department TEXT, industry TEXT, status TEXT, category TEXT, revenue_range TEXT, revenue TEXT, employee_range TEXT,
  website TEXT, region TEXT, state TEXT, city TEXT, area TEXT, address TEXT, linkedin_url TEXT, hq_phone TEXT,
  hq_phone_e164 TEXT, email TEXT, date_founded TEXT, about TEXT, opening_hours TEXT, facebook_url TEXT,
  instagram_url TEXT, evidence_notes TEXT, key_people TEXT, contacts_listed TEXT, source_urls TEXT,
  time_zone TEXT, lead_score INTEGER, priority TEXT,
  owner_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  do_not_call INTEGER NOT NULL DEFAULT 0,
  dnc_at TEXT,
  extra TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS companies_name_key ON companies (name_key);
CREATE INDEX IF NOT EXISTS companies_phone ON companies (hq_phone_e164);
CREATE INDEX IF NOT EXISTS companies_owner ON companies (owner_id);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  first_name TEXT, middle_name TEXT, last_name TEXT, job_title TEXT, department TEXT, management_level TEXT,
  email TEXT, employment_status TEXT, mobile TEXT, mobile_e164 TEXT, direct_line TEXT, direct_e164 TEXT,
  linkedin_url TEXT, current_address TEXT, location TEXT, email_type TEXT, source_urls TEXT,
  role_type TEXT NOT NULL DEFAULT 'other',
  do_not_call INTEGER NOT NULL DEFAULT 0,
  dnc_at TEXT,
  notes TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_called_at TEXT,
  last_disposition TEXT,
  extra TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contacts_company ON contacts (company_id);
CREATE INDEX IF NOT EXISTS contacts_email ON contacts (email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS contacts_mobile ON contacts (mobile_e164);
CREATE INDEX IF NOT EXISTS contacts_direct ON contacts (direct_e164);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL UNIQUE REFERENCES companies (id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts (id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'new',
  value REAL,
  lost_reason TEXT,
  next_step TEXT,
  next_step_date TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS list_contacts (
  list_id INTEGER NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (list_id, contact_id)
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts (id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies (id) ON DELETE CASCADE,
  list_id INTEGER REFERENCES lists (id) ON DELETE SET NULL,
  phone_e164 TEXT NOT NULL,
  started_at TEXT NOT NULL,
  disposition TEXT,
  notes TEXT,
  meeting_booked INTEGER NOT NULL DEFAULT 0,
  outcome_at TEXT,
  zoom_uuid TEXT UNIQUE,
  zoom_result TEXT,
  answered INTEGER,
  duration INTEGER,
  ring_time INTEGER,
  ended_at TEXT,
  recording_status TEXT
);
CREATE INDEX IF NOT EXISTS calls_started ON calls (started_at);
CREATE INDEX IF NOT EXISTS calls_user ON calls (user_id, disposition);
CREATE INDEX IF NOT EXISTS calls_contact ON calls (contact_id);
CREATE INDEX IF NOT EXISTS calls_company ON calls (company_id);
CREATE TABLE IF NOT EXISTS zoom_calls (
  uuid TEXT PRIMARY KEY,
  direction TEXT,
  caller_number TEXT,
  callee_number TEXT,
  caller_email TEXT,
  start_time TEXT,
  answer_time TEXT,
  end_time TEXT,
  duration INTEGER,
  result TEXT,
  recording_status TEXT
);
CREATE INDEX IF NOT EXISTS zoom_calls_callee ON zoom_calls (callee_number, start_time);
CREATE TABLE IF NOT EXISTS invalid_numbers (
  e164 TEXT PRIMARY KEY,
  flagged_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  flagged_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'call',
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,
  contact_id INTEGER REFERENCES contacts (id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies (id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  source TEXT NOT NULL DEFAULT 'manual',
  call_id INTEGER REFERENCES calls (id) ON DELETE SET NULL,
  is_callback INTEGER NOT NULL DEFAULT 0,
  reminded_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS tasks_open ON tasks (status, user_id, due_at);
CREATE INDEX IF NOT EXISTS tasks_contact ON tasks (contact_id);
CREATE INDEX IF NOT EXISTS tasks_company ON tasks (company_id);
CREATE TABLE IF NOT EXISTS dispositions (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  connected INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL,
  retry_days INTEGER,
  task_title TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS presets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_entity ON activity (entity, entity_id);
`;

// Columns added after the first release; databases created before then get them on start.
const ADDED_COLUMNS = {
  companies: ['department', 'revenue', 'area', 'opening_hours', 'facebook_url', 'instagram_url', 'evidence_notes', 'key_people', 'contacts_listed', 'source_urls'],
  contacts: ['management_level', 'employment_status', 'current_address', 'email_type', 'source_urls'],
};

export const DEFAULT_SETTINGS = {
  max_attempts: 8,
  conversation_seconds: 60,
  business_tz: 'America/New_York',
  dial_scheme: 'zoomphonecall',
  script: [
    'Opener: Hi {first_name}, this is {caller} from Veloq. Did I catch you at an OK time?',
    '',
    'Gatekeeper: Who looks after the showroom and sales side at {company}?',
    '',
    '(Admins can edit this script in Settings.)',
  ].join('\n'),
  // State code → 'notice' (a "this call may be recorded" notice must play) or 'off' (no recording). Missing = off.
  recording_consent: {},
};

// node:sqlite only binds null, numbers, bigints, strings and bytes.
const bindable = (value) => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value);

export class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
      const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
      for (const column of columns) if (!existing.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS companies_area ON companies (area)');
    this.statements = new Map();
    this.depth = 0;
    if (!this.get('SELECT 1 FROM dispositions LIMIT 1')) {
      DEFAULT_DISPOSITIONS.forEach((d, i) => this.insert('dispositions', { ...d, position: i }));
    }
  }

  statement(sql) {
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  all(sql, ...params) {
    return this.statement(sql).all(...params.map(bindable));
  }

  get(sql, ...params) {
    return this.statement(sql).get(...params.map(bindable));
  }

  run(sql, ...params) {
    return this.statement(sql).run(...params.map(bindable));
  }

  /** Inserts a row; `fields` keys are column names chosen by our code, never by the user. */
  insert(table, fields) {
    const keys = Object.keys(fields);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    return Number(this.run(sql, ...keys.map((key) => fields[key])).lastInsertRowid);
  }

  update(table, id, fields) {
    const keys = Object.keys(fields);
    if (keys.length) this.run(`UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`, ...keys.map((key) => fields[key]), id);
  }

  /** Runs fn in a transaction; nested calls join the outer one. */
  tx(fn) {
    if (this.depth) return fn();
    this.db.exec('BEGIN');
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }

  setting(key) {
    const row = this.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? JSON.parse(row.value) : structuredClone(DEFAULT_SETTINGS[key]);
  }

  setSetting(key, value) {
    this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  /** Activity log: who changed which record, how, and when. */
  log(userId, entity, entityId, action, details = null) {
    this.insert('activity', { user_id: userId, entity, entity_id: entityId, action, details: details && JSON.stringify(details), created_at: nowIso() });
  }
}

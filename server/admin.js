// App metadata for the browser, plus admin-only settings: users and targets, call outcomes, script and the activity log.
import express from 'express';
import { checkPassword, hashPassword, requireAdmin } from './auth.js';
import { DEFAULT_SETTINGS, nowIso } from './db.js';
import { mailAddress } from './gmail.js';
import {
  COMPANY_FIELDS, CONTACT_FIELDS, DISPOSITION_ACTIONS, LOST_REASONS, ROLE_TYPES, STAGES, TASK_TYPES,
} from './fields.js';
import { STATES, clean } from './phone.js';
import { HttpError } from './records.js';
import { isValidTimeZone } from './time.js';
import { configured as zoomConfigured } from './zoom.js';

const ACTION_KEYS = new Set(DISPOSITION_ACTIONS.map(([key]) => key));
const int = (value, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

// Each setting's validator returns the value to store, or null if it is invalid.
const SETTING_RULES = {
  max_attempts: (v) => int(v, 1, 100),
  conversation_seconds: (v) => int(v, 0, 3600),
  business_tz: (v) => (isValidTimeZone(v) ? v : null),
  dial_scheme: (v) => (['zoomphonecall', 'tel', 'callto'].includes(v) ? v : null),
  script: (v) => (typeof v === 'string' && v.length <= 20_000 ? v : null),
  recording_consent: (v) => {
    if (!v || typeof v !== 'object') return null;
    const out = {};
    for (const [state, mode] of Object.entries(v)) if (STATES[state] && (mode === 'notice' || mode === 'off')) out[state] = mode;
    return out;
  },
};

const settingsOf = (store) => Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((key) => [key, store.setting(key)]));
const publicUser = ({ password_hash: _, ...user }) => user;

function userFields(body, { creating }) {
  const cols = {};
  if ('name' in body || creating) {
    cols.name = clean(body.name);
    if (!cols.name) throw new HttpError(400, 'Enter a name.');
  }
  if ('email' in body || creating) {
    cols.email = String(body.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(cols.email)) throw new HttpError(400, 'Enter a valid email address.');
  }
  if ('role' in body || creating) {
    cols.role = body.role === 'admin' ? 'admin' : 'caller';
  }
  for (const key of ['target_calls', 'target_conversations', 'target_meetings']) {
    if (key in body) cols[key] = int(body[key] || 0, 0, 10_000) ?? 0;
  }
  if ('active' in body) cols.active = body.active ? 1 : 0;
  if (body.password || creating) {
    checkPassword(body.password);
    cols.password_hash = hashPassword(body.password);
  }
  return cols;
}

export function adminRoutes(store) {
  const r = express.Router();

  r.get('/meta', (req, res) => {
    const settings = settingsOf(store);
    res.json({
      user: req.user,
      users: store.all('SELECT id, name, role, active FROM users ORDER BY active DESC, name COLLATE NOCASE'),
      dispositions: store.all('SELECT * FROM dispositions ORDER BY position, label'),
      stages: STAGES,
      lostReasons: LOST_REASONS,
      taskTypes: TASK_TYPES,
      roleTypes: ROLE_TYPES,
      dispositionActions: DISPOSITION_ACTIONS,
      companyFields: COMPANY_FIELDS,
      contactFields: CONTACT_FIELDS,
      states: STATES,
      // The "Florida Region" values in use, for filters.
      areas: store.all('SELECT DISTINCT area FROM companies WHERE area IS NOT NULL ORDER BY area').map((row) => row.area),
      unassignedLeads: store.get('SELECT COUNT(*) AS n FROM companies WHERE owner_id IS NULL').n,
      settings,
      zoomConfigured: zoomConfigured(),
      mailAddress: req.user.role === 'admin' ? mailAddress() : null,
    });
  });

  r.get('/users', requireAdmin, (req, res) => {
    res.json({ users: store.all('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE').map(publicUser) });
  });

  r.post('/users', requireAdmin, (req, res) => {
    const cols = userFields(req.body, { creating: true });
    if (store.get('SELECT 1 FROM users WHERE email = ?', cols.email)) throw new HttpError(409, 'Someone already uses that email address.');
    const assigned = store.tx(() => {
      const id = store.insert('users', { ...cols, created_at: nowIso() });
      store.log(req.user.id, 'user', id, 'created', { name: cols.name, role: cols.role });
      // A new caller can take over every lead nobody owns yet, so they see them straight away.
      if (!req.body.assign_unassigned) return { id, count: 0 };
      const count = Number(store.run('UPDATE companies SET owner_id = ?, updated_at = ? WHERE owner_id IS NULL', id, nowIso()).changes);
      if (count) store.log(req.user.id, 'user', id, 'leads_assigned', { count });
      return { id, count };
    });
    res.json({ id: assigned.id, assigned: assigned.count });
  });

  r.patch('/users/:id', requireAdmin, (req, res) => {
    const user = store.get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    if (!user) throw new HttpError(404, 'User not found.');
    const cols = userFields(req.body, { creating: false });
    if (user.id === req.user.id && (cols.role === 'caller' || cols.active === 0)) {
      throw new HttpError(400, 'You cannot remove your own admin access.');
    }
    if (cols.email && store.get('SELECT 1 FROM users WHERE email = ? AND id != ?', cols.email, user.id)) {
      throw new HttpError(409, 'Someone already uses that email address.');
    }
    store.tx(() => {
      store.update('users', user.id, cols);
      if (cols.password_hash || cols.active === 0) store.run('DELETE FROM sessions WHERE user_id = ?', user.id);
      const changed = Object.keys(cols).filter((key) => key !== 'password_hash' && cols[key] !== user[key]);
      store.log(req.user.id, 'user', user.id, 'updated', { fields: changed, ...(cols.password_hash && { password: 'reset' }) });
    });
    res.json({ ok: true });
  });

  r.get('/settings', requireAdmin, (req, res) => res.json({ settings: settingsOf(store) }));

  r.patch('/settings', requireAdmin, (req, res) => {
    const changed = [];
    store.tx(() => {
      for (const [key, value] of Object.entries(req.body)) {
        const rule = SETTING_RULES[key];
        if (!rule) continue;
        const valid = rule(value);
        if (valid === null) throw new HttpError(400, `Invalid value for ${key.replace(/_/g, ' ')}.`);
        store.setSetting(key, valid);
        changed.push(key);
      }
      if (changed.length) store.log(req.user.id, 'settings', null, 'updated', { fields: changed });
    });
    res.json({ settings: settingsOf(store) });
  });

  // Replaces the outcome list. Outcomes already used on calls are never deleted, only switched off.
  r.put('/dispositions', requireAdmin, (req, res) => {
    const items = Array.isArray(req.body.dispositions) ? req.body.dispositions : [];
    if (!items.some((d) => d.active !== false && d.active !== 0)) throw new HttpError(400, 'Keep at least one outcome switched on.');
    store.tx(() => {
      const kept = new Set();
      items.forEach((item, position) => {
        const label = clean(item.label);
        if (!label) throw new HttpError(400, 'Every outcome needs a name.');
        if (!ACTION_KEYS.has(item.action)) throw new HttpError(400, `Choose what "${label}" does.`);
        const retryDays = ['retry', 'nurture'].includes(item.action) ? int(item.retry_days, 0, 365) : null;
        if (['retry', 'nurture'].includes(item.action) && retryDays === null) throw new HttpError(400, `Enter the number of days for "${label}".`);
        const fields = {
          label,
          connected: item.connected ? 1 : 0,
          action: item.action,
          retry_days: retryDays,
          task_title: clean(item.task_title),
          position,
          active: item.active === false || item.active === 0 ? 0 : 1,
        };
        let key = item.key && store.get('SELECT key FROM dispositions WHERE key = ?', item.key)?.key;
        if (key) store.run(`UPDATE dispositions SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE key = ?`, ...Object.values(fields), key);
        else {
          const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'outcome';
          key = base;
          for (let n = 2; store.get('SELECT 1 FROM dispositions WHERE key = ?', key); n++) key = `${base}_${n}`;
          store.insert('dispositions', { key, ...fields });
        }
        kept.add(key);
      });
      for (const { key } of store.all('SELECT key FROM dispositions')) {
        if (!kept.has(key)) store.run('UPDATE dispositions SET active = 0 WHERE key = ?', key);
      }
      store.log(req.user.id, 'settings', null, 'outcomes_updated', { count: items.length });
    });
    res.json({ dispositions: store.all('SELECT * FROM dispositions ORDER BY position, label') });
  });

  r.get('/activity', requireAdmin, (req, res) => {
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = store.all(
      'SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.id < ? ORDER BY a.id DESC LIMIT 100',
      before,
    );
    res.json({ activity: rows.map((row) => ({ ...row, details: row.details ? JSON.parse(row.details) : null })) });
  });

  return r;
}

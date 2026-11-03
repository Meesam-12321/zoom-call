// Accounts, password hashing (scrypt) and cookie sessions. The first admin is created on first run.
import crypto from 'node:crypto';
import express from 'express';
import { nowIso } from './db.js';
import { HttpError } from './records.js';

const COOKIE = 'crm_session';
const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(String(password), salt, 64).toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password ?? ''), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function checkPassword(password) {
  if (String(password || '').length < MIN_PASSWORD) throw new HttpError(400, `Passwords need at least ${MIN_PASSWORD} characters.`);
}

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function startSession(store, req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  store.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  store.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', tokenHash(token), userId, Date.now() + SESSION_DAYS * 86_400_000);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86_400_000, path: '/' });
}

/** Sets req.user from the session cookie (if any). */
export function loadUser(store) {
  return (req, res, next) => {
    const token = readCookie(req, COOKIE);
    const row = token && store.get(
      'SELECT u.id, u.name, u.email, u.role, u.active, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      tokenHash(token),
    );
    if (row?.active && row.expires_at > Date.now()) req.user = { id: row.id, name: row.name, email: row.email, role: row.role };
    next();
  };
}

export const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in.' }));
export const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Only admins can do this.' }));

// Requests from this computer itself (not through a proxy) may create the first admin without the setup code.
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];

// At most 10 failed sign-ins per address and email every 15 minutes.
const failures = new Map();
function tooManyFailures(key) {
  const entry = failures.get(key);
  return entry && entry.until > Date.now() && entry.count >= 10;
}
function recordFailure(key) {
  const entry = failures.get(key);
  if (!entry || entry.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + 15 * 60_000 });
  else entry.count++;
}

export function authRoutes(store, { setupCode }) {
  const router = express.Router();
  const hasUsers = () => Boolean(store.get('SELECT 1 FROM users LIMIT 1'));

  router.get('/state', (req, res) => {
    res.json({ user: req.user || null, needsSetup: !hasUsers(), setupCodeRequired: !isLocal(req) });
  });

  router.post('/setup', (req, res) => {
    if (hasUsers()) throw new HttpError(409, 'The admin account already exists. Please sign in.');
    if (!isLocal(req) && String(req.body.setupCode || '').trim() !== setupCode) {
      throw new HttpError(403, 'That setup code is not right. It is printed in the terminal where the server runs.');
    }
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim();
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter your name and a valid email address.');
    checkPassword(req.body.password);
    const id = store.insert('users', { name, email, password_hash: hashPassword(req.body.password), role: 'admin', created_at: nowIso() });
    store.log(id, 'user', id, 'created', { name, role: 'admin', via: 'first-run setup' });
    startSession(store, req, res, id);
    res.json({ ok: true });
  });

  router.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const key = `${req.ip}|${email}`;
    if (tooManyFailures(key)) throw new HttpError(429, 'Too many failed sign-ins. Try again in 15 minutes.');
    const user = store.get('SELECT * FROM users WHERE email = ? AND active = 1', email);
    if (!user || !verifyPassword(req.body.password, user.password_hash)) {
      recordFailure(key);
      throw new HttpError(401, 'Wrong email or password.');
    }
    failures.delete(key);
    startSession(store, req, res, user.id);
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) store.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.post('/password', requireUser, (req, res) => {
    const user = store.get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(req.body.current, user.password_hash)) throw new HttpError(400, 'Your current password is not right.');
    checkPassword(req.body.password);
    store.update('users', user.id, { password_hash: hashPassword(req.body.password) });
    // Sign out every other device.
    store.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', user.id, tokenHash(readCookie(req, COOKIE) || ''));
    store.log(user.id, 'user', user.id, 'password_changed');
    res.json({ ok: true });
  });

  return router;
}

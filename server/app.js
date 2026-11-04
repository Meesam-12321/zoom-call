// The Express app: security headers, static files, sign-in, and the CRM's JSON API.
import path from 'node:path';
import express from 'express';
import { adminRoutes } from './admin.js';
import { analyticsRoutes } from './analytics.js';
import { authRoutes, loadUser, requireUser } from './auth.js';
import { callingRoutes } from './calling.js';
import * as gmail from './gmail.js';
import { importRoutes } from './importer.js';
import { leadRoutes } from './leads.js';
import { mailRoutes } from './mail.js';
import { HttpError } from './records.js';
import { ZoomError } from './zoom.js';
import { zoomLogRoutes } from './zoomlog.js';

const publicDir = path.resolve(import.meta.dirname, '..', 'public');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

export function createApp(store, { setupCode = null, mail = gmail } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });
  // The Zoom call log used to be its own page; it now lives inside the CRM.
  app.get('/calls.html', (req, res) => res.redirect(301, '/#/zoom'));
  app.use(express.static(publicDir));

  app.use('/api', express.json({ limit: '2mb' }), loadUser(store), (req, res, next) => {
    // Other websites cannot add custom headers to requests, so this blocks cross-site form posts.
    if (req.method !== 'GET' && req.get('X-CRM') !== '1') return res.status(403).json({ error: 'Missing request header.' });
    next();
  });
  app.use('/api/auth', authRoutes(store, { setupCode }));
  app.use(
    '/api',
    requireUser,
    leadRoutes(store),
    callingRoutes(store),
    adminRoutes(store),
    importRoutes(store),
    analyticsRoutes(store),
    zoomLogRoutes(store),
    mailRoutes(store, mail),
  );
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large (25 MB at most).' });
    const status = err instanceof HttpError ? err.status : err instanceof RangeError ? 400 : err instanceof ZoomError || err instanceof gmail.MailError ? 502 : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Unexpected server error. Check the terminal for details.' : err.message, ...err.data });
  });

  return app;
}

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fetchCallHistory, HISTORY_DAYS, ZoomError } from './zoom.js';
import { buildReport, DEFAULT_MIN_CONNECTED_SECONDS } from './report.js';
import { isValidTimeZone, resolveRange } from './time.js';

const root = path.resolve(import.meta.dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env.PORT) || 4000;
// Call data is private: only listen on this computer unless HOST is set explicitly.
const HOST = process.env.HOST || '127.0.0.1';
// Outgoing calls that end within this many seconds of being answered count as not connected (see report.js).
const minSetting = Number(process.env.MIN_CONNECTED_SECONDS || NaN);
const MIN_CONNECTED_SECONDS = minSetting >= 0 ? minSetting : DEFAULT_MIN_CONNECTED_SECONDS;
const CACHE_MS = 60_000;
const cache = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(root, 'public')));

app.get('/api/calls', async (req, res) => {
  const tz = isValidTimeZone(req.query.tz) ? req.query.tz : 'UTC';
  const { preset, from, to, date } = req.query;
  const range = resolveRange({ preset, from, to, date, tz });

  const now = Date.now();
  const earliest = now - HISTORY_DAYS * 86_400_000;
  const key = `${range.from.toISOString()}|${range.to.toISOString()}`;
  let entry = cache.get(key);
  if (!entry || req.query.refresh === '1' || now - entry.at > CACHE_MS) {
    const from = Math.max(range.from.getTime(), earliest);
    const to = Math.min(range.to.getTime(), now);
    entry = { at: now, items: to > from ? await fetchCallHistory(new Date(from), new Date(to)) : [] };
    cache.set(key, entry);
    if (cache.size > 50) cache.delete(cache.keys().next().value);
  }

  res.json({
    ...buildReport(entry.items, range, { minConnectedSeconds: MIN_CONNECTED_SECONDS }),
    fetchedAt: new Date(entry.at).toISOString(),
    beforeZoomHistory: range.from.getTime() < earliest,
  });
});

app.use((err, req, res, next) => {
  const status = err instanceof RangeError ? 400 : err instanceof ZoomError ? 502 : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Unexpected server error — check the terminal for details.' : err.message });
});

// Express 5 hands startup errors (e.g. port already in use) to this callback instead of throwing.
app.listen(PORT, HOST, (error) => {
  if (error) throw error;
  console.log(`Zoom call logs → http://localhost:${PORT}`);
});

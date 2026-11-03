// Data for the Zoom call log page (every Zoom Phone call in a period, by day) and an on-demand Zoom sync.
import express from 'express';
import { DEFAULT_MIN_CONNECTED_SECONDS, buildReport } from './report.js';
import { syncZoom } from './sync.js';
import { isValidTimeZone, resolveRange } from './time.js';
import { HISTORY_DAYS, fetchCallHistory } from './zoom.js';

const CACHE_MS = 60_000;

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

    res.json({
      ...buildReport(entry.items, range, { minConnectedSeconds }),
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

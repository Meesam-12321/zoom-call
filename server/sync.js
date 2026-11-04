// Pulls Zoom Phone call history every minute and attaches each record (duration, answered, Zoom call ID)
// to the CRM call that dialed it, matched by number and start time.
import { ANSWERED } from './report.js';
import { fetchCallHistory } from './zoom.js';

const MINUTE = 60_000;
const iso = (value) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

/** The columns of a CRM call that come from its Zoom record. */
export function zoomCallFields(zoom) {
  const answered = Date.parse(zoom.answer_time);
  return {
    zoom_uuid: zoom.uuid,
    zoom_result: zoom.result,
    answered: ANSWERED.has(zoom.result) ? 1 : 0,
    duration: zoom.duration,
    ring_time: Number.isNaN(answered) ? null : Math.round((answered - Date.parse(zoom.start_time)) / 1000),
    ended_at: zoom.end_time,
    recording_status: zoom.recording_status,
  };
}

export function saveZoomCalls(store, items) {
  for (const item of items) {
    const uuid = item.call_history_uuid || item.id;
    if (!uuid) continue;
    store.run(
      `INSERT INTO zoom_calls (uuid, direction, caller_number, callee_number, caller_email, start_time, answer_time, end_time, duration, result, recording_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (uuid) DO UPDATE SET answer_time = excluded.answer_time, end_time = excluded.end_time,
         duration = excluded.duration, result = excluded.result, recording_status = excluded.recording_status`,
      uuid, item.direction, item.caller_did_number || item.caller_ext_number, item.callee_did_number || item.callee_ext_number,
      item.caller_email, iso(item.start_time), iso(item.answer_time), iso(item.end_time), Number(item.duration) || 0,
      item.call_result, item.recording_status,
    );
  }
}

/**
 * Links CRM calls from the last 3 days to the nearest unclaimed outbound Zoom call to the same number that started
 * between a minute before the CRM call and 10 minutes after it, but before the next CRM call to that number.
 * A call recorded by hand is saved after it happened, so for those the Zoom record can be up to two hours older.
 */
export function linkZoomCalls(store) {
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  let linked = 0;
  for (const call of store.all('SELECT id, phone_e164, started_at, outcome_at FROM calls WHERE zoom_uuid IS NULL AND started_at >= ? ORDER BY started_at', since)) {
    const started = Date.parse(call.started_at);
    const nextCall = store.get('SELECT MIN(started_at) AS at FROM calls WHERE phone_e164 = ? AND started_at > ?', call.phone_e164, call.started_at).at;
    const latest = Math.min(started + 10 * MINUTE, nextCall ? Date.parse(nextCall) - 1 : Infinity);
    const byHand = call.outcome_at && Date.parse(call.outcome_at) - started < 5000;
    const zoom = store.get(
      `SELECT * FROM zoom_calls z
       WHERE z.direction = 'outbound' AND z.callee_number = ? AND z.start_time BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.zoom_uuid = z.uuid)
       ORDER BY abs(julianday(z.start_time) - julianday(?)) LIMIT 1`,
      call.phone_e164,
      new Date(started - (byHand ? 120 : 1) * MINUTE).toISOString(),
      new Date(latest).toISOString(),
      call.started_at,
    );
    if (!zoom) continue;
    store.update('calls', call.id, zoomCallFields(zoom));
    linked++;
  }
  return linked;
}

export async function syncZoom(store, { hours = 6, fetch = fetchCallHistory } = {}) {
  const to = new Date();
  saveZoomCalls(store, await fetch(new Date(to.getTime() - hours * 3_600_000), to));
  return linkZoomCalls(store);
}

/** Backfills the last week on start, then syncs the last 6 hours every minute. Errors are logged once each. */
export function startZoomSync(store) {
  if (!process.env.ZOOM_ACCOUNT_ID) {
    console.log('Zoom sync is off: there are no Zoom credentials in .env.');
    return;
  }
  let running = false;
  let lastError = '';
  const tick = async (hours) => {
    if (running) return;
    running = true;
    try {
      await syncZoom(store, { hours });
      lastError = '';
    } catch (error) {
      if (error.message !== lastError) console.error(`Zoom sync failed: ${error.message}`);
      lastError = error.message;
    } finally {
      running = false;
    }
  };
  tick(24 * 7);
  setInterval(() => tick(6), MINUTE).unref();
}

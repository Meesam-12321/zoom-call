import { addDays, dayKey, diffDays, parseDay, zonedParts } from './time.js';

// Zoom call_result values that mean the line was answered.
const ANSWERED = new Set(['answered', 'accepted', 'picked_up', 'connected', 'succeeded']);

// For outgoing calls Zoom also reports "connected" when voicemail, a phone menu or a "number not in service"
// recording answers, and no field tells those apart from a person. Outgoing calls that end within this many
// seconds of being answered therefore count as not connected. MIN_CONNECTED_SECONDS in .env overrides it.
export const DEFAULT_MIN_CONNECTED_SECONDS = 10;

const RESULT_LABELS = {
  answered: 'Answered',
  accepted: 'Accepted',
  picked_up: 'Picked up',
  connected: 'Connected',
  succeeded: 'Succeeded',
  voicemail: 'Voicemail',
  hang_up: 'Hung up',
  canceled: 'Canceled',
  call_failed: 'Failed',
  unconnected: 'Not connected',
  rejected: 'Rejected',
  busy: 'Busy',
  ring_timeout: 'Ring timeout',
  overflowed: 'Overflowed',
  no_answer: 'No answer',
  abandoned: 'Abandoned',
  system_blocked: 'Blocked',
  service_unavailable: 'Service unavailable',
};

const round1 = (n) => Math.round(n * 10) / 10;

export function normalizeCall(item, minConnectedSeconds = DEFAULT_MIN_CONNECTED_SECONDS) {
  const id = item.call_history_uuid || item.id;
  const start = Date.parse(item.start_time);
  if (!id || Number.isNaN(start)) return null;
  const outbound = item.direction !== 'inbound';
  const them = outbound ? 'callee' : 'caller';
  const us = outbound ? 'caller' : 'callee';
  const result = item.call_result || 'unknown';
  const duration = Math.max(0, Number(item.duration) || 0);
  const answeredAt = Date.parse(item.answer_time);
  const tooShort = outbound && ANSWERED.has(result) && duration < minConnectedSeconds;
  return {
    id,
    start,
    direction: outbound ? 'outbound' : 'inbound',
    connected: ANSWERED.has(result) && !tooShort,
    tooShort,
    result: tooShort ? 'Not connected' : RESULT_LABELS[result] || result.replace(/_/g, ' '),
    number: item[`${them}_did_number`] || item[`${them}_ext_number`] || '',
    name: item[`${them}_name`] || '',
    agent: item[`${us}_name`] || '',
    duration,
    // Seconds it rang before the line was answered; null if it never was.
    ringTime: Number.isNaN(answeredAt) ? null : Math.max(0, Math.round((answeredAt - start) / 1000)),
  };
}

/**
 * Definitions:
 *  - connected      = Zoom says the line was answered and, for outgoing calls, it lasted ≥ minConnectedSeconds
 *  - talk time      = sum of durations of connected calls
 *  - avg duration   = talk time ÷ connected calls
 *  - avg calls/day  = all calls ÷ calendar days in the range (days without calls count as 0)
 */
export function buildReport(items, range, { minConnectedSeconds = DEFAULT_MIN_CONNECTED_SECONDS } = {}) {
  const from = range.from.getTime();
  const to = range.to.getTime();
  const calls = items
    .map((item) => normalizeCall(item, minConnectedSeconds))
    .filter((c) => c && c.start >= from && c.start < to)
    .sort((a, b) => b.start - a.start);

  const byDay = new Map();
  for (const call of calls) {
    call.day = dayKey(zonedParts(new Date(call.start), range.tz));
    const d = byDay.get(call.day) || { calls: 0, connected: 0, talkTime: 0 };
    d.calls += 1;
    if (call.connected) {
      d.connected += 1;
      d.talkTime += call.duration;
    }
    byDay.set(call.day, d);
  }

  const days = [];
  const first = parseDay(range.firstDay);
  for (let cursor = parseDay(range.lastDay); diffDays(first, cursor) >= 0; cursor = addDays(cursor, -1)) {
    const key = dayKey(cursor);
    const d = byDay.get(key) || { calls: 0, connected: 0, talkTime: 0 };
    days.push({ day: key, ...d, avgDuration: d.connected ? Math.round(d.talkTime / d.connected) : 0 });
  }

  const connected = calls.filter((c) => c.connected);
  const talkTime = connected.reduce((sum, c) => sum + c.duration, 0);
  const activeDays = days.filter((d) => d.calls > 0).length;
  const longest = connected.reduce((max, c) => (c.duration > (max?.duration ?? -1) ? c : max), null);

  return {
    range: { preset: range.preset, label: range.label, tz: range.tz, firstDay: range.firstDay, lastDay: range.lastDay },
    minConnectedSeconds,
    summary: {
      totalCalls: calls.length,
      connected: connected.length,
      notConnected: calls.length - connected.length,
      talkTime,
      avgDuration: connected.length ? Math.round(talkTime / connected.length) : 0,
      longestDuration: longest?.duration ?? 0,
      days: days.length,
      activeDays,
      avgPerDay: days.length ? round1(calls.length / days.length) : 0,
      avgPerActiveDay: activeDays ? round1(calls.length / activeDays) : 0,
    },
    days,
    calls: calls.map(({ start, ...c }) => ({ ...c, start: new Date(start).toISOString() })),
  };
}

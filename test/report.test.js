import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport, normalizeCall } from '../server/report.js';
import { resolveRange } from '../server/time.js';

let seq = 0;
const call = (overrides) => ({
  call_history_uuid: `call-${++seq}`,
  direction: 'outbound',
  call_result: 'connected',
  duration: 60,
  start_time: '2026-11-02T10:00:00Z',
  caller_name: 'Agent',
  callee_did_number: '+15551234567',
  ...overrides,
});

const NOW = new Date('2026-11-03T12:00:00Z');

test('groups calls into calendar days of the chosen timezone', () => {
  const range = resolveRange({ preset: 'last_7_days', tz: 'Asia/Karachi', now: NOW });
  const report = buildReport(
    [
      call({ start_time: '2026-11-02T21:00:00Z' }), // 02:00 on Nov 3 in Karachi
      call({ start_time: '2026-11-02T10:00:00Z' }), // 15:00 on Nov 2
    ],
    range,
  );
  assert.equal(report.days.find((d) => d.day === '2026-11-03').calls, 1);
  assert.equal(report.days.find((d) => d.day === '2026-11-02').calls, 1);
  assert.equal(report.days[0].day, '2026-11-03', 'newest day first');
  assert.equal(report.days.length, 7);
});

test('averages: talk time and duration use connected calls, calls/day uses every day in range', () => {
  const range = resolveRange({ preset: 'last_7_days', tz: 'UTC', now: NOW });
  const { summary } = buildReport(
    [
      call({ duration: 30 }),
      call({ duration: 90, start_time: '2026-11-01T09:00:00Z' }),
      call({ call_result: 'hang_up', duration: 0 }),
    ],
    range,
  );
  assert.equal(summary.totalCalls, 3);
  assert.equal(summary.connected, 2);
  assert.equal(summary.notConnected, 1);
  assert.equal(summary.talkTime, 120);
  assert.equal(summary.avgDuration, 60);
  assert.equal(summary.longestDuration, 90);
  assert.equal(summary.avgPerDay, 0.4); // 3 calls / 7 days
  assert.equal(summary.activeDays, 2);
  assert.equal(summary.avgPerActiveDay, 1.5);
});

test('drops calls outside the range and duplicates are handled upstream', () => {
  const range = resolveRange({ preset: 'today', tz: 'UTC', now: NOW });
  const { summary, calls } = buildReport([call({ start_time: '2026-11-02T23:59:59Z' }), call({ start_time: '2026-11-03T00:00:00Z' })], range);
  assert.equal(summary.totalCalls, 1);
  assert.equal(calls[0].start, '2026-11-03T00:00:00.000Z');
});

test('the contact is the other party: callee for outgoing, caller for incoming', () => {
  const out = normalizeCall(call({}));
  assert.equal(out.number, '+15551234567');
  assert.equal(out.direction, 'outbound');

  const inbound = normalizeCall(
    call({ direction: 'inbound', call_result: 'no_answer', caller_did_number: '+15559876543', callee_name: 'Agent' }),
  );
  assert.equal(inbound.number, '+15559876543');
  assert.equal(inbound.connected, false);
  assert.equal(inbound.result, 'No answer');
  assert.equal(inbound.agent, 'Agent');
});

test('short outgoing calls are not connected, because voicemail and phone menus also answer', () => {
  const voicemail = normalizeCall(call({ duration: 4, start_time: '2026-11-02T10:00:00Z', answer_time: '2026-11-02T10:00:30Z' }));
  assert.equal(voicemail.connected, false);
  assert.equal(voicemail.tooShort, true);
  assert.equal(voicemail.result, 'Not connected');
  assert.equal(voicemail.ringTime, 30);

  assert.equal(normalizeCall(call({ duration: 10 })).connected, true, 'the cutoff itself counts as connected');
  assert.equal(normalizeCall(call({ duration: 4 }), 0).connected, true, '0 keeps Zoom’s result');
  const inbound = normalizeCall(call({ direction: 'inbound', call_result: 'answered', duration: 4 }));
  assert.equal(inbound.connected, true, 'Zoom knows when you answered an incoming call');
  assert.equal(normalizeCall(call({ call_result: 'hang_up', duration: 0 })).ringTime, null);
});

test('short outgoing calls are left out of talk time and averages', () => {
  const range = resolveRange({ preset: 'last_7_days', tz: 'UTC', now: NOW });
  const report = buildReport([call({ duration: 60 }), call({ duration: 5 })], range, { minConnectedSeconds: 10 });
  assert.equal(report.minConnectedSeconds, 10);
  assert.equal(report.summary.connected, 1);
  assert.equal(report.summary.notConnected, 1);
  assert.equal(report.summary.talkTime, 60);
  assert.equal(report.summary.avgDuration, 60);
});

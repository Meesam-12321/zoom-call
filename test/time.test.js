import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRange } from '../server/time.js';

const NOW = new Date('2026-11-03T12:00:00Z');

test('today starts at local midnight of the chosen timezone', () => {
  const r = resolveRange({ preset: 'today', tz: 'Asia/Karachi', now: NOW });
  assert.equal(r.from.toISOString(), '2026-11-02T19:00:00.000Z');
  assert.equal(r.to.toISOString(), '2026-11-03T19:00:00.000Z');
  assert.equal(r.firstDay, '2026-11-03');
});

test('last month covers the full previous calendar month', () => {
  const r = resolveRange({ preset: 'last_month', tz: 'UTC', now: NOW });
  assert.equal(r.firstDay, '2026-10-01');
  assert.equal(r.lastDay, '2026-10-31');
});

test('custom days survive a daylight-saving change (25-hour day)', () => {
  const r = resolveRange({ preset: 'custom', from: '2026-11-01', to: '2026-11-01', tz: 'America/New_York', now: NOW });
  assert.equal(r.from.toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(r.to.toISOString(), '2026-11-02T05:00:00.000Z');
});

test('a single day covers that calendar day in the chosen timezone', () => {
  const r = resolveRange({ preset: 'day', date: '2026-11-01', tz: 'Asia/Karachi', now: NOW });
  assert.equal(r.from.toISOString(), '2026-10-31T19:00:00.000Z');
  assert.equal(r.to.toISOString(), '2026-11-01T19:00:00.000Z');
  assert.equal(r.firstDay, '2026-11-01');
  assert.equal(r.lastDay, '2026-11-01');
});

test('single-day requests reject invalid and future dates', () => {
  assert.throws(() => resolveRange({ preset: 'day', date: 'yesterday', tz: 'UTC', now: NOW }), RangeError);
  assert.throws(() => resolveRange({ preset: 'day', date: '2026-11-04', tz: 'UTC', now: NOW }), RangeError);
});

test('invalid custom ranges are rejected', () => {
  assert.throws(() => resolveRange({ preset: 'custom', from: '2026-11-05', to: '2026-11-01', tz: 'UTC' }), RangeError);
  assert.throws(() => resolveRange({ preset: 'custom', from: '2026-02-30', to: '2026-03-01', tz: 'UTC' }), RangeError);
});

test('unknown presets fall back to the last 30 days', () => {
  const r = resolveRange({ preset: 'bogus', tz: 'UTC', now: NOW });
  assert.equal(r.preset, 'last_30_days');
  assert.equal(r.firstDay, '2026-10-05');
});

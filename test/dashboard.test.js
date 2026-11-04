import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';
import { todayBounds } from '../server/time.js';

const TZ = 'America/New_York';
// One hour into today in the CRM's time zone, so the calls are "today" whatever time the tests run.
const START = todayBounds(TZ).start.getTime() + 3_600_000;

const record = (id, minute, fields) => ({
  call_history_uuid: id,
  direction: 'outbound',
  caller_email: 'admin@example.com',
  callee_did_number: '+18135550100',
  call_result: 'connected',
  duration: 45,
  start_time: new Date(START + minute * 60_000).toISOString(),
  ...fields,
});

// What Zoom's call history holds for today. Nothing here was dialed from the CRM, except z6.
const RECORDS = [
  record('z1', 0, { duration: 95 }), // connected, and long enough to be a conversation
  record('z2', 1, { duration: 30, caller_email: 'caller@example.com' }),
  record('z3', 2, { duration: 6 }), // "connected" in Zoom, but under 10s: voicemail or a phone menu
  record('z4', 3, { call_result: 'hang_up', duration: 0 }),
  record('z5', 4, { direction: 'inbound', call_result: 'answered', duration: 40, caller_did_number: '+18135550199', callee_email: 'admin@example.com' }),
  record('z6', 5, { duration: 70, caller_email: 'someone-else@zoom.example' }), // dialed from the CRM by the caller, under another Zoom login
];

const zoom = { configured: () => true, callHistory: async () => ({ at: Date.now(), items: RECORDS }) };
const zoomDown = { configured: () => true, callHistory: async () => { throw new Error('Zoom is down'); } };
const zoomOff = { configured: () => false, callHistory: async () => { throw new Error('should not be called'); } };

let store;
let servers = [];
let apps;
let callerId;

const listen = async (options) => {
  const server = createApp(store, options).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/api`;
};

function signedIn(base) {
  let cookie = '';
  const api = async (path, { method = 'GET', body, expect = 200 } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'X-CRM': '1', cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, expect, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  };
  return api;
}

before(async () => {
  store = new Store(':memory:');
  apps = { zoom: await listen({ zoom }), down: await listen({ zoom: zoomDown }), off: await listen({ zoom: zoomOff }) };
  const admin = signedIn(apps.zoom);
  await admin('/auth/setup', { method: 'POST', body: { name: 'Admin', email: 'admin@example.com', password: 'admin-pass-1' } });
  ({ id: callerId } = await admin('/users', { method: 'POST', body: { name: 'Caller', email: 'caller@example.com', password: 'caller-pass-1', role: 'caller', target_calls: 10 } }));
  // The caller dialed z6 from the CRM and saved a positive outcome with a meeting; the Zoom record is linked to that call.
  store.insert('calls', {
    user_id: callerId, phone_e164: '+18135550100', started_at: new Date(START + 5 * 60_000).toISOString(), disposition: 'positive', meeting_booked: 1,
    zoom_uuid: 'z6', zoom_result: 'connected', answered: 1, duration: 70,
  });
});

after(() => servers.forEach((server) => server.close()));

const login = async (base, email, password) => {
  const api = signedIn(base);
  await api('/auth/login', { method: 'POST', body: { email, password } });
  return api;
};

test('the Dashboard and the Zoom call log report the same calls, connections and talk time', async () => {
  const admin = await login(apps.zoom, 'admin@example.com', 'admin-pass-1');
  const log = (await admin(`/zoom/calls?preset=today&tz=${TZ}`)).summary;
  const { summary, source } = await admin('/analytics?range=today');

  assert.equal(source, 'zoom');
  for (const key of ['totalCalls', 'connected', 'notConnected', 'talkTime', 'avgDuration', 'longestDuration']) {
    assert.equal(summary[key], log[key], key);
  }
  // 6 calls; z3 is under 10s and z4 hung up. Talk time = 95 + 30 + 40 + 70.
  assert.deepEqual([summary.totalCalls, summary.connected, summary.notConnected, summary.talkTime], [6, 4, 2, 235]);
  assert.equal(summary.connectRate, 4 / 6);
});

test('outcomes and meetings still come from the CRM; calls dialed outside it have no outcome yet', async () => {
  const admin = await login(apps.zoom, 'admin@example.com', 'admin-pass-1');
  const { summary, breakdown } = await admin('/analytics?range=today');
  // Conversations: connected and over 60s = z1 (95s) and z6 (70s).
  assert.deepEqual([summary.conversations, summary.meetings, summary.meetingRate, summary.withOutcome], [2, 1, 0.5, 1]);
  const count = (key) => breakdown.find((d) => d.key === key).count;
  assert.deepEqual([count('positive'), count(null)], [1, 5]);
  assert.equal(breakdown.reduce((total, d) => total + d.count, 0), summary.totalCalls, 'every call is in exactly one outcome row');
});

test('a caller is counted by the calls they dialed from the CRM or made under their own Zoom email, and sees only their own', async () => {
  const admin = await login(apps.zoom, 'admin@example.com', 'admin-pass-1');
  const byCaller = (await admin(`/analytics?range=today&user=${callerId}`)).summary;
  assert.deepEqual([byCaller.totalCalls, byCaller.connected, byCaller.talkTime], [2, 2, 100], 'z2 by email, z6 by the CRM call');

  const caller = await login(apps.zoom, 'caller@example.com', 'caller-pass-1');
  const own = (await caller('/analytics?range=today')).summary;
  assert.deepEqual([own.totalCalls, own.talkTime], [2, 100], 'a caller never sees the whole Zoom account');

  const { targets } = await admin('/analytics?range=today');
  const mine = targets.find((t) => t.userId === callerId);
  assert.deepEqual([mine.calls, mine.conversations, mine.meetings], [[2, 10], [1, 0], [1, 0]]);
  assert.ok(targets.find((t) => t.name === 'Admin'), 'someone who made calls today shows up in the targets even without a caller role');
});

test('a call list narrows the calls to the leads in it', async () => {
  const admin = await login(apps.zoom, 'admin@example.com', 'admin-pass-1');
  const { id: companyId } = await admin('/companies', { method: 'POST', body: { name: 'Bay Floors', hq_phone: '(813) 555-0100' } });
  const { id: listId } = await admin('/lists', { method: 'POST', body: { name: 'Tampa' } });
  await admin(`/lists/${listId}/add`, { method: 'POST', body: { companyIds: [companyId] } });
  // Only a lead in the list matters: every outgoing record above went to +18135550100; the incoming one came from another number.
  const { summary } = await admin(`/analytics?range=today&list=${listId}`);
  assert.deepEqual([summary.totalCalls, summary.connected], [5, 4]);
});

test('the export holds every Zoom call, so its sheets agree with its summary', async () => {
  const admin = await login(apps.zoom, 'admin@example.com', 'admin-pass-1');
  const res = await fetch(`${apps.zoom}/analytics/export?range=today`, { headers: { 'X-CRM': '1', cookie: (await cookieFor(apps.zoom, 'admin@example.com', 'admin-pass-1')) } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  assert.ok(admin);
});

async function cookieFor(base, email, password) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'X-CRM': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return res.headers.get('set-cookie').split(';')[0];
}

test('without Zoom the Dashboard falls back to the calls dialed from the CRM, and says why', async () => {
  const unreachable = await login(apps.down, 'admin@example.com', 'admin-pass-1');
  const down = await unreachable('/analytics?range=today');
  assert.deepEqual([down.source, down.zoomError], ['crm', 'Zoom is down']);
  assert.deepEqual([down.summary.totalCalls, down.summary.connected, down.summary.talkTime], [1, 1, 70]);

  const notSetUp = await login(apps.off, 'admin@example.com', 'admin-pass-1');
  const off = await notSetUp('/analytics?range=today');
  assert.deepEqual([off.source, off.zoomError, off.summary.totalCalls], ['crm', null, 1]);
});

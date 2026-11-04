// First run: the admin account can be created from anywhere, once.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';

let server;
let base;

before(async () => {
  server = createApp(new Store(':memory:')).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});

after(() => server.close());

// The header is what a hosting provider's proxy adds, so this is how a request from another device looks.
const request = (path, body) => fetch(base + path, {
  method: body ? 'POST' : 'GET',
  headers: { 'X-CRM': '1', 'X-Forwarded-For': '203.0.113.9', 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

test('the first admin needs no setup code, and setup closes once an account exists', async () => {
  const before = await (await request('/state')).json();
  assert.deepEqual(before, { user: null, needsSetup: true });

  const admin = { name: 'Meesam', email: 'admin@example.com', password: 'admin-pass-1' };
  assert.equal((await request('/setup', { ...admin, email: 'not-an-email' })).status, 400);
  assert.equal((await request('/setup', admin)).status, 200);

  assert.equal((await (await request('/state')).json()).needsSetup, false);
  assert.equal((await request('/setup', { ...admin, email: 'someone-else@example.com' })).status, 409, 'nobody can create a second admin this way');
});

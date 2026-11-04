import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import nodemailer from 'nodemailer';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';
import { composeMessage, summarizeThread } from '../server/gmail.js';

const ME = 'me@veloq.example';

test('a conversation row: who, count, unread, attachment and the other people in it', () => {
  const message = (minute, from, to, seen, extra = {}) => ({
    internalDate: new Date(`2026-11-03T10:0${minute}:00Z`),
    flags: new Set(seen ? ['\\Seen'] : []),
    envelope: { subject: `Subject ${minute}`, from: [from], to: [to], ...extra },
  });
  const ashlie = { name: 'Ashlie Butler', address: 'Ashlie@Bobs.example' };
  const self = { name: 'Meesam', address: 'ME@veloq.example' };

  const row = summarizeThread('1', [
    message(2, self, ashlie, true),
    { ...message(1, ashlie, self, false), bodyStructure: { childNodes: [{ disposition: 'attachment' }] } },
  ], ME);
  assert.equal(row.who, 'Ashlie Butler, me', 'senders, oldest first, with our own address as "me"');
  assert.equal(row.subject, 'Subject 2', 'the newest message');
  assert.equal(row.date, '2026-11-03T10:02:00.000Z');
  assert.deepEqual([row.count, row.unread, row.attachment], [2, true, true]);
  assert.deepEqual(row.addresses, ['ashlie@bobs.example'], 'lowercase, without our own address');

  const unanswered = summarizeThread('2', [message(1, self, ashlie, true)], ME);
  assert.equal(unanswered.who, 'To: Ashlie Butler', 'nobody replied yet: show who it went to');
  assert.deepEqual([unanswered.unread, unanswered.attachment], [false, false]);
});

test('a reply carries the headers that keep it in the same Gmail conversation', async () => {
  process.env.GMAIL_USER = ME;
  process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
  try {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const { message } = await transport.sendMail(composeMessage({
      fromName: 'Meesam',
      to: [{ name: 'Ashlie Butler', address: 'ashlie@bobs.example' }],
      subject: 'Re: Your quote',
      text: 'Thanks!\n\n> Earlier message',
      inReplyTo: '<second@mail.example>',
      references: '<first@mail.example> <second@mail.example>',
    }));
    const raw = message.toString();
    assert.match(raw, /^From: Meesam <me@veloq\.example>$/m);
    assert.match(raw, /^To: Ashlie Butler <ashlie@bobs\.example>$/m);
    assert.match(raw, /^Subject: Re: Your quote$/m);
    assert.match(raw, /^In-Reply-To: <second@mail\.example>$/m);
    assert.match(raw, /^References: <first@mail\.example> <second@mail\.example>$/m);
  } finally {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
  }
});

// ---------- through the API, with a pretend mailbox

const fake = {
  sent: [],
  read: [],
  lists: [],
  async listThreads(options) {
    fake.lists.push(options);
    return {
      threads: [
        { id: '101', subject: 'Your quote', who: 'Ashlie', date: '2026-11-03T10:00:00.000Z', count: 2, unread: true, attachment: false, addresses: ['ashlie@bobs.example'] },
        { id: '102', subject: 'Store hours', who: 'Bobs', date: '2026-11-03T09:00:00.000Z', count: 1, unread: false, attachment: false, addresses: ['info@bobs.example'] },
        { id: '103', subject: 'Newsletter', who: 'Someone', date: '2026-11-03T08:00:00.000Z', count: 1, unread: false, attachment: false, addresses: ['news@elsewhere.example'] },
      ],
      cursor: 70,
      total: 3,
      unread: 1,
    };
  },
  async getThread(id) {
    return id === '101' ? { id, subject: 'Your quote', messages: [{ id: '201', text: 'Hello' }], addresses: ['ashlie@bobs.example'] } : null;
  },
  async getMessageHtml(id) {
    return id === '201' ? '<p>Hi</p><script>alert(1)</script>' : null;
  },
  async getAttachment(id, index) {
    return id === '201' && index === 0 ? { filename: 'page.html', content: Buffer.from('<script>alert(1)</script>') } : null;
  },
  async markThreadRead(id) {
    fake.read.push(id);
  },
  async sendMail(fields) {
    fake.sent.push(fields);
    return { messageId: '<new@mail.example>', rejected: [] };
  },
};

let server;
let base;
let store;
let cookie = '';
let callerCookie = '';
let contactId;
let companyId;

async function call(path, { method = 'GET', body, as = cookie, expect = 200 } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'X-CRM': '1', cookie: as, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(res.status, expect, `${method} ${path}`);
  return res;
}
const json = async (...args) => (await call(...args)).json();
const send = (body, options = {}) => call('/mail/send', { method: 'POST', body, ...options });

before(async () => {
  store = new Store(':memory:');
  server = createApp(store, { mail: fake }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;

  const setup = await call('/auth/setup', { method: 'POST', body: { name: 'Meesam', email: 'admin@example.com', password: 'admin-pass-1' }, as: '' });
  cookie = setup.headers.get('set-cookie').split(';')[0];
  await call('/users', { method: 'POST', body: { name: 'Caller', email: 'caller@example.com', password: 'caller-pass-1', role: 'caller' } });
  const login = await call('/auth/login', { method: 'POST', body: { email: 'caller@example.com', password: 'caller-pass-1' }, as: '' });
  callerCookie = login.headers.get('set-cookie').split(';')[0];

  ({ id: companyId } = await json('/companies', { method: 'POST', body: { name: "Bob's Flooring", email: 'info@bobs.example' } }));
  ({ id: contactId } = await json('/contacts', { method: 'POST', body: { company_id: companyId, first_name: 'Ashlie', last_name: 'Butler', email: 'Ashlie@Bobs.example' } }));
});

after(() => server.close());

test('the mailbox is admin-only: callers cannot read or send', async () => {
  const caller = { as: callerCookie, expect: 403 };
  await call('/mail/threads', caller);
  await call('/mail/threads/101', caller);
  await call('/mail/messages/201/body', caller);
  await call('/mail/messages/201/attachments/0', caller);
  await call('/mail/lead-threads?companyId=1', caller);
  await call('/mail/threads/101/read', { method: 'POST', ...caller });
  await send({ to: 'x@example.com', subject: 'Hi', text: 'Hi' }, caller);
  await call('/mail/threads', { as: '', expect: 401 });
  assert.equal(fake.sent.length, 0);

  process.env.GMAIL_USER = ME;
  process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
  try {
    assert.equal((await json('/meta')).mailAddress, ME);
    assert.equal((await json('/meta', { as: callerCookie })).mailAddress, null, 'callers are not even told the address');
  } finally {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
  }
});

test('conversations link to the lead they involve, whatever the case of the address', async () => {
  const { threads, cursor, total, unread } = await json('/mail/threads?folder=sent&q=quote&cursor=70');
  assert.deepEqual(fake.lists.at(-1), { folder: 'sent', query: 'quote', cursor: 70 });
  assert.deepEqual([cursor, total, unread], [70, 3, 1]);
  assert.deepEqual(threads[0].lead, { href: `#/contact/${contactId}`, name: "Ashlie Butler · Bob's Flooring" });
  assert.deepEqual(threads[1].lead, { href: `#/company/${companyId}`, name: "Bob's Flooring" });
  assert.equal(threads[2].lead, null);
  assert.ok(threads.every((thread) => !('addresses' in thread)));

  await json('/mail/threads?folder=../../etc');
  assert.equal(fake.lists.at(-1).folder, 'inbox', 'unknown folders fall back to the inbox');
});

test("a lead's emails are found by all of its addresses", async () => {
  await json(`/mail/lead-threads?contactId=${contactId}`);
  assert.equal(fake.lists.at(-1).folder, 'all');
  assert.equal(fake.lists.at(-1).query,
    'from:ashlie@bobs.example OR to:ashlie@bobs.example OR cc:ashlie@bobs.example OR from:info@bobs.example OR to:info@bobs.example OR cc:info@bobs.example');

  await json(`/mail/lead-threads?companyId=${companyId}`);
  assert.match(fake.lists.at(-1).query, /from:info@bobs\.example .*from:ashlie@bobs\.example/, "the company's and its contacts'");

  const { id: empty } = await json('/companies', { method: 'POST', body: { name: 'No Email Floors' } });
  const before = fake.lists.length;
  assert.deepEqual(await json(`/mail/lead-threads?companyId=${empty}`), { threads: [], cursor: null, addresses: [] });
  assert.equal(fake.lists.length, before, 'no address, no search');
  await call('/mail/lead-threads?contactId=99999', { expect: 404 });
});

test('reading a conversation and marking it read', async () => {
  const thread = await json('/mail/threads/101');
  assert.equal(thread.lead.name, "Ashlie Butler · Bob's Flooring");
  await call('/mail/threads/999', { expect: 404 });
  await call('/mail/threads/1%20OR%20ALL', { expect: 404 });
  await json('/mail/threads/101/read', { method: 'POST' });
  assert.deepEqual(fake.read, ['101']);
});

test('an email body can never run or load anything unless the reader asks for images', async () => {
  const res = await call('/mail/messages/201/body');
  const policy = res.headers.get('content-security-policy');
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.match(policy, /^sandbox /);
  assert.doesNotMatch(policy, /allow-scripts|allow-forms|allow-top-navigation|allow-modals/);
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /img-src data:;/, 'remote images stay blocked');
  assert.doesNotMatch(policy, /script-src/);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', 'the CRM may frame it');
  assert.match(policy, /frame-ancestors 'self'/, 'other sites may not');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await res.text(), /<base target="_blank">/);

  const images = await call('/mail/messages/201/body?images=1');
  assert.match(images.headers.get('content-security-policy'), /img-src data: https: http:;/);
  assert.doesNotMatch(images.headers.get('content-security-policy'), /allow-scripts/);

  await call('/mail/messages/999/body', { expect: 404 });
  const app = await fetch(base.replace('/api', '/'));
  assert.equal(app.headers.get('x-frame-options'), 'DENY', 'the rest of the CRM still cannot be framed');
});

test('attachments always download with a neutral type', async () => {
  const res = await call('/mail/messages/201/attachments/0');
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="?page\.html"?/);
  await call('/mail/messages/201/attachments/5', { expect: 404 });
});

test('sending: checks the input and sends only plain values', async () => {
  await send({ subject: 'Hi', text: 'Hi' }, { expect: 400 });
  await send({ to: 'not-an-address', subject: 'Hi', text: 'Hi' }, { expect: 400 });
  await send({ to: 'x@example.com, broken', subject: 'Hi', text: 'Hi' }, { expect: 400 });
  await send({ to: 'x@example.com' }, { expect: 400 });
  // nodemailer would read a file for { text: { path } }: only strings get through.
  await send({ to: 'x@example.com', text: { path: '/etc/passwd' } }, { expect: 400 });
  assert.equal(fake.sent.length, 0);

  await send({
    to: '"Doe, Jane" <jane@example.com>; pat@example.com',
    cc: 'cc@example.com',
    subject: 'Line one\r\nBcc: injected@example.com',
    text: 'Hello',
    inReplyTo: '<a@mail.example>\r\nBcc: injected@example.com',
    references: '<a@mail.example> <b@mail.example>',
  });
  const mail = fake.sent.at(-1);
  assert.deepEqual(mail.to, [{ name: 'Doe, Jane', address: 'jane@example.com' }, { name: '', address: 'pat@example.com' }]);
  assert.deepEqual(mail.cc, [{ name: '', address: 'cc@example.com' }]);
  assert.equal(mail.fromName, 'Meesam');
  assert.equal(mail.subject, 'Line one Bcc: injected@example.com', 'line breaks cannot add headers');
  assert.equal(mail.inReplyTo, '<a@mail.example>');
  assert.equal(mail.references, '<a@mail.example> <b@mail.example>');
});

test('sending to a lead is noted once in its history, and Do Not Call asks first', async () => {
  const history = (id) => store.all("SELECT details FROM activity WHERE entity = 'company' AND entity_id = ? AND action = 'email_sent'", id).map((row) => JSON.parse(row.details));

  await send({ to: 'ASHLIE@bobs.example', subject: 'Quote', text: 'Hi' });
  assert.deepEqual(history(companyId), [{ to: ['ASHLIE@bobs.example'], subject: 'Quote' }], 'found by address');

  // The contact, the store address and the contact the email was started from are one company: one line.
  await send({ to: 'ashlie@bobs.example', cc: 'info@bobs.example', subject: 'Both', text: 'Hi', contactId });
  assert.equal(history(companyId).filter((entry) => entry.subject === 'Both').length, 1);
  const lines = (await json(`/contacts/${contactId}`)).activity.filter((entry) => entry.action === 'email_sent' && entry.details.subject === 'Both');
  assert.equal(lines.length, 1, "and one line on the contact's page");

  // A typed address counts for the lead the email was started from.
  const { id: other } = await json('/companies', { method: 'POST', body: { name: 'Other Floors' } });
  await send({ to: 'owner@other.example', subject: 'Intro', text: 'Hi', companyId: other });
  assert.equal(history(other)[0].subject, 'Intro');

  await json(`/contacts/${contactId}/dnc`, { method: 'POST', body: { on: true } });
  const count = fake.sent.length;
  const refused = await send({ to: 'ashlie@bobs.example', subject: 'Again', text: 'Hi' }, { expect: 409 }).then((res) => res.json());
  assert.equal(refused.doNotCall, true);
  assert.match(refused.error, /Ashlie Butler · Bob's Flooring is marked Do Not Call/);
  await send({ to: 'someone@else.example', subject: 'Again', text: 'Hi', contactId }, { expect: 409 });
  assert.equal(fake.sent.length, count, 'nothing went out');

  await send({ to: 'ashlie@bobs.example', subject: 'Sorry', text: 'Removed you', force: true });
  assert.equal(fake.sent.length, count + 1);
  assert.equal(history(companyId).at(-1).do_not_call_override, true);
});

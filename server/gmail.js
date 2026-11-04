// Gmail over IMAP (reading) and SMTP (sending), signed in with a Google app password.
// Gmail rules: every message has a thread ID (X-GM-THRID), All Mail holds everything except spam and trash,
// and mail sent over SMTP lands in Sent Mail by itself. Folders are opened read-only unless a change is intended.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

// Signing in takes about 2 seconds, so one connection stays open while the inbox is in use.
const IDLE_CLOSE_MS = 5 * 60_000;
// Repeated failed sign-ins can get a Google account locked, so a rejected password is not retried straight away.
const REJECTED_WAIT_MS = 5 * 60_000;
const SCAN_BATCH = 50;
const MAX_TEXT = 100_000;
const CACHE_BYTES = 50 * 1024 * 1024;
const SPECIAL_USE = { inbox: '\\Inbox', sent: '\\Sent', all: '\\All' };
const SUMMARY_FIELDS = { uid: true, threadId: true, flags: true, envelope: true, internalDate: true, bodyStructure: true };
const REJECTED = 'Google rejected GMAIL_USER and GMAIL_APP_PASSWORD in .env. Check the address, or create a new app password.';

export class MailError extends Error {}

/** The account's address, or null if .env has no Gmail credentials. */
export function mailAddress() {
  const { GMAIL_USER: user, GMAIL_APP_PASSWORD: password } = process.env;
  return user && password ? user.trim() : null;
}

// Google shows app passwords as four groups of letters; the spaces are not part of them.
const appPassword = () => process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '');

function requireAddress() {
  const address = mailAddress();
  if (!address) throw new MailError('Gmail is not set up. Add GMAIL_USER and GMAIL_APP_PASSWORD to .env and restart the CRM.');
  return address;
}

// ---------- connection

let connection = null;
let folderPaths = null;
let closeTimer = null;
let rejectedAt = 0;

function connect() {
  const address = requireAddress();
  if (connection) return connection;
  if (Date.now() - rejectedAt < REJECTED_WAIT_MS) throw new MailError(REJECTED);
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: address, pass: appPassword() },
    logger: false,
    connectionTimeout: 15_000,
  });
  const opening = client.connect().then(() => client);
  const forget = () => {
    if (connection === opening) connection = null;
  };
  // A dropped connection is replaced on the next request. Without an error listener it would crash the server.
  client.on('error', forget);
  client.on('close', forget);
  opening.catch(forget);
  connection = opening;
  return opening;
}

async function folderPath(client, folder) {
  folderPaths ??= new Map((await client.list()).filter((box) => box.specialUse).map((box) => [box.specialUse, box.path]));
  const path = folderPaths.get(SPECIAL_USE[folder]);
  if (!path) throw new MailError(`Gmail is not sharing the "${folder}" folder. Turn on "Show in IMAP" for it in Gmail settings → Labels.`);
  return path;
}

function scheduleClose(client) {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => client.logout().catch(() => {}), IDLE_CLOSE_MS);
  closeTimer.unref();
}

function fromGmail(error) {
  if (error.authenticationFailed) {
    rejectedAt = Date.now();
    return new MailError(REJECTED);
  }
  return error.responseText || error.code ? new MailError(`Gmail error: ${error.responseText || error.message}`) : error;
}

/** Runs `work` with the folder open. IMAP commands must not run inside a fetch loop, so collect first (fetchAll). */
async function withFolder(folder, work, { write = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    let client;
    try {
      client = await connect();
      const lock = await client.getMailboxLock(await folderPath(client, folder), { readOnly: !write });
      try {
        return await work(client);
      } finally {
        lock.release();
        scheduleClose(client);
      }
    } catch (error) {
      // Gmail drops idle connections; a request that hit a dead one is retried once on a new one.
      if (client && !client.usable) {
        connection = null;
        if (attempt === 0) continue;
      }
      throw fromGmail(error);
    }
  }
}

// ---------- reading

const uniqueList = (items) => [...new Set(items)];
const hasAttachment = (node) => Boolean(node && (node.disposition === 'attachment' || node.childNodes?.some(hasAttachment)));

/** Addresses in the given header values other than our own, lowercase and each once. */
function otherAddresses(people, me) {
  return uniqueList(people.map((person) => person.address?.toLowerCase()).filter((address) => address && address !== me));
}

/** A conversation's row in a list, from its messages' headers. */
export function summarizeThread(id, messages, me) {
  const ordered = [...messages].sort((a, b) => a.internalDate - b.internalDate);
  const last = ordered.at(-1);
  const isMe = (person) => person.address?.toLowerCase() === me;
  const label = (person) => (isMe(person) ? 'me' : person.name || person.address);
  const senders = ordered.flatMap((message) => message.envelope.from || []);
  const recipients = ordered.flatMap((message) => [...(message.envelope.to || []), ...(message.envelope.cc || [])]);
  return {
    id,
    subject: last.envelope.subject || '',
    who: senders.some((person) => !isMe(person))
      ? uniqueList(senders.map(label)).join(', ')
      : `To: ${uniqueList((last.envelope.to || []).map(label)).join(', ')}`,
    date: last.internalDate.toISOString(),
    count: ordered.length,
    unread: ordered.some((message) => !message.flags.has('\\Seen')),
    attachment: ordered.some((message) => hasAttachment(message.bodyStructure)),
    addresses: otherAddresses([...senders, ...recipients], me),
  };
}

/** Finds the next `limit` conversations in the open folder, newest first. Positions count from the oldest message. */
async function scanFolder(client, { query, cursor, limit }) {
  const matches = query ? (await client.search({ gmraw: query }, { uid: true })) || [] : null;
  let high = matches ? matches.length : client.mailbox.exists;
  if (cursor) high = Math.min(high, cursor);
  const ids = new Set();
  while (high > 0) {
    const low = Math.max(1, high - SCAN_BATCH + 1);
    const range = matches ? matches.slice(low - 1, high) : `${low}:${high}`;
    const batch = await client.fetchAll(range, { uid: true, threadId: true }, { uid: Boolean(matches) });
    for (const message of batch.sort((a, b) => b.seq - a.seq)) {
      if (ids.size === limit && !ids.has(message.threadId)) {
        return { ids: [...ids], next: matches ? matches.indexOf(message.uid) + 1 : message.seq };
      }
      ids.add(message.threadId);
    }
    high = low - 1;
  }
  return { ids: [...ids], next: null };
}

/** Every message of these conversations. All Mail must be open. */
async function threadMessages(client, ids, fields) {
  const uids = await client.search({ or: ids.map((threadId) => ({ threadId })) }, { uid: true });
  return uids?.length ? client.fetchAll(uids, fields, { uid: true }) : [];
}

/** One page of a folder's conversations; `cursor` continues from the previous page, `query` uses Gmail's search syntax. */
export async function listThreads({ folder = 'inbox', query = '', cursor = null, limit = 30 } = {}) {
  const me = requireAddress().toLowerCase();
  const { page, counts } = await withFolder(folder, async (client) => ({
    page: await scanFolder(client, { query, cursor, limit }),
    counts: query ? null : await client.status(client.mailbox.path, { messages: true, unseen: true }),
  }));
  const messages = page.ids.length ? await withFolder('all', (client) => threadMessages(client, page.ids, SUMMARY_FIELDS)) : [];
  const byThread = Map.groupBy(messages, (message) => message.threadId);
  const threads = page.ids
    .filter((id) => byThread.has(id))
    .map((id) => summarizeThread(id, byThread.get(id), me))
    .sort((a, b) => b.date.localeCompare(a.date));
  return { threads, cursor: page.next, total: counts?.messages ?? null, unread: counts?.unseen ?? null };
}

const people = (field) => [].concat(field || []).flatMap((item) => item.value || []).flatMap((person) => person.group || person)
  .map(({ name, address }) => ({ name: name || '', address: address || '' }));

// Images inside the message are built into its HTML, so only real attachments are listed.
const filesOf = (mail) => mail.attachments.filter((file) => !file.related || file.contentDisposition === 'attachment');

const parseMail = (source) => simpleParser(source, { skipTextToHtml: true, skipTextLinks: true });

function toMessage(mail) {
  const html = mail.html || null;
  return {
    subject: mail.subject || '',
    from: people(mail.from)[0] || { name: '', address: '' },
    to: people(mail.to),
    cc: people(mail.cc),
    replyTo: people(mail.replyTo),
    text: (mail.text || '').slice(0, MAX_TEXT),
    html,
    remoteImages: Boolean(html && /(?:<img\b[^>]*\bsrc\s*=\s*["']?\s*|url\(\s*["']?\s*)(?:https?:)?\/\//i.test(html)),
    attachments: filesOf(mail).map((file, index) => ({ index, filename: file.filename || `attachment-${index + 1}`, size: file.size, contentType: file.contentType })),
    messageId: mail.messageId || null,
    references: [].concat(mail.references || []),
  };
}

// Parsed messages never change (read state is fetched each time), so recently read ones are kept in memory.
const parsedMessages = new Map();
let cachedBytes = 0;

function remember(id, message) {
  const bytes = (message.html?.length || 0) + message.text.length;
  parsedMessages.set(id, { message, bytes });
  cachedBytes += bytes;
  for (const [key, entry] of parsedMessages) {
    if (cachedBytes <= CACHE_BYTES) break;
    parsedMessages.delete(key);
    cachedBytes -= entry.bytes;
  }
}

/** A conversation with every message's content, oldest first, or null if it does not exist. Does not mark it as read. */
export async function getThread(id) {
  const me = requireAddress().toLowerCase();
  return withFolder('all', async (client) => {
    const heads = await threadMessages(client, [id], { uid: true, flags: true, internalDate: true });
    if (!heads.length) return null;
    const bodies = new Map(heads.filter((head) => parsedMessages.has(head.emailId)).map((head) => [head.emailId, parsedMessages.get(head.emailId).message]));
    const missing = heads.filter((head) => !bodies.has(head.emailId)).map((head) => head.uid);
    if (missing.length) {
      for await (const { emailId, source } of client.fetch(missing, { uid: true, source: true }, { uid: true })) {
        const message = toMessage(await parseMail(source));
        bodies.set(emailId, message);
        remember(emailId, message);
      }
    }
    const messages = heads
      .sort((a, b) => a.internalDate - b.internalDate)
      .map((head) => {
        const { html, ...message } = bodies.get(head.emailId);
        return {
          ...message,
          id: head.emailId,
          date: head.internalDate.toISOString(),
          unread: !head.flags.has('\\Seen'),
          mine: message.from.address.toLowerCase() === me,
          hasHtml: Boolean(html),
        };
      });
    return {
      id,
      subject: messages.at(-1).subject,
      messages,
      addresses: otherAddresses(messages.flatMap((message) => [message.from, ...message.to, ...message.cc]), me),
    };
  });
}

async function readMail(client, id) {
  const [uid] = (await client.search({ emailId: id }, { uid: true })) || [];
  if (!uid) return null;
  const { source } = await client.fetchOne(uid, { source: true }, { uid: true });
  return parseMail(source);
}

/** A message's HTML, or null if it has none. */
export async function getMessageHtml(id) {
  const cached = parsedMessages.get(id);
  if (cached) return cached.message.html;
  return withFolder('all', async (client) => {
    const mail = await readMail(client, id);
    if (!mail) return null;
    const message = toMessage(mail);
    remember(id, message);
    return message.html;
  });
}

/** One attachment of a message with its content, or null. */
export async function getAttachment(id, index) {
  return withFolder('all', async (client) => {
    const mail = await readMail(client, id);
    const file = mail && filesOf(mail)[index];
    return file ? { filename: file.filename || `attachment-${index + 1}`, content: file.content } : null;
  });
}

export async function markThreadRead(id) {
  await withFolder('all', async (client) => {
    const uids = await client.search({ threadId: id }, { uid: true });
    if (uids?.length) await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
  }, { write: true });
}

// ---------- sending

/** The message nodemailer sends: only plain values, so it never reads files or URLs from a request. */
export function composeMessage({ fromName, to, cc, bcc, subject, text, inReplyTo, references }) {
  return { from: { name: fromName, address: requireAddress() }, to, cc, bcc, subject, text, inReplyTo, references };
}

let transport = null;

export async function sendMail(fields) {
  const message = composeMessage(fields);
  transport ??= nodemailer.createTransport({
    service: 'gmail',
    auth: { user: message.from.address, pass: appPassword() },
    connectionTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    const info = await transport.sendMail(message);
    return { messageId: info.messageId, rejected: info.rejected };
  } catch (error) {
    throw new MailError(error.code === 'EAUTH' ? REJECTED : `Gmail did not accept the email: ${error.message}`);
  }
}

// Inbox: the Gmail account's conversations (Inbox, Sent, All mail, Gmail search) and one conversation with all its messages.
import { canEmail, composeDialog, formatPerson, threadRow } from '../mail.js';
import { api, busy, empty, fill, fmt, h, icon, pageHead, tabs } from '../ui.js';

const FOLDERS = [['inbox', 'Inbox'], ['sent', 'Sent'], ['all', 'All mail']];
// Matches the sandbox the server sends with each message. Same-origin only lets this page size the frame and hide
// quoted text; without allow-scripts nothing in the email can run.
const FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';
const MAX_FRAME_HEIGHT = 20_000;
// A sent message takes a moment to appear in Sent and in its conversation.
const SENT_DELAY_MS = 2000;

const plural = (n, word) => `${fmt.num(n)} ${word}${n === 1 ? '' : 's'}`;

export async function render(root, { query }, ctx, isCurrent) {
  if (!canEmail(ctx)) {
    fill(root,
      pageHead('Inbox', 'Email from your Gmail account'),
      h('div', { class: 'card empty-state' }, 'Add your Gmail address and app password (GMAIL_USER and GMAIL_APP_PASSWORD) to .env and restart the CRM to see your email here.'));
    return;
  }
  const folder = FOLDERS.some(([key]) => key === query.get('folder')) ? query.get('folder') : 'inbox';
  const q = query.get('q') || '';
  const hash = (params) => {
    const merged = new URLSearchParams({ folder, ...(q && { q }), ...params });
    if (!merged.get('q')) merged.delete('q');
    return `#/inbox?${merged}`;
  };
  const back = hash({});
  const subtitle = h('span', {}, ctx.meta.mailAddress);
  const rows = h('div', { class: 'mail-rows' });
  const list = h('section', { class: 'card mail-list' }, h('div', { class: 'loading-state' }, 'Loading your email…'));
  const seen = new Set();
  let cursor = null;

  const params = () => new URLSearchParams({ folder, ...(q && { q }), ...(cursor && { cursor }) });

  const more = h('button', {
    class: 'btn secondary',
    type: 'button',
    onclick: () => busy(more, async () => {
      const page = await api(`/mail/threads?${params()}`);
      if (isCurrent()) show(page);
    }),
  }, 'Load more');

  function show(page) {
    // A long conversation can come up again further back in the folder; it is only listed once.
    const fresh = page.threads.filter((thread) => !seen.has(thread.id));
    for (const thread of fresh) seen.add(thread.id);
    rows.append(...fresh.map((thread) => threadRow(thread, back)));
    cursor = page.cursor;
    more.hidden = !cursor;
  }

  const search = h('input', {
    type: 'search',
    value: q,
    placeholder: 'Search like in Gmail: from:name, subject:quote, has:attachment',
    onchange: (event) => ctx.navigate(hash({ q: event.target.value.trim() })),
  });

  fill(root,
    pageHead('Inbox', subtitle, [
      h('button', { class: 'btn secondary', type: 'button', title: 'Check for new email', onclick: () => ctx.rerender() }, icon('refresh'), 'Refresh'),
      h('button', { class: 'btn', type: 'button', onclick: () => composeDialog(ctx, { onSent: folder === 'inbox' ? null : () => setTimeout(() => isCurrent() && ctx.rerender(), SENT_DELAY_MS) }) }, icon('plus'), 'New email'),
    ]),
    h('div', { class: 'toolbar' },
      tabs(FOLDERS, folder, (key) => ctx.navigate(hash({ folder: key }))),
      h('label', { class: 'field grow' }, h('span', { class: 'sr-only' }, 'Search email'), search)),
    list);

  const page = await api(`/mail/threads?${params()}`);
  if (!isCurrent()) return;
  if (page.total !== null) subtitle.textContent = `${ctx.meta.mailAddress} · ${plural(page.total, 'message')} · ${fmt.num(page.unread)} unread`;
  fill(list, page.threads.length ? [rows, h('div', { class: 'row center mail-more' }, more)] : empty(q ? 'No conversations match this search.' : 'No email here.'));
  show(page);
}

// ---------- one conversation

// Where the earlier conversation starts in a plain-text message.
const QUOTE_START = /^(?:On [^\n]{6,200}(?:\n[^\n]{0,200})?wrote:[ \t]*$|-{2,}[ \t]*Original Message[ \t]*-{2,}|>)/m;

function splitQuoted(text) {
  const match = QUOTE_START.exec(text);
  return match?.index ? [text.slice(0, match.index).trimEnd(), text.slice(match.index)] : [text, ''];
}

/** Plain text with its web addresses as links. Everything is inserted as text. */
function linked(text) {
  return text.split(/(https?:\/\/[^\s<>"')\]]+)/g).map((part, i) => (i % 2 ? h('a', { href: part, target: '_blank', rel: 'noopener noreferrer' }, part) : part));
}

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function quoteToggle(setShown) {
  const button = h('button', {
    class: 'btn small ghost',
    type: 'button',
    onclick: () => {
      const showing = button.textContent === 'Hide quoted text';
      setShown(!showing);
      button.textContent = showing ? 'Show quoted text' : 'Hide quoted text';
    },
  }, 'Show quoted text');
  return button;
}

function textBody(text) {
  const [visible, quoted] = splitQuoted(text);
  const shown = h('div', { class: 'message-text' }, linked(visible));
  if (!quoted) return shown;
  const rest = h('div', { class: 'message-text muted', hidden: true }, linked(quoted));
  return [shown, h('div', { class: 'message-tools' }, quoteToggle((on) => { rest.hidden = !on; })), rest];
}

/** Parts of a loaded email that repeat earlier messages. A forward's content is the message, so it stays. */
function quotedParts(doc) {
  const parts = [...doc.querySelectorAll('.gmail_quote, blockquote[type="cite"], .yahoo_quoted')]
    .filter((el) => !/^-+\s*Forwarded message/i.test(el.textContent.trim()));
  // Outlook has no wrapper around the quote: it is everything after this marker.
  for (let el = doc.querySelector('#appendonsend, #divRplyFwdMsg'); el; el = el.nextElementSibling) parts.push(el);
  return parts;
}

/** An HTML email in a sandboxed frame, sized to its content, with quoted text and remote images hidden at first. */
function htmlBody(message) {
  const url = `/api/mail/messages/${message.id}/body`;
  const tools = h('div', { class: 'message-tools' });
  let toggle = null;

  // Twice: a scrollbar at the old height changes where lines wrap. A wide email keeps its sideways scrollbar, which needs room too.
  const fit = (frame) => {
    const doc = frame.contentDocument;
    for (let pass = 0; pass < 2; pass++) {
      const scrollbar = frame.contentWindow.innerHeight - doc.documentElement.clientHeight;
      frame.style.height = `${Math.min(Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0) + scrollbar, MAX_FRAME_HEIGHT)}px`;
    }
  };

  const frame = h('iframe', {
    class: 'message-frame',
    title: `Email from ${message.from.name || message.from.address}`,
    sandbox: FRAME_SANDBOX,
    referrerpolicy: 'no-referrer',
    src: url,
    onload: () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      const parts = doc.body ? quotedParts(doc) : [];
      const setShown = (on) => {
        for (const part of parts) part.style.display = on ? '' : 'none';
        fit(frame);
      };
      setShown(false);
      // A message that is nothing but quotes is shown whole.
      const hasOwnText = !parts.length || doc.body.innerText.trim();
      if (!hasOwnText) setShown(true);
      toggle?.remove();
      toggle = parts.length && hasOwnText ? quoteToggle(setShown) : null;
      if (toggle) tools.prepend(toggle);
    },
  });

  if (message.remoteImages) {
    const images = h('button', {
      class: 'btn small secondary',
      type: 'button',
      title: 'Images load from the sender\'s servers, which tells them you opened this email.',
      onclick: () => {
        frame.src = `${url}?images=1`;
        images.remove();
      },
    }, 'Show images');
    tools.append(images);
  }
  return [frame, tools];
}

function messageCard(message, { open }) {
  const label = (person) => (person.name || person.address);
  const recipients = [...message.to, ...message.cc].map(label).join(', ');
  const snippet = splitQuoted(message.text)[0].replace(/\s+/g, ' ').trim().slice(0, 200);
  const line = h('div', { class: 'message-line' });
  const body = h('div', { class: 'message-body' });

  const setOpen = (next) => {
    head.setAttribute('aria-expanded', String(next));
    body.hidden = !next;
    line.textContent = next ? `to ${recipients || 'undisclosed recipients'}` : snippet;
    if (next && !body.hasChildNodes()) {
      fill(body,
        message.hasHtml ? htmlBody(message) : textBody(message.text),
        message.attachments.length > 0 && h('div', { class: 'row message-files' }, message.attachments.map((file) =>
          h('a', { class: 'btn small secondary attachment', href: `/api/mail/messages/${message.id}/attachments/${file.index}`, download: file.filename, title: file.filename },
            icon('clip', 14), h('span', { class: 'mail-clip' }, file.filename), h('span', { class: 'muted' }, fileSize(file.size))))));
    }
  };

  const head = h('button', { class: 'message-head', type: 'button', onclick: () => setOpen(head.getAttribute('aria-expanded') !== 'true') },
    h('div', { class: 'message-who' },
      h('strong', {}, message.mine ? 'me' : label(message.from)),
      !message.mine && message.from.name && h('span', { class: 'muted' }, message.from.address),
      message.unread && h('span', { class: 'mail-dot', title: 'Unread' })),
    h('span', { class: 'message-date' }, fmt.ago(message.date)),
    line);
  setOpen(open);
  return h('article', { class: 'card message' }, head, body);
}

function replyDraft(ctx, thread, { all, onSent }) {
  const message = thread.messages.at(-1);
  const me = ctx.meta.mailAddress.toLowerCase();
  const key = (person) => person.address.toLowerCase();
  // Replying to our own last message goes on to the same people.
  const primary = message.mine ? message.to : message.replyTo.length ? message.replyTo : [message.from];
  const taken = new Set(primary.map(key));
  const copies = !all ? [] : [...(message.mine ? [] : message.to), ...message.cc].filter((person) => {
    if (key(person) === me || taken.has(key(person))) return false;
    taken.add(key(person));
    return true;
  });
  const quoted = message.text.split('\n').map((line) => `> ${line}`).join('\n');
  composeDialog(ctx, {
    title: all ? 'Reply to all' : 'Reply',
    to: primary.map(formatPerson).join(', '),
    cc: copies.map(formatPerson).join(', '),
    subject: /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`,
    text: `\n\nOn ${fmt.dateTime(message.date)}, ${message.from.name || message.from.address} wrote:\n${quoted}`,
    inReplyTo: message.messageId,
    references: [...message.references, message.messageId].filter(Boolean).join(' '),
    onSent,
  });
}

export async function renderThread(root, { id, query }, ctx, isCurrent) {
  const thread = await api(`/mail/threads/${id}`);
  if (!isCurrent()) return;
  const last = thread.messages.at(-1);
  const backParam = query.get('back') || '';
  const back = /^#\/[\w/?=&%.+-]*$/.test(backParam) ? backParam : '#/inbox';
  const onSent = () => setTimeout(() => isCurrent() && ctx.rerender(), SENT_DELAY_MS);

  // Reply all only appears when someone else would get the email too.
  const me = ctx.meta.mailAddress.toLowerCase();
  const others = new Set([last.from, ...last.to, ...last.cc].map((person) => person.address.toLowerCase()).filter((address) => address !== me));
  const replyButtons = () => [
    others.size > 1 && h('button', { class: 'btn secondary', type: 'button', onclick: () => replyDraft(ctx, thread, { all: true, onSent }) }, icon('replyAll'), 'Reply to all'),
    h('button', { class: 'btn', type: 'button', onclick: () => replyDraft(ctx, thread, { all: false, onSent }) }, icon('reply'), 'Reply'),
  ];

  fill(root,
    pageHead(thread.subject || '(no subject)', h('span', {},
      plural(thread.messages.length, 'message'),
      thread.lead && [' · ', h('a', { href: thread.lead.href }, thread.lead.name)]),
    replyButtons(), [back.startsWith('#/inbox') ? 'Inbox' : 'Back', back]),
    h('div', { class: 'thread' }, thread.messages.map((message) => messageCard(message, { open: message.unread || message === last }))),
    h('div', { class: 'row end section-gap' }, replyButtons()));

  // Opening a conversation reads it, here and in Gmail.
  if (thread.messages.some((message) => message.unread)) api(`/mail/threads/${id}/read`, { method: 'POST' }).catch(() => {});
}

// The Inbox page and email from leads. The mailbox belongs to the account in .env, so everything here is admin-only.
import express from 'express';
import addressparser from 'nodemailer/lib/addressparser';
import { requireAdmin } from './auth.js';
import { extractEmail } from './phone.js';
import { HttpError } from './records.js';

const FOLDERS = new Set(['inbox', 'sent', 'all']);

// Anyone can send this mailbox HTML, so it is untrusted: the sandbox runs no scripts and submits no forms, and nothing
// loads from the internet unless the reader asks for images.
const FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';
const FRAME_STYLE = 'html{overflow-x:auto}body{margin:0;padding:16px;color:#18181b;background:#fff;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}';

function frameHeaders(showImages) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': [
      `sandbox ${FRAME_SANDBOX}`,
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `img-src data:${showImages ? ' https: http:' : ''}`,
      'font-src data:',
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join('; '),
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, no-store',
  };
}

function mailId(value) {
  if (!/^\d{1,20}$/.test(value)) throw new HttpError(404, 'Email not found.');
  return value;
}

const textOf = (value) => (typeof value === 'string' ? value : '');

/** Addresses from a "To" box: "Name" <a@b.com>, c@d.com. */
function recipients(value) {
  const list = addressparser(textOf(value).replace(/;/g, ','), { flatten: true }).filter((person) => person.address || person.name);
  for (const person of list) {
    if (extractEmail(person.address) !== person.address?.toLowerCase()) throw new HttpError(400, `"${person.address || person.name}" is not a valid email address.`);
  }
  return list.map(({ name, address }) => ({ name, address }));
}

/** Message IDs such as <abc@mail.gmail.com> from a header value, joined by spaces. */
const messageIds = (value) => (textOf(value).match(/<[^<>\s]+>/g) || []).join(' ');

/** CRM leads with these email addresses: address → { companyId, href, name, doNotCall }. */
function leadsByAddress(store, addresses) {
  const list = [...new Set(addresses.map((address) => address.toLowerCase()))];
  const leads = new Map();
  if (!list.length) return leads;
  const marks = list.map(() => '?').join(', ');
  const add = (address, lead) => {
    const key = address.toLowerCase();
    const known = leads.get(key);
    if (known) known.doNotCall ||= lead.doNotCall;
    else leads.set(key, lead);
  };
  const contacts = store.all(
    `SELECT ct.id, ct.company_id, ct.email, ct.first_name, ct.last_name, ct.do_not_call, co.do_not_call AS company_dnc, co.name AS company
     FROM contacts ct JOIN companies co ON co.id = ct.company_id WHERE lower(ct.email) IN (${marks})`,
    ...list,
  );
  for (const c of contacts) {
    const name = `${[c.first_name, c.last_name].filter(Boolean).join(' ')} · ${c.company}`;
    add(c.email, { companyId: c.company_id, href: `#/contact/${c.id}`, name, doNotCall: Boolean(c.do_not_call || c.company_dnc) });
  }
  for (const co of store.all(`SELECT id, email, name, do_not_call FROM companies WHERE lower(email) IN (${marks})`, ...list)) {
    add(co.email, { companyId: co.id, href: `#/company/${co.id}`, name: co.name, doNotCall: Boolean(co.do_not_call) });
  }
  return leads;
}

/** The lead's own row plus the addresses to look for in the mailbox. */
function leadFromRequest(store, { contactId, companyId }) {
  if (contactId) {
    const contact = store.get(
      `SELECT ct.company_id, ct.email, ct.do_not_call, co.do_not_call AS company_dnc, co.email AS company_email, ct.first_name, ct.last_name, co.name AS company
       FROM contacts ct JOIN companies co ON co.id = ct.company_id WHERE ct.id = ?`,
      Number(contactId),
    );
    if (!contact) throw new HttpError(404, 'Contact not found.');
    return {
      companyId: contact.company_id,
      name: `${[contact.first_name, contact.last_name].filter(Boolean).join(' ')} · ${contact.company}`,
      doNotCall: Boolean(contact.do_not_call || contact.company_dnc),
      addresses: [contact.email, contact.company_email].filter(Boolean),
    };
  }
  if (companyId) {
    const company = store.get('SELECT id, name, email, do_not_call FROM companies WHERE id = ?', Number(companyId));
    if (!company) throw new HttpError(404, 'Company not found.');
    const people = store.all('SELECT email FROM contacts WHERE company_id = ? AND email IS NOT NULL', company.id).map((row) => row.email);
    return { companyId: company.id, name: company.name, doNotCall: Boolean(company.do_not_call), addresses: [company.email, ...people].filter(Boolean) };
  }
  return null;
}

// A list row's lead link: the first address in the conversation that belongs to a lead.
const leadLink = (leads, addresses) => {
  const lead = addresses.map((address) => leads.get(address)).find(Boolean);
  return lead ? { href: lead.href, name: lead.name } : null;
};

export function mailRoutes(store, gmail) {
  const r = express.Router();
  r.use('/mail', requireAdmin);

  const withLeads = (page) => {
    const leads = leadsByAddress(store, page.threads.flatMap((thread) => thread.addresses));
    return { ...page, threads: page.threads.map(({ addresses, ...thread }) => ({ ...thread, lead: leadLink(leads, addresses) })) };
  };

  r.get('/mail/threads', async (req, res) => {
    const folder = FOLDERS.has(req.query.folder) ? req.query.folder : 'inbox';
    const cursor = Number.parseInt(req.query.cursor, 10) || null;
    res.json(withLeads(await gmail.listThreads({ folder, query: textOf(req.query.q).trim(), cursor })));
  });

  // Conversations with a lead's addresses, from the whole mailbox.
  r.get('/mail/lead-threads', async (req, res) => {
    const lead = leadFromRequest(store, req.query);
    if (!lead) throw new HttpError(400, 'Choose a lead.');
    const addresses = [...new Set(lead.addresses.map((address) => extractEmail(address)).filter(Boolean))];
    if (!addresses.length) return res.json({ threads: [], cursor: null, addresses });
    const query = addresses.map((address) => `from:${address} OR to:${address} OR cc:${address}`).join(' OR ');
    res.json({ ...withLeads(await gmail.listThreads({ folder: 'all', query, limit: 20 })), addresses });
  });

  r.get('/mail/threads/:id', async (req, res) => {
    const thread = await gmail.getThread(mailId(req.params.id));
    if (!thread) throw new HttpError(404, 'Email not found.');
    const { addresses, ...rest } = thread;
    res.json({ ...rest, lead: leadLink(leadsByAddress(store, addresses), addresses) });
  });

  r.post('/mail/threads/:id/read', async (req, res) => {
    await gmail.markThreadRead(mailId(req.params.id));
    res.json({ ok: true });
  });

  r.get('/mail/messages/:id/body', async (req, res) => {
    const html = await gmail.getMessageHtml(mailId(req.params.id));
    if (html === null) throw new HttpError(404, 'Email not found.');
    res.set(frameHeaders(req.query.images === '1'));
    res.send(`<!doctype html><meta charset="utf-8"><base target="_blank"><style>${FRAME_STYLE}</style>${html}`);
  });

  r.get('/mail/messages/:id/attachments/:index', async (req, res) => {
    const file = await gmail.getAttachment(mailId(req.params.id), Number(req.params.index));
    if (!file) throw new HttpError(404, 'Attachment not found.');
    // Always a download with a neutral type, so an attachment can never run as a page on this site.
    res.attachment(file.filename);
    res.set('Content-Type', 'application/octet-stream');
    res.send(file.content);
  });

  r.post('/mail/send', async (req, res) => {
    const body = req.body;
    const [to, cc, bcc] = [body.to, body.cc, body.bcc].map(recipients);
    if (!to.length) throw new HttpError(400, 'Add who the email is to.');
    const subject = textOf(body.subject).replace(/\s+/g, ' ').trim();
    const text = textOf(body.text);
    if (!subject && !text.trim()) throw new HttpError(400, 'Write a subject or a message first.');

    const everyone = [...to, ...cc, ...bcc].map((person) => person.address);
    const chosen = leadFromRequest(store, body);
    const matched = [...leadsByAddress(store, everyone).values()];
    const leads = chosen ? [chosen, ...matched] : matched;
    const flagged = [...new Map(leads.filter((lead) => lead.doNotCall).map((lead) => [lead.name, lead])).values()];
    if (flagged.length && !body.force) {
      throw new HttpError(409, `${flagged.map((lead) => lead.name).join(', ')} ${flagged.length === 1 ? 'is' : 'are'} marked Do Not Call.`, { doNotCall: true });
    }

    const sent = await gmail.sendMail({
      fromName: req.user.name,
      to,
      cc,
      bcc,
      subject,
      text,
      inReplyTo: messageIds(body.inReplyTo) || undefined,
      references: messageIds(body.references) || undefined,
    });
    // One note per company: both its page and its contacts' pages show company history.
    store.tx(() => {
      for (const [companyId, group] of Map.groupBy(leads, (lead) => lead.companyId)) {
        store.log(req.user.id, 'company', companyId, 'email_sent', { to: everyone, subject, ...(group.some((lead) => lead.doNotCall) && { do_not_call_override: true }) });
      }
    });
    res.json({ messageId: sent.messageId, rejected: sent.rejected });
  });

  return r;
}

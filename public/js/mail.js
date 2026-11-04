// Email from the CRM: the compose dialog, the Email button on leads and conversation rows (shared by Inbox and lead pages).
import { api, badge, busy, confirmDialog, field, fmt, h, icon, openModal, toast } from './ui.js';

export const canEmail = (ctx) => Boolean(ctx.meta.mailAddress);

/** "Name" <a@b.com>, the way the To box shows a person. */
export const formatPerson = ({ name, address }) => (name ? `"${name.replace(/"/g, '')}" <${address}>` : address);

async function send(body) {
  try {
    return await api('/mail/send', { method: 'POST', body });
  } catch (error) {
    if (!error.data?.doNotCall) throw error;
    const go = await confirmDialog({ title: 'Marked Do Not Call', message: `${error.message} Send this email anyway?`, confirm: 'Send anyway', danger: true });
    return go ? api('/mail/send', { method: 'POST', body: { ...body, force: true } }) : null;
  }
}

/** The compose dialog. It only closes through its buttons, so a stray click or Esc cannot lose a draft. */
export function composeDialog(ctx, { title = 'New email', to = '', cc = '', subject = '', text = '', suggestions = [], hint, contactId, companyId, inReplyTo, references, onSent } = {}) {
  const toInput = h('input', { type: 'text', value: to, list: suggestions.length ? 'mail-suggestions' : null, autocomplete: 'off' });
  const ccInput = h('input', { type: 'text', value: cc, autocomplete: 'off' });
  const bccInput = h('input', { type: 'text', autocomplete: 'off' });
  const subjectInput = h('input', { type: 'text', value: subject });
  const message = h('textarea', { rows: 12, value: text });
  const copies = h('div', { class: 'form-grid', hidden: !cc }, field('Cc', ccInput), field('Bcc', bccInput));
  const showCopies = h('button', {
    class: 'btn small ghost',
    type: 'button',
    hidden: Boolean(cc),
    onclick: () => {
      copies.hidden = false;
      showCopies.hidden = true;
      ccInput.focus();
    },
  }, 'Cc / Bcc');

  const sendButton = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(sendButton, async () => {
      const result = await send({
        to: toInput.value, cc: ccInput.value, bcc: bccInput.value, subject: subjectInput.value, text: message.value, contactId, companyId, inReplyTo, references,
      });
      if (!result) return;
      modal.close();
      if (result.rejected?.length) toast(`Sent, but Gmail refused ${result.rejected.join(', ')}.`, { kind: 'warn' });
      else toast('Email sent.', { kind: 'ok' });
      onSent?.();
    }),
  }, icon('send'), 'Send');

  const modal = openModal({
    title,
    dismissable: false,
    body: h('div', { class: 'stack' },
      h('div', { class: 'compose-from' }, h('span', { class: 'muted' }, `From ${ctx.user.name} <${ctx.meta.mailAddress}>`), showCopies),
      field('To', toInput, hint),
      suggestions.length > 0 && h('datalist', { id: 'mail-suggestions' }, suggestions.map(([address, label]) => h('option', { value: address }, label))),
      copies,
      field('Subject', subjectInput),
      field('Message', message)),
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), sendButton],
  });

  // Replies start typing above the quoted message; new emails on the first empty box.
  if (text) {
    message.focus();
    message.setSelectionRange(0, 0);
  } else if (to) subjectInput.focus();
}

/** Compose to a lead: its own address first, then the store's and its colleagues' as suggestions. */
export async function emailLead(ctx, { contactId, companyId, onSent }) {
  const { contact, company, contacts } = await api(contactId ? `/contacts/${contactId}` : `/companies/${companyId}`);
  const known = new Map();
  const add = (address, label) => {
    if (address && !known.has(address)) known.set(address, label);
  };
  if (contact) add(contact.email, fmt.name(contact));
  add(company.email, company.name);
  for (const colleague of contacts) add(colleague.email, fmt.name(colleague));
  const [first] = known.keys();
  composeDialog(ctx, {
    title: `Email ${contact ? fmt.name(contact) : company.name}`,
    to: first || '',
    hint: first ? null : 'No email on file for this lead. Type an address to send.',
    suggestions: [...known],
    contactId: contact?.id,
    companyId: contact ? undefined : company.id,
    onSent,
  });
}

/** The Email button on a lead, or nothing for accounts without access to the mailbox. */
export function emailButton(ctx, lead, { small = false, onSent } = {}) {
  if (!canEmail(ctx)) return null;
  return h('button', {
    class: `btn secondary${small ? ' small' : ''}`,
    type: 'button',
    onclick: (event) => busy(event.currentTarget, () => emailLead(ctx, { ...lead, onSent })),
  }, icon('mail', small ? 14 : 16), 'Email');
}

/** An address that opens the compose dialog (or the computer's mail app for accounts without the mailbox). */
export function emailLink(ctx, address, attrs = {}) {
  const onclick = canEmail(ctx) && ((event) => {
    event.preventDefault();
    composeDialog(ctx, { to: address });
  });
  return h('a', { ...attrs, href: `mailto:${address}`, onclick }, address);
}

/** One conversation in a list. `back` is the page its thread view returns to. */
export function threadRow(thread, back) {
  const subject = thread.subject || '(no subject)';
  return h('a', { class: `mail-row${thread.unread ? ' unread' : ''}`, href: `#/thread/${thread.id}?${new URLSearchParams({ back })}` },
    h('span', { class: 'mail-dot', title: thread.unread ? 'Unread' : null }),
    h('span', { class: 'mail-who' }, h('span', { class: 'mail-clip', title: thread.who }, thread.who), thread.count > 1 && h('span', { class: 'count' }, thread.count)),
    h('span', { class: 'mail-subject' }, h('span', { class: 'mail-clip', title: subject }, subject), thread.lead && badge(thread.lead.name, 'info')),
    h('span', { class: 'mail-end' }, h('span', { class: 'mail-attached', title: thread.attachment ? 'Has attachments' : null }, thread.attachment && icon('clip', 14)), h('span', {}, fmt.ago(thread.date))));
}

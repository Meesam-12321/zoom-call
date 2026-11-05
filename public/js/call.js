// Placing a call (Zoom click-to-call) and the mandatory outcome dialog that follows it.
import { leadPanel } from './lead.js';
import { askToNotify, callForm, savedMessage } from './logcall.js';
import { api, busy, confirmDialog, fmt, h, icon, openModal, toast } from './ui.js';

let outcomeOpen = false;

export function dialUrl(ctx, e164) {
  const scheme = ctx.meta.settings.dial_scheme;
  return scheme === 'tel' ? `tel:${e164}` : scheme === 'callto' ? `callto:${e164}` : `zoomphonecall://${e164}`;
}

function dial(url) {
  const link = h('a', { href: url });
  document.body.append(link);
  link.click();
  link.remove();
}

/** Logs the call, opens Zoom on the number, then asks for the outcome. Resolves after the outcome is saved. */
export async function startCall(ctx, { contactId, companyId, phone, listId, onDone, force = false }) {
  let result;
  try {
    result = await api('/calls/start', { method: 'POST', body: { contactId, companyId, phone, listId, force } });
  } catch (error) {
    if (error.data?.pending) {
      toast(error.message, { kind: 'warn' });
      return showOutcome(ctx, error.data.pending, { onDone });
    }
    if (error.data?.maxAttempts) {
      const go = await confirmDialog({ title: 'Maximum attempts reached', message: `${error.message} Call anyway?`, confirm: 'Call anyway' });
      return go ? startCall(ctx, { contactId, companyId, phone, listId, onDone, force: true }) : undefined;
    }
    toast(error.message, { kind: 'error' });
    return undefined;
  }
  dial(result.dialUrl);
  ctx.setPending(result.call);
  return showOutcome(ctx, result.call, { onDone });
}

/** The outcome dialog. It cannot be closed until an outcome is saved (or the call is discarded). */
export async function showOutcome(ctx, call, { onDone } = {}) {
  if (outcomeOpen) return;
  outcomeOpen = true;
  const leadUrl = call.contact_id ? `/contacts/${call.contact_id}` : `/companies/${call.company_id}`;
  let detail;
  try {
    detail = await api(leadUrl);
  } catch (error) {
    outcomeOpen = false;
    toast(error.message, { kind: 'error' });
    return;
  }

  const tz = detail.company.time_zone || ctx.meta.settings.business_tz;
  const form = callForm(ctx, tz);

  let modal;
  // The caller can fix the lead's name or email while on the call. The panel (and the script, which greets them by first name)
  // is drawn again from what was saved, and the dialog's heading follows.
  const titleFor = (d) => `Call outcome · ${d.contact ? fmt.name(d.contact) : d.company.name}`;
  const panelFor = (d) => leadPanel(ctx, d, { compact: true, onEdit: refreshLead });
  let panel = panelFor(detail);
  async function refreshLead() {
    detail = await api(leadUrl);
    const next = panelFor(detail);
    panel.replaceWith(next);
    panel = next;
    modal.setTitle(titleFor(detail));
  }

  const finish = () => {
    outcomeOpen = false;
    modal.close();
    ctx.setPending(null);
  };

  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      const body = form.read();
      const result = await api(`/calls/${call.id}/outcome`, { method: 'POST', body });
      finish();
      toast(savedMessage(form.chosen(), result), { kind: 'ok' });
      askToNotify(body);
      onDone?.(result);
    }),
  }, icon('check'), 'Save outcome');

  const discard = h('button', {
    class: 'btn ghost left',
    type: 'button',
    onclick: () => busy(discard, async () => {
      const sure = await confirmDialog({
        title: 'Discard this call?',
        message: 'Only discard a call that never went through, for example when Zoom did not open.',
        confirm: 'Discard call',
        danger: true,
      });
      if (!sure) return;
      await api(`/calls/${call.id}/discard`, { method: 'POST' });
      finish();
      toast('Call discarded.');
      onDone?.({ discarded: true });
    }),
  }, "Didn't call · discard");

  modal = openModal({
    title: titleFor(detail),
    wide: true,
    dismissable: false,
    body: h('div', { class: 'call-grid' },
      panel,
      h('div', {},
        h('div', { class: 'dialing' },
          icon('phone'),
          h('span', {}, `Calling ${fmt.phone(call.phone_e164)} with Zoom (started ${fmt.time(call.started_at)}).`),
          h('button', { class: 'btn small secondary', type: 'button', onclick: () => dial(dialUrl(ctx, call.phone_e164)) }, 'Open Zoom again')),
        h('h2', {}, 'What happened?'),
        h('p', { class: 'muted small' }, 'Save the outcome to log the call. You cannot start another call until you do.'),
        form.el)),
    footer: [discard, save],
  });
}

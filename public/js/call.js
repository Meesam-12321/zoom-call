// Placing a call (Zoom click-to-call) and the mandatory outcome dialog that follows it.
import { leadPanel } from './lead.js';
import { api, busy, confirmDialog, field, fmt, h, icon, localInput, openModal, select, toast } from './ui.js';

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

function actionText(d) {
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
  const next = {
    retry: `retry in ${days(d.retry_days ?? 1)}`,
    callback: 'callback at a set time',
    positive: 'follow-up, stage Interested',
    nurture: `Nurture, follow up in ${days(d.retry_days ?? 30)}`,
    lost: 'mark the lead lost',
    invalid_number: 'flag the number as wrong',
    dnc: 'block dialing for good',
  }[d.action];
  return `${d.connected ? 'Connected' : 'Not connected'}${next ? ` · ${next}` : ''}`;
}

function savedMessage(disposition, result) {
  const parts = [`Saved: ${disposition.label}.`];
  if (result.stage.from !== result.stage.to) parts.push(`Stage: ${result.stage.label}.`);
  if (result.task) parts.push(`Next: ${result.task.title}, ${fmt.dateTime(result.task.due_at)}.`);
  return parts.join(' ');
}

/** The outcome dialog. It cannot be closed until an outcome is saved (or the call is discarded). */
export async function showOutcome(ctx, call, { onDone } = {}) {
  if (outcomeOpen) return;
  outcomeOpen = true;
  let detail;
  try {
    detail = await api(call.contact_id ? `/contacts/${call.contact_id}` : `/companies/${call.company_id}`);
  } catch (error) {
    outcomeOpen = false;
    toast(error.message, { kind: 'error' });
    return;
  }

  const tz = detail.company.time_zone || ctx.meta.settings.business_tz;
  const notes = h('textarea', { rows: 4, placeholder: 'What happened? Who you spoke to, objections, next steps…' });
  const callbackAt = h('input', { type: 'datetime-local', min: localInput(new Date(), tz) });
  const meeting = h('input', { type: 'checkbox' });
  const lostReason = select([['', 'Choose a reason…'], ...ctx.meta.lostReasons.map((r) => [r, r])], '');
  const extra = h('div', { class: 'outcome-extra' });
  let chosen = null;

  const choose = (d) => {
    chosen = d;
    extra.replaceChildren(...[
      d.action === 'callback' && field(`Call back at (their local time, ${fmt.zoneName(tz)})`, callbackAt),
      d.action === 'positive' && h('label', { class: 'check' }, meeting, 'A meeting is booked'),
      d.action === 'lost' && field('Why is the lead lost?', lostReason),
      d.action === 'dnc' && h('p', { class: 'note' }, 'This lead will be blocked from dialing for good. Only an admin can undo it.'),
    ].filter(Boolean));
    extra.querySelector('input, select')?.focus();
  };

  const options = h('div', { class: 'outcomes', role: 'radiogroup', 'aria-label': 'Call outcome' },
    ctx.meta.dispositions.filter((d) => d.active).map((d) => h('label', { class: 'outcome' },
      h('input', { type: 'radio', name: 'outcome', value: d.key, onchange: () => choose(d) }),
      h('span', {}, d.label),
      h('small', {}, actionText(d)))));

  let modal;
  const finish = () => {
    outcomeOpen = false;
    modal.close();
    ctx.setPending(null);
  };

  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      if (!chosen) throw new Error('Choose what happened on the call.');
      const result = await api(`/calls/${call.id}/outcome`, {
        method: 'POST',
        body: { disposition: chosen.key, notes: notes.value, callbackAt: callbackAt.value, meetingBooked: meeting.checked, lostReason: lostReason.value },
      });
      finish();
      toast(savedMessage(chosen, result), { kind: 'ok' });
      if (chosen.action === 'callback' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
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
    title: `Call outcome · ${detail.contact ? fmt.name(detail.contact) : detail.company.name}`,
    wide: true,
    dismissable: false,
    body: h('div', { class: 'call-grid' },
      leadPanel(ctx, detail, { compact: true }),
      h('div', {},
        h('div', { class: 'dialing' },
          icon('phone'),
          h('span', {}, `Calling ${fmt.phone(call.phone_e164)} with Zoom (started ${fmt.time(call.started_at)}).`),
          h('button', { class: 'btn small secondary', type: 'button', onclick: () => dial(dialUrl(ctx, call.phone_e164)) }, 'Open Zoom again')),
        h('h2', {}, 'What happened?'),
        h('p', { class: 'muted small' }, 'Save the outcome to log the call. You cannot start another call until you do.'),
        options,
        extra,
        h('div', { class: 'block' }, field('Notes', notes)))),
    footer: [discard, save],
  });
}

// Recording what happened on a call: quick templates, the outcome, a note and a reminder.
// The form is shared by the dialog after the Call button and by "Log call", for calls dialed by hand in Zoom.
import { phonesOf } from './lead.js';
import { api, busy, field, fill, fmt, h, icon, localInput, openModal, select, toast } from './ui.js';

const DAY = 86_400_000;
const QUARTER_HOUR = 900_000;

// One click fills in the outcome, the note and the reminder. Each one uses an outcome from Settings, and disappears if an admin switches that outcome off.
const TEMPLATES = [
  { label: "Didn't pick up", outcome: 'no_answer', note: "Didn't pick up." },
  { label: 'Left a voicemail', outcome: 'voicemail', note: 'Left a voicemail.' },
  { label: 'Had a conversation', outcome: 'conversation', note: 'Had a conversation.' },
  { label: 'Call back tomorrow', outcome: 'callback', note: 'Asked to call back tomorrow.', days: 1 },
  { label: 'Call back in 2 days', outcome: 'callback', note: 'Asked to call back in 2 days.', days: 2 },
  { label: 'Call back in 3 days', outcome: 'callback', note: 'Asked to call back in 3 days.', days: 3 },
  { label: 'Interested', outcome: 'positive', note: 'Interested.' },
  { label: 'Not interested', outcome: 'negative', note: 'Not interested.' },
  { label: 'Wrong number', outcome: 'wrong_number', note: 'Wrong number.' },
];
const REMINDERS = [[1, 'Tomorrow'], [2, 'In 2 days'], [3, 'In 3 days'], [7, 'In a week']];
// Outcomes that end the calling, so a reminder to call again makes no sense, and those with their own automatic follow-up.
const NO_REMINDER = new Set(['lost', 'invalid_number', 'dnc']);
const AUTOMATIC = new Set(['retry', 'nurture']);

/** That many days from now in the lead's local time, moved to 10 AM if it would land outside the working day. */
function daysFromNow(days, tz) {
  const text = localInput(new Date(Math.ceil((Date.now() + days * DAY) / QUARTER_HOUR) * QUARTER_HOUR), tz);
  const hour = Number(text.slice(11, 13));
  return hour >= 9 && hour < 18 ? text : `${text.slice(0, 10)}T10:00`;
}

const inDays = (n) => (n === 0 ? 'today' : n === 1 ? 'in 1 day' : `in ${n} days`);

function actionText(d) {
  const next = {
    retry: `retry ${inDays(d.retry_days ?? 1)}`,
    callback: 'callback at a set time',
    positive: 'follow-up, stage Interested',
    nurture: `Nurture, follow up ${inDays(d.retry_days ?? 30)}`,
    lost: 'mark the lead lost',
    invalid_number: 'flag the number as wrong',
    dnc: 'block dialing for good',
  }[d.action];
  return `${d.connected ? 'Connected' : 'Not connected'}${next ? ` · ${next}` : ''}`;
}

export function savedMessage(disposition, result) {
  const parts = [`Saved: ${disposition.label}.`];
  if (result.stage.from !== result.stage.to) parts.push(`Stage: ${result.stage.label}.`);
  if (result.task) parts.push(`Next: ${result.task.title}, ${fmt.dateTime(result.task.due_at)}.`);
  return parts.join(' ');
}

/** A reminder is only useful if the browser may show it when this tab is in the background. */
export function askToNotify(body) {
  if ((body.callbackAt || body.remindAt) && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

/**
 * The form. `compact` shows the outcome as a dropdown instead of the full grid, for the smaller Log call dialog.
 * read() returns the body for saving the outcome, and throws if something required is missing.
 */
export function callForm(ctx, tz, { compact = false } = {}) {
  const active = ctx.meta.dispositions.filter((d) => d.active);
  const byKey = new Map(active.map((d) => [d.key, d]));
  const templates = TEMPLATES.filter((t) => byKey.has(t.outcome));

  const notes = h('textarea', { rows: 3, placeholder: 'What happened? Who you spoke to, objections, next steps…' });
  const when = h('input', { type: 'datetime-local', min: localInput(new Date(), tz) });
  const whenField = field(`Remind at (their local time, ${fmt.zoneName(tz)})`, when);
  const meeting = h('input', { type: 'checkbox' });
  const lostReason = select([['', 'Choose a reason…'], ...ctx.meta.lostReasons.map((r) => [r, r])], '');
  const details = h('div', { class: 'outcome-extra' });
  const templateChips = h('div', { class: 'chips' });
  const reminderChips = h('div', { class: 'chips' });
  const reminder = h('div', { class: 'block', hidden: true }, h('h3', {}, 'Reminder'), reminderChips, whenField);

  let chosen = null;
  let template = null;
  let templateNote = '';
  // 'auto' = the outcome's usual follow-up, 'none', or 'at' = the time in the input. `preset` is the chip that set it.
  let mode = 'none';
  let preset = null;

  const chip = (label, on, onclick) => h('button', { class: `chip${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on), onclick }, label);

  function drawTemplates() {
    fill(templateChips, templates.map((t) => chip(t.label, t === template, () => useTemplate(t))));
  }

  function setReminder(nextMode, nextPreset = null) {
    mode = nextMode;
    preset = nextPreset;
    if (typeof nextPreset === 'number') when.value = daysFromNow(nextPreset, tz);
    drawReminder();
  }

  function drawReminder() {
    if (!chosen) return;
    fill(reminderChips,
      AUTOMATIC.has(chosen.action) && chip(`As usual, ${inDays(chosen.retry_days ?? 1)}`, mode === 'auto', () => setReminder('auto')),
      chosen.action !== 'callback' && chip('No reminder', mode === 'none', () => setReminder('none')),
      REMINDERS.map(([days, label]) => chip(label, mode === 'at' && preset === days, () => setReminder('at', days))),
      chip('Pick a time', mode === 'at' && preset === 'pick', () => {
        setReminder('at', 'pick');
        when.focus();
      }));
    whenField.hidden = mode !== 'at';
  }
  when.addEventListener('input', () => {
    if (mode === 'at' && preset !== 'pick') {
      preset = 'pick';
      drawReminder();
    }
  });

  function setOutcome(d, days) {
    chosen = d;
    fill(details,
      d.action === 'positive' && h('label', { class: 'check' }, meeting, 'A meeting is booked'),
      d.action === 'lost' && field('Why is the lead lost?', lostReason),
      d.action === 'dnc' && h('p', { class: 'note' }, 'This lead will be blocked from dialing for good. Only an admin can undo it.'));
    reminder.hidden = NO_REMINDER.has(d.action);
    if (days) setReminder('at', days);
    else if (d.action === 'callback') setReminder('at', 1);
    else setReminder(AUTOMATIC.has(d.action) ? 'auto' : 'none');
  }

  // Replaces a note that only holds the last template's words; anything typed by hand is kept.
  function useTemplate(t) {
    template = t;
    setOutcome(byKey.get(t.outcome), t.days);
    showOutcome(t.outcome);
    const typed = notes.value.trim();
    notes.value = !typed || typed === templateNote ? t.note : `${t.note} ${typed}`;
    templateNote = notes.value;
    drawTemplates();
    (details.querySelector('input, select') || notes).focus();
    notes.setSelectionRange(notes.value.length, notes.value.length);
  }

  function pickOutcome(key) {
    template = null;
    setOutcome(byKey.get(key));
    drawTemplates();
    details.querySelector('input, select')?.focus();
  }

  const dropdown = compact && select([['', 'Choose what happened…'], ...active.map((d) => [d.key, d.label])], '', {
    onchange: (event) => event.target.value && pickOutcome(event.target.value),
  });
  const grid = !compact && h('div', { class: 'outcomes', role: 'radiogroup', 'aria-label': 'Call outcome' },
    active.map((d) => h('label', { class: 'outcome' },
      h('input', { type: 'radio', name: 'outcome', value: d.key, onchange: () => pickOutcome(d.key) }),
      h('span', {}, d.label),
      h('small', {}, actionText(d)))));
  function showOutcome(key) {
    if (dropdown) dropdown.value = key;
    if (grid) grid.querySelector(`input[value="${CSS.escape(key)}"]`).checked = true;
  }

  drawTemplates();
  return {
    el: h('div', { class: 'stack' },
      templates.length > 0 && h('div', {}, h('div', { class: 'eyebrow form-label' }, 'Quick templates'), templateChips),
      compact ? field('Outcome', dropdown) : grid,
      details,
      field('Note', notes),
      reminder),
    chosen: () => chosen,
    read() {
      if (!chosen) throw new Error('Choose what happened on the call.');
      const body = { disposition: chosen.key, notes: notes.value, meetingBooked: meeting.checked, lostReason: lostReason.value };
      if (chosen.action === 'callback') body.callbackAt = when.value;
      else if (!NO_REMINDER.has(chosen.action)) {
        if (mode === 'at') {
          if (!when.value) throw new Error('Pick when to be reminded.');
          body.remindAt = when.value;
        } else if (mode === 'none') body.noFollowUp = true;
      }
      return body;
    },
  };
}

const zoomLabel = (z) => [fmt.ago(z.start_time), fmt.phone(z.number), z.duration ? fmt.span(z.duration) : 'not answered'].join(' · ');

/** Records a call dialed outside the CRM. `zoom` preselects one of Zoom's records for it. */
export async function logCallDialog(ctx, { contactId, companyId, listId, zoom, onDone }) {
  let detail;
  try {
    detail = await api(contactId ? `/contacts/${contactId}` : `/companies/${companyId}`);
  } catch (error) {
    toast(error.message, { kind: 'error' });
    return;
  }
  const { contact, company } = detail;
  const tz = company.time_zone || ctx.meta.settings.business_tz;
  const phones = phonesOf(contact, company);
  const known = detail.zoomCalls || [];
  const zoomCalls = zoom && !known.some((z) => z.uuid === zoom.uuid) ? [zoom, ...known] : known;
  const form = callForm(ctx, tz, { compact: true });

  const whichCall = zoomCalls.length > 0 && select(
    [...zoomCalls.map((z) => [z.uuid, zoomLabel(z)]), ['', 'A different call, not listed here']],
    zoom?.uuid ?? zoomCalls[0].uuid,
    { onchange: () => showPhone() },
  );
  const phone = phones.length > 1 && select(phones.map((p) => [p.e164, `${p.label} · ${fmt.phone(p.e164)}`]), phones[0].e164);
  const phoneField = phone && field('Number you called', phone);
  const showPhone = () => {
    if (phoneField) phoneField.hidden = Boolean(whichCall?.value);
  };
  showPhone();

  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      const body = {
        ...form.read(),
        contactId,
        companyId,
        listId,
        zoomUuid: whichCall ? whichCall.value || undefined : undefined,
        phone: phone ? phone.value : phones[0]?.e164,
      };
      const result = await api('/calls/log', { method: 'POST', body });
      modal.close();
      toast(savedMessage(form.chosen(), result), { kind: 'ok' });
      askToNotify(body);
      onDone?.(result);
    }),
  }, icon('check'), 'Save call');

  const modal = openModal({
    title: `Log a call · ${contact ? fmt.name(contact) : company.name}`,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, [contact && company.name, !whichCall && !phone && phones[0] && fmt.phone(phones[0].e164), company.time_zone && `Their time: ${fmt.localTime(company.time_zone)}`].filter(Boolean).join(' · ')),
      whichCall && field('Which call was it?', whichCall, 'From your Zoom history.'),
      phoneField,
      !whichCall && ctx.meta.zoomConfigured && h('p', { class: 'muted small' }, 'Zoom can take a few minutes to list a call. Save now, and it will be matched automatically.'),
      form.el),
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save],
  });
}

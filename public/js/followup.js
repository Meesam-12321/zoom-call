// After a call: changing its note, snoozing a reminder, or moving it to a chosen time.
import { api, busy, field, fmt, h, icon, localInput, openMenu, openModal, toast } from './ui.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Not shorter than an hour: reminders fire 10 minutes before they are due.
const SNOOZES = [['For 1 hour', HOUR], ['For 3 hours', 3 * HOUR], ['Until tomorrow', DAY], ['For 2 days', 2 * DAY], ['For 3 days', 3 * DAY], ['For 1 week', 7 * DAY]];

export function rescheduleDialog(ctx, task, onChange) {
  const input = h('input', { type: 'datetime-local', value: localInput(new Date(task.due_at)) });
  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: { due: input.value } });
      modal.close();
      onChange?.();
    }),
  }, 'Save');
  const modal = openModal({
    title: 'Move this reminder',
    body: [h('p', {}, task.title), field(`Due (${fmt.zoneName(ctx.meta.settings.business_tz)})`, input)],
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save],
  });
}

/** The snooze menu for an open task. It counts from the due time, or from now if that has passed. */
export function snoozeMenu(ctx, anchor, task, onChange) {
  const change = async (body, message) => {
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body });
      toast(message, { kind: 'ok' });
      onChange?.();
    } catch (error) {
      toast(error.message, { kind: 'error' });
    }
  };
  const from = Math.max(Date.now(), Date.parse(task.due_at));
  openMenu(anchor, [
    ...SNOOZES.map(([label, ms]) => [label, () => {
      const due = new Date(from + ms);
      return change({ due: localInput(due) }, `Snoozed until ${fmt.dateTime(due.toISOString())}.`);
    }]),
    ['Pick a time…', () => rescheduleDialog(ctx, task, onChange)],
    ['Cancel this reminder', () => change({ status: 'canceled' }, 'Reminder canceled.')],
  ]);
}

export const snoozeButton = (ctx, task, onChange) => h('button', {
  class: 'btn small ghost',
  type: 'button',
  'aria-haspopup': 'menu',
  onclick: (event) => snoozeMenu(ctx, event.currentTarget, task, onChange),
}, icon('clock', 14), 'Snooze');

/** Writes or changes the note on a call that has already been recorded. Updates call.notes before calling onSaved. */
export function noteDialog(call, onSaved) {
  const notes = h('textarea', { rows: 5, placeholder: 'What happened? Who you spoke to, objections, next steps…', 'aria-label': 'Note' }, call.notes || '');
  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      const result = await api(`/calls/${call.id}`, { method: 'PATCH', body: { notes: notes.value } });
      call.notes = result.notes;
      modal.close();
      toast('Note saved.', { kind: 'ok' });
      onSaved?.();
    }),
  }, icon('check'), 'Save note');
  const modal = openModal({
    title: call.notes ? 'Edit note' : 'Add a note',
    body: [call.started_at && h('p', { class: 'muted small' }, `Call on ${fmt.dateTime(call.started_at)}`), notes],
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save],
  });
}

/** A call's note can be changed by whoever made the call, and by admins. */
export const canEditNote = (ctx, call) => ctx.isAdmin || call.user_id === ctx.user.id;

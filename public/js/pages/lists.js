// Call lists (campaigns): the lists, one list's leads, and the dialer that goes through a list lead by lead.
import { startCall } from '../call.js';
import { canEditNote, noteDialog, snoozeButton } from '../followup.js';
import { bestPhone, leadPanel } from '../lead.js';
import { editLeadDialog } from '../leadedit.js';
import { logCallDialog } from '../logcall.js';
import { sheetListDialog } from '../newlist.js';
import {
  api, badge, busy, confirmDialog, empty, exportButton, field, fill, fmt, h, icon, meter, openModal, outcomeBadge, pageHead, stageBadge, toast,
} from '../ui.js';

function newListDialog(ctx) {
  const name = h('input', { type: 'text', placeholder: 'e.g. Florida flooring – batch 2' });
  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      const { id } = await api('/lists', { method: 'POST', body: { name: name.value } });
      modal.close();
      ctx.navigate(`#/list/${id}`);
    }),
  }, 'Create list');
  const modal = openModal({
    title: 'New call list',
    body: [field('Name', name), h('p', { class: 'muted small' }, 'Add leads from the Leads page: filter, then "Add all matching to a call list".')],
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save],
  });
}

export async function renderLists(root, params, ctx, isCurrent) {
  const { lists } = await api('/lists');
  if (!isCurrent()) return;
  root.replaceChildren(
    pageHead('Call lists', 'Group leads into campaigns and dial through them one by one.', [
      // Importing is for admins, so the upload is too.
      ctx.isAdmin && h('button', { class: 'btn secondary', type: 'button', onclick: () => sheetListDialog(ctx) }, icon('sheet'), 'New list from Excel'),
      h('button', { class: 'btn', type: 'button', onclick: () => newListDialog(ctx) }, icon('plus'), 'New list'),
    ]),
    lists.length
      ? h('div', { class: 'list-grid' }, lists.map((l) => {
        const called = l.total - l.never_called;
        return h('article', { class: 'card list-card' },
          h('div', {},
            h('a', { class: 'list-name', href: `#/list/${l.id}` }, l.name),
            h('div', { class: 'muted small' }, `${fmt.date(l.created_at)}${l.created_by_name ? ` · ${l.created_by_name}` : ''}`)),
          h('div', { class: 'list-stats' },
            [['Leads', l.total], ['No call logged', l.never_called], ['Logged today', l.called_today]].map(([label, value]) =>
              h('div', {}, h('strong', {}, fmt.num(value)), h('span', { class: 'muted small' }, label)))),
          h('div', {}, meter(called, l.total, { goal: false }), h('div', { class: 'muted small section-gap-sm' }, `${fmt.num(called)} of ${fmt.num(l.total)} have a logged call`)),
          h('div', { class: 'row' },
            h('a', { class: 'btn call', href: `#/dial/${l.id}` }, icon('play', 14), 'Start dialing'),
            h('a', { class: 'btn secondary', href: `#/list/${l.id}` }, 'Open list')));
      }))
      : empty(ctx.isAdmin
        ? 'No call lists yet. "New list from Excel" makes one from a spreadsheet, or use "New list" for an empty one.'
        : 'No call lists yet. Use "New list" to make one.'),
  );
}

const LIST_VIEWS = [
  ['all', 'All', () => true],
  ['note', 'Called in Zoom, no note', (c) => c.zoom],
  ['followup', 'Has a follow-up', (c) => c.task],
  ['never', 'Not called yet', (c) => !c.attempts && !c.zoom],
  ['nophone', 'No phone number', (c) => !bestPhone(c, c)],
];
// Views for things to put right: they only show up while some lead needs it.
const FIX_VIEWS = new Set(['note', 'nophone']);

/** Finds a lead by name, company or place, or by any part of a number however it is written. */
function matchesSearch(c, text) {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  return [fmt.name(c), c.job_title, c.company_name, c.city, c.state].join(' ').toLowerCase().includes(q)
    || (digits.length >= 3 && [c.mobile_e164, c.direct_e164, c.hq_phone_e164].some((number) => number?.includes(digits)));
}

// What happened last: a Zoom call nobody has recorded, the latest outcome, and the latest note.
function lastCallCell(ctx, c, onChange) {
  const max = ctx.meta.settings.max_attempts;
  const note = c.last_note;
  const noNoteOn = c.last_call && !c.last_call.notes && c.last_call;
  const noteButton = (call, children, className) => h('button', { class: className, type: 'button', title: call.notes || null, onclick: () => noteDialog(call, onChange) }, children);
  return h('td', { class: 'wrap last-call' },
    c.zoom && h('div', { class: 'row' }, badge('Called in Zoom', 'warn'), h('span', { class: 'sub' }, `${fmt.ago(c.zoom.start_time)} · ${c.zoom.duration ? fmt.span(c.zoom.duration) : 'not answered'} · no note yet`)),
    c.last_called_at && h('div', { class: 'row' }, outcomeBadge(ctx, c.last_disposition), h('span', { class: 'sub' }, `${fmt.ago(c.last_called_at)} · ${c.attempts} of ${max} attempts`)),
    !c.zoom && !c.last_called_at && h('span', { class: 'muted' }, 'Not called yet'),
    note && (canEditNote(ctx, note)
      ? noteButton(note, note.notes, 'note-line')
      : h('div', { class: 'note-line', title: note.notes }, note.notes)),
    noNoteOn && canEditNote(ctx, noNoteOn) && noteButton(noNoteOn, [icon('note', 12), 'Add note'], 'link-btn'));
}

// What is next: the soonest open call task, which can be snoozed.
function nextStepCell(ctx, c, onChange) {
  if (!c.task) return h('td', { class: 'muted' }, '—');
  const late = Date.parse(c.task.due_at) < Date.now();
  return h('td', { class: 'next-step' },
    h('div', {}, fmt.dateTime(c.task.due_at), late && [' ', badge('Late', 'warn')]),
    h('div', { class: 'sub' }, c.task.title),
    snoozeButton(ctx, c.task, onChange));
}

export async function renderList(root, { id }, ctx, isCurrent) {
  let { list, contacts } = await api(`/lists/${id}`);
  if (!isCurrent()) return;
  const state = { q: '', view: 'all' };
  const subtitle = h('span', {});
  const chips = h('div', { class: 'chips' });
  const tableBox = h('div', {});

  // Redraws only the table, so the search, the chosen view and the scroll position stay where they were.
  const refresh = async () => {
    const data = await api(`/lists/${id}`);
    if (!isCurrent()) return;
    ({ list, contacts } = data);
    draw();
  };
  const reload = () => ctx.rerender();

  function row(c) {
    const phone = bestPhone(c, c);
    const blocked = Boolean(c.do_not_call || c.company_dnc);
    return h('tr', {},
      h('td', { class: 'title-cell' },
        h('a', { href: `#/contact/${c.id}` }, fmt.name(c)),
        h('div', { class: 'sub' }, h('a', { class: 'plain', href: `#/company/${c.company_id}` }, c.company_name)),
        h('div', { class: 'sub' }, [c.job_title, [c.city, c.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')),
        h('button', {
          class: 'link-btn',
          type: 'button',
          title: 'Change their name, email, phone numbers or company',
          'aria-label': `Edit ${fmt.name(c)}`,
          onclick: () => editLeadDialog({ contactId: c.id, onSaved: refresh }),
        }, icon('note', 12), 'Edit')),
      h('td', { class: 'number' }, phone ? fmt.phone(phone) : h('span', {}, '— ', badge('No number', 'warn')), blocked && h('div', {}, badge('Do Not Call', 'missed')), c.stage && h('div', { class: 'row-gap' }, stageBadge(ctx, c.stage))),
      lastCallCell(ctx, c, refresh),
      nextStepCell(ctx, c, refresh),
      h('td', { class: 'actions' }, h('div', { class: 'row end nowrap' },
        phone && h('button', {
          class: `btn small${c.zoom ? '' : ' secondary'}`,
          type: 'button',
          title: 'Record a call you made in Zoom: outcome, note and reminder',
          onclick: () => logCallDialog(ctx, { contactId: c.id, listId: list.id, zoom: c.zoom, onDone: refresh }),
        }, icon('note', 14), c.zoom ? 'Add note' : 'Log call'),
        phone && h('button', {
          class: 'btn small call',
          type: 'button',
          disabled: blocked,
          onclick: () => startCall(ctx, { contactId: c.id, phone, listId: list.id, onDone: refresh }),
        }, icon('phone', 14), 'Call'),
        h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Remove from this list',
          'aria-label': `Remove ${fmt.name(c)} from this list`,
          onclick: (event) => busy(event.currentTarget, async () => {
            await api(`/lists/${list.id}/remove`, { method: 'POST', body: { contactIds: [c.id] } });
            toast('Removed from the list.');
            await refresh();
          }),
        }, icon('x', 14)))));
  }

  function draw() {
    subtitle.textContent = `${fmt.num(contacts.length)} leads · ${fmt.num(contacts.filter((c) => c.attempts).length)} with a logged call`;
    fill(chips, LIST_VIEWS.map(([key, label, test]) => {
      const count = contacts.filter(test).length;
      if (FIX_VIEWS.has(key) && !count && state.view !== key) return null;
      return h('button', {
        class: `chip${state.view === key ? ' on' : ''}`,
        type: 'button',
        'aria-pressed': String(state.view === key),
        onclick: () => {
          state.view = key;
          draw();
        },
      }, label, h('span', { class: 'count' }, fmt.num(count)));
    }));
    const test = LIST_VIEWS.find(([key]) => key === state.view)[2];
    const shown = contacts.filter((c) => test(c) && matchesSearch(c, state.q));
    fill(tableBox, contacts.length === 0
      ? empty('This list is empty. Add leads from the Leads page.')
      : shown.length === 0
        ? empty('No leads match.')
        : h('section', { class: 'card panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Lead'), h('th', {}, 'Phone'), h('th', {}, 'Last call and note'), h('th', {}, 'Next step'), h('th', {}))),
          h('tbody', {}, shown.map(row))))));
  }

  const rename = h('button', {
    class: 'btn ghost',
    type: 'button',
    onclick: () => {
      const name = h('input', { type: 'text', value: list.name });
      const save = h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => busy(save, async () => {
          await api(`/lists/${list.id}`, { method: 'PATCH', body: { name: name.value } });
          modal.close();
          reload();
        }),
      }, 'Save');
      const modal = openModal({ title: 'Rename list', body: field('Name', name), footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save] });
    },
  }, 'Rename');

  const remove = h('button', {
    class: 'btn ghost',
    type: 'button',
    onclick: async () => {
      if (!(await confirmDialog({ title: `Delete "${list.name}"?`, message: 'The leads stay in the CRM; only the list is deleted.', confirm: 'Delete list', danger: true }))) return;
      await busy(remove, async () => {
        await api(`/lists/${list.id}`, { method: 'DELETE' });
        ctx.navigate('#/lists');
      });
    },
  }, icon('trash'), 'Delete');

  root.replaceChildren(
    pageHead(list.name, subtitle, [
      exportButton(`/lists/${list.id}/export`),
      rename,
      remove,
      h('a', { class: 'btn call', href: `#/dial/${list.id}` }, icon('play'), 'Start dialing'),
    ], ['Call lists', '#/lists']),
    h('div', { class: 'list-tools' },
      h('div', { class: 'searchbar' }, icon('search'), h('input', {
        type: 'search',
        placeholder: 'Find a number, name or company in this list',
        'aria-label': 'Find in this list',
        oninput: (event) => {
          state.q = event.target.value;
          draw();
        },
      })),
      chips),
    tableBox,
  );
  draw();

  // Coming back from dialing in Zoom: fetch Zoom's latest calls, so the call just made shows up here.
  const pullZoom = () => api('/zoom/sync', { method: 'POST' }).then(refresh).catch(() => {});
  const onFocus = () => {
    if (!isCurrent()) return window.removeEventListener('focus', onFocus);
    pullZoom();
  };
  window.addEventListener('focus', onFocus);
  pullZoom();
}

/** Goes through a list lead by lead: call, save the outcome, and the next lead loads automatically. */
export async function renderDialer(root, { id }, ctx, isCurrent) {
  const { list } = await api(`/lists/${id}`);
  if (!isCurrent()) return;
  const view = h('div', { class: 'stack' }, h('div', { class: 'loading-state' }, 'Finding the next lead…'));
  const progress = h('span', { class: 'muted' });
  const progressBar = h('div', { class: 'dial-progress' });
  let currentId = null;

  async function show(contactId, counts) {
    const detail = await api(`/contacts/${contactId}`);
    if (!isCurrent()) return;
    currentId = contactId;
    if (counts) {
      progress.textContent = `${fmt.num(counts.remaining)} of ${fmt.num(counts.total)} leads ready to call today`;
      progressBar.replaceChildren(meter(counts.total - counts.remaining, counts.total, { goal: false }));
    }
    view.replaceChildren(leadPanel(ctx, detail, {
      onEdit: () => show(contactId),
      onCall: (phone) => startCall(ctx, {
        contactId,
        phone,
        listId: list.id,
        onDone: (result) => (result?.discarded ? show(contactId) : advance()),
      }),
    }));
  }

  async function advance() {
    const next = await api(`/lists/${list.id}/next${currentId ? `?after=${currentId}` : ''}`);
    if (!isCurrent()) return;
    if (!next.contactId) {
      currentId = null;
      progress.textContent = `0 of ${fmt.num(next.total)} leads ready to call`;
      view.replaceChildren(h('section', { class: 'card panel empty-state' },
        h('h2', {}, 'Nothing left to dial in this list right now'),
        h('p', { class: 'muted' }, 'Everyone has been called today, is on Do Not Call, has no working number, or reached the attempt limit.'),
        h('div', { class: 'row center' }, h('a', { class: 'btn secondary', href: `#/list/${list.id}` }, 'See the list'), h('a', { class: 'btn', href: '#/today' }, 'Go to Today'))));
      return;
    }
    await show(next.contactId, next);
  }

  const skip = h('button', { class: 'btn secondary', type: 'button', onclick: () => busy(skip, advance) }, icon('skip'), 'Skip');
  const logCall = h('button', {
    class: 'btn secondary',
    type: 'button',
    title: 'Record a call you made in Zoom',
    onclick: () => currentId && logCallDialog(ctx, { contactId: currentId, listId: list.id, onDone: () => advance() }),
  }, icon('note'), 'Log call');
  root.replaceChildren(
    pageHead(`Dialing · ${list.name}`, progress, [logCall, skip, h('a', { class: 'btn ghost', href: `#/list/${list.id}` }, 'End session')], ['Call lists', '#/lists']),
    progressBar,
    view,
  );
  await advance();
}

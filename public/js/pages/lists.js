// Call lists (campaigns): the lists, one list's leads, and the dialer that goes through a list lead by lead.
import { startCall } from '../call.js';
import { bestPhone, leadPanel } from '../lead.js';
import {
  api, badge, busy, confirmDialog, empty, exportButton, field, fmt, h, icon, meter, openModal, outcomeBadge, pageHead, stageBadge, toast,
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
            [['Leads', l.total], ['Never called', l.never_called], ['Called today', l.called_today]].map(([label, value]) =>
              h('div', {}, h('strong', {}, fmt.num(value)), h('span', { class: 'muted small' }, label)))),
          h('div', {}, meter(called, l.total, { goal: false }), h('div', { class: 'muted small section-gap-sm' }, `${fmt.num(called)} of ${fmt.num(l.total)} called at least once`)),
          h('div', { class: 'row' },
            h('a', { class: 'btn call', href: `#/dial/${l.id}` }, icon('play', 14), 'Start dialing'),
            h('a', { class: 'btn secondary', href: `#/list/${l.id}` }, 'Open list')));
      }))
      : empty('No call lists yet. Importing a spreadsheet can create one, or use "New list".'),
  );
}

export async function renderList(root, { id }, ctx, isCurrent) {
  const { list, contacts } = await api(`/lists/${id}`);
  if (!isCurrent()) return;
  const reload = () => ctx.rerender();
  const max = ctx.meta.settings.max_attempts;
  const neverCalled = contacts.filter((c) => !c.attempts).length;

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
    pageHead(list.name, `${fmt.num(contacts.length)} leads · ${fmt.num(neverCalled)} never called`, [
      exportButton(`/lists/${list.id}/export`),
      rename,
      remove,
      h('a', { class: 'btn call', href: `#/dial/${list.id}` }, icon('play'), 'Start dialing'),
    ], ['Call lists', '#/lists']),
    contacts.length
      ? h('section', { class: 'card panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', { class: 'num' }, '#'), h('th', {}, 'Contact'), h('th', {}, 'Company'), h('th', {}, 'Phone'), h('th', {}, 'Stage'),
          h('th', {}, 'Last outcome'), h('th', { class: 'num' }, 'Attempts'), h('th', {}, 'Last called'), h('th', {}))),
        h('tbody', {}, contacts.map((c, i) => {
          const phone = bestPhone(c, c);
          const blocked = Boolean(c.do_not_call || c.company_dnc);
          return h('tr', {},
            h('td', { class: 'num muted' }, i + 1),
            h('td', { class: 'title-cell' }, h('a', { href: `#/contact/${c.id}` }, fmt.name(c)), h('div', { class: 'sub' }, c.job_title || '')),
            h('td', { class: 'title-cell' }, h('a', { href: `#/company/${c.company_id}` }, c.company_name), h('div', { class: 'sub' }, [c.city, c.state].filter(Boolean).join(', '))),
            h('td', { class: 'number' }, phone ? fmt.phone(phone) : '—', blocked && h('div', {}, badge('Do Not Call', 'missed'))),
            h('td', {}, c.stage && stageBadge(ctx, c.stage)),
            h('td', {}, c.last_disposition ? outcomeBadge(ctx, c.last_disposition) : h('span', { class: 'muted' }, 'Never called')),
            h('td', { class: 'num' }, c.attempts >= max ? badge(`${c.attempts}/${max}`, 'missed') : c.attempts),
            h('td', { class: 'time' }, c.last_called_at ? fmt.ago(c.last_called_at) : '—'),
            h('td', { class: 'actions' }, h('div', { class: 'row end nowrap' },
              phone && h('button', {
                class: 'btn small call',
                type: 'button',
                disabled: blocked,
                onclick: () => startCall(ctx, { contactId: c.id, phone, listId: list.id, onDone: reload }),
              }, icon('phone', 14), 'Call'),
              h('button', {
                class: 'icon-btn',
                type: 'button',
                title: 'Remove from this list',
                'aria-label': `Remove ${fmt.name(c)} from this list`,
                onclick: (event) => busy(event.currentTarget, async () => {
                  await api(`/lists/${list.id}/remove`, { method: 'POST', body: { contactIds: [c.id] } });
                  toast('Removed from the list.');
                  reload();
                }),
              }, icon('x', 14)))));
        })))))
      : empty('This list is empty. Add leads from the Leads page.'),
  );
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
  root.replaceChildren(
    pageHead(`Dialing · ${list.name}`, progress, [skip, h('a', { class: 'btn ghost', href: `#/list/${list.id}` }, 'End session')], ['Call lists', '#/lists']),
    progressBar,
    view,
  );
  await advance();
}

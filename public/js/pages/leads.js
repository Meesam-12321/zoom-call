// Leads: search and filter contacts or companies, call them, add them to call lists, assign owners, export to Excel.
import { startCall } from '../call.js';
import { bestPhone } from '../lead.js';
import {
  api, badge, busy, debounce, fill, empty, exportButton, field, fmt, h, icon, openModal, outcomeBadge, pageHead, select, stageBadge, tabs, toast,
} from '../ui.js';

const FILTERS = ['q', 'state', 'stage', 'disposition', 'lastCalled', 'priority', 'owner', 'dnc', 'sort'];
const SORTS = {
  contacts: [['company', 'Company A–Z'], ['priority', 'Priority'], ['name', 'Name'], ['last_called', 'Recently called'], ['attempts', 'Most attempts'], ['newest', 'Newest']],
  companies: [['name', 'Name A–Z'], ['priority', 'Priority'], ['city', 'City'], ['last_called', 'Recently called'], ['newest', 'Newest']],
};

export async function render(root, { query }, ctx, isCurrent) {
  const state = { view: query.get('view') === 'companies' ? 'companies' : 'contacts', page: Number(query.get('page')) || 1 };
  for (const key of FILTERS) state[key] = query.get(key) || '';
  const selected = new Set();
  const tableBox = h('div', {});
  const total = h('span', { class: 'muted' });
  const bulk = h('div', { class: 'row' });
  let seq = 0;

  const filterParams = () => {
    const params = new URLSearchParams();
    for (const key of FILTERS) if (state[key]) params.set(key, state[key]);
    return params;
  };
  const exportPath = () => `/${state.view}/export?${filterParams()}`;

  async function load() {
    const params = filterParams();
    if (state.page > 1) params.set('page', state.page);
    history.replaceState(null, '', `#/leads?${new URLSearchParams({ view: state.view, ...Object.fromEntries(params) })}`);
    const mine = ++seq;
    const data = await api(`/${state.view}?${params}`);
    if (mine !== seq || !isCurrent()) return;
    selected.clear();
    updateBulk();
    total.textContent = `${fmt.num(data.total)} ${state.view === 'contacts' ? 'contacts' : 'companies'}`;
    const table = state.view === 'contacts' ? contactsTable(ctx, data.rows, selected, updateBulk) : companiesTable(ctx, data.rows, selected, updateBulk);
    fill(tableBox, data.rows.length ? table : empty('No leads match these filters.'), pager(data, (page) => {
      state.page = page;
      load();
    }));
  }

  function updateBulk() {
    const count = selected.size;
    const contactsView = state.view === 'contacts';
    fill(bulk, 
      count ? h('span', { class: 'muted' }, `${count} selected`) : null,
      count ? h('button', {
        class: 'btn small secondary',
        type: 'button',
        onclick: () => addToListDialog(ctx, contactsView ? { contactIds: [...selected] } : { companyIds: [...selected] }),
      }, icon('lists', 14), 'Add to call list') : null,
      !count && contactsView ? h('button', {
        class: 'btn small secondary',
        type: 'button',
        onclick: () => addToListDialog(ctx, { filter: Object.fromEntries(filterParams()) }, total.textContent),
      }, icon('lists', 14), 'Add all matching to a call list') : null,
      count && !contactsView && ctx.isAdmin ? h('button', { class: 'btn small secondary', type: 'button', onclick: () => assignDialog(ctx, [...selected], load) }, 'Assign owner') : null,
    );
  }

  const set = (key) => (event) => {
    state[key] = event.target.value;
    state.page = 1;
    load();
  };
  const search = h('input', { type: 'search', value: state.q, placeholder: 'Name, company, city, phone or email', oninput: debounce(set('q')) });
  const states = [['', 'Any state'], ...Object.entries(ctx.meta.states).map(([code, name]) => [code, name])];
  const outcomes = [['', 'Any outcome'], ['none', 'Never called'], ...ctx.meta.dispositions.map((d) => [d.key, d.label])];

  root.replaceChildren(
    pageHead('Leads', total, [
      exportButton(exportPath),
      h('button', { class: 'btn secondary', type: 'button', onclick: () => newCompanyDialog(ctx) }, icon('plus'), 'New company'),
      h('button', { class: 'btn', type: 'button', onclick: () => newContactDialog(ctx) }, icon('plus'), 'New contact'),
    ]),
    tabs([['contacts', 'Contacts'], ['companies', 'Companies']], state.view, (view) => {
      state.view = view;
      state.page = 1;
      if (!SORTS[view].some(([key]) => key === state.sort)) state.sort = '';
      render(root, { query: new URLSearchParams({ view, ...Object.fromEntries(filterParams()) }) }, ctx, isCurrent);
    }),
    h('div', { class: 'toolbar' },
      h('label', { class: 'field grow' }, h('span', {}, 'Search'), search),
      field('State', select(states, state.state, { onchange: set('state') })),
      field('Stage', select([['', 'Any stage'], ...ctx.meta.stages], state.stage, { onchange: set('stage') })),
      field('Last outcome', select(outcomes, state.disposition, { onchange: set('disposition') })),
      field('Last called', select([['', 'Any time'], ['never', 'Never'], ['today', 'Today'], ['week', 'In the last 7 days'], ['older', 'Over 7 days ago']], state.lastCalled, { onchange: set('lastCalled') })),
      field('Priority', select([['', 'Any'], ['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D']], state.priority, { onchange: set('priority') })),
      ctx.isAdmin && field('Owner', select([['', 'Anyone'], ['none', 'Unassigned'], ...ctx.meta.users.map((u) => [String(u.id), u.name])], state.owner, { onchange: set('owner') })),
      field('Do Not Call', select([['', 'Any'], ['no', 'Callable'], ['yes', 'Do Not Call']], state.dnc, { onchange: set('dnc') })),
      field('Sort', select([['', SORTS[state.view][0][1]], ...SORTS[state.view].slice(1)], state.sort, { onchange: set('sort') }))),
    h('section', { class: 'card panel' }, h('div', { class: 'panel-head' }, bulk), tableBox),
  );
  await load();
}

function checkbox(selected, id, onChange) {
  return h('input', {
    type: 'checkbox',
    'aria-label': 'Select',
    onchange: (event) => {
      if (event.target.checked) selected.add(id);
      else selected.delete(id);
      onChange();
    },
  });
}

function selectAll(selected, rows, onChange) {
  return h('input', {
    type: 'checkbox',
    'aria-label': 'Select all on this page',
    onchange: (event) => {
      for (const box of event.target.closest('table').querySelectorAll('tbody input[type=checkbox]')) box.checked = event.target.checked;
      for (const row of rows) event.target.checked ? selected.add(row.id) : selected.delete(row.id);
      onChange();
    },
  });
}

function callButton(ctx, { contactId, companyId, phone, blocked }) {
  if (!phone) return h('span', { class: 'muted small' }, 'No number');
  return h('button', {
    class: 'btn small call',
    type: 'button',
    disabled: blocked,
    title: blocked ? 'Do Not Call' : `Call ${fmt.phone(phone)}`,
    onclick: () => startCall(ctx, { contactId, companyId, phone, onDone: () => ctx.rerender() }),
  }, icon('phone', 14), 'Call');
}

function contactsTable(ctx, rows, selected, onSelect) {
  const max = ctx.meta.settings.max_attempts;
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'check-col' }, selectAll(selected, rows, onSelect)), h('th', {}, 'Contact'), h('th', {}, 'Company'), h('th', {}, 'Phone'),
      h('th', {}, 'Stage'), h('th', {}, 'Last outcome'), h('th', { class: 'num' }, 'Attempts'), h('th', {}, 'Last called'),
      ctx.isAdmin && h('th', {}, 'Owner'), h('th', {}))),
    h('tbody', {}, rows.map((c) => {
      const phone = bestPhone(c, c);
      const blocked = Boolean(c.do_not_call || c.company_dnc);
      return h('tr', {},
        h('td', {}, checkbox(selected, c.id, onSelect)),
        h('td', { class: 'title-cell' }, h('a', { href: `#/contact/${c.id}` }, fmt.name(c)), h('div', { class: 'sub' }, c.job_title || '')),
        h('td', { class: 'title-cell' }, h('a', { href: `#/company/${c.company_id}` }, c.company_name), h('div', { class: 'sub' }, [c.city, c.state].filter(Boolean).join(', '))),
        h('td', { class: 'number' }, phone ? fmt.phone(phone) : '—', blocked && h('div', {}, badge('Do Not Call', 'missed'))),
        h('td', {}, c.stage && stageBadge(ctx, c.stage)),
        h('td', {}, c.last_disposition ? outcomeBadge(ctx, c.last_disposition) : h('span', { class: 'muted' }, 'Never called')),
        h('td', { class: 'num' }, c.attempts >= max ? badge(`${c.attempts}/${max}`, 'missed') : c.attempts),
        h('td', { class: 'time' }, c.last_called_at ? fmt.ago(c.last_called_at) : '—'),
        ctx.isAdmin && h('td', {}, c.owner_name || h('span', { class: 'muted' }, 'Unassigned')),
        h('td', { class: 'actions' }, callButton(ctx, { contactId: c.id, phone, blocked })));
    }))));
}

function companiesTable(ctx, rows, selected, onSelect) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'check-col' }, selectAll(selected, rows, onSelect)), h('th', {}, 'Company'), h('th', {}, 'HQ phone'), h('th', {}, 'Stage'),
      h('th', {}, 'Priority'), h('th', { class: 'num' }, 'Contacts'), h('th', {}, 'Last outcome'), h('th', {}, 'Last called'),
      ctx.isAdmin && h('th', {}, 'Owner'), h('th', {}))),
    h('tbody', {}, rows.map((c) => h('tr', {},
      h('td', {}, checkbox(selected, c.id, onSelect)),
      h('td', { class: 'title-cell' }, h('a', { href: `#/company/${c.id}` }, c.name), h('div', { class: 'sub' }, [c.city, c.state].filter(Boolean).join(', '))),
      h('td', { class: 'number' }, c.hq_phone_e164 ? fmt.phone(c.hq_phone_e164) : '—', c.do_not_call ? h('div', {}, badge('Do Not Call', 'missed')) : null),
      h('td', {}, c.stage && stageBadge(ctx, c.stage)),
      h('td', {}, c.priority || '—'),
      h('td', { class: 'num' }, c.contact_count),
      h('td', {}, c.last_disposition ? outcomeBadge(ctx, c.last_disposition) : h('span', { class: 'muted' }, 'Never called')),
      h('td', { class: 'time' }, c.last_called_at ? fmt.ago(c.last_called_at) : '—'),
      ctx.isAdmin && h('td', {}, c.owner_name || h('span', { class: 'muted' }, 'Unassigned')),
      h('td', { class: 'actions' }, callButton(ctx, { companyId: c.id, phone: c.hq_phone_e164, blocked: Boolean(c.do_not_call) })))))));
}

function pager({ total, page, pageSize }, go) {
  if (total <= pageSize) return null;
  const pages = Math.ceil(total / pageSize);
  return h('div', { class: 'pager' },
    h('span', {}, `${fmt.num((page - 1) * pageSize + 1)}–${fmt.num(Math.min(page * pageSize, total))} of ${fmt.num(total)}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn small secondary', type: 'button', disabled: page <= 1, onclick: () => go(page - 1) }, icon('back', 14), 'Previous'),
      h('button', { class: 'btn small secondary', type: 'button', disabled: page >= pages, onclick: () => go(page + 1) }, 'Next', icon('next', 14))));
}

export async function addToListDialog(ctx, body, label) {
  const { lists } = await api('/lists');
  const choice = select([['new', 'New list…'], ...lists.map((l) => [String(l.id), `${l.name} (${l.total})`])], lists.length ? String(lists[0].id) : 'new');
  const name = h('input', { type: 'text', placeholder: 'e.g. Florida flooring – batch 2' });
  const nameField = field('New list name', name);
  const toggle = () => {
    nameField.hidden = choice.value !== 'new';
  };
  choice.addEventListener('change', toggle);
  toggle();
  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      const listId = choice.value === 'new' ? (await api('/lists', { method: 'POST', body: { name: name.value } })).id : Number(choice.value);
      const { added } = await api(`/lists/${listId}/add`, { method: 'POST', body });
      modal.close();
      toast(`Added ${added} contact${added === 1 ? '' : 's'} to the list${added ? '' : ' (they were already on it)'}.`, {
        kind: 'ok',
        action: { label: 'Open list', run: () => ctx.navigate(`#/list/${listId}`) },
      });
    }),
  }, 'Add to list');
  const modal = openModal({
    title: 'Add to a call list',
    body: [label && h('p', { class: 'muted' }, `All ${label} matching the current filters.`), field('Call list', choice), nameField],
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save],
  });
}

function assignDialog(ctx, ids, onDone) {
  const owner = select([['', 'Unassigned'], ...ctx.meta.users.filter((u) => u.active).map((u) => [String(u.id), u.name])], '');
  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      await api('/companies/assign', { method: 'POST', body: { ids, owner_id: owner.value } });
      modal.close();
      toast(`Updated ${ids.length} compan${ids.length === 1 ? 'y' : 'ies'}.`, { kind: 'ok' });
      onDone();
    }),
  }, 'Assign');
  const modal = openModal({
    title: `Assign ${ids.length} compan${ids.length === 1 ? 'y' : 'ies'}`,
    body: [h('p', { class: 'muted' }, 'Callers only see the leads they own.'), field('Owner', owner)],
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save],
  });
}

function newCompanyDialog(ctx) {
  const inputs = {
    name: h('input', { type: 'text', required: true }),
    hq_phone: h('input', { type: 'text', placeholder: '(813) 555-0123' }),
    website: h('input', { type: 'text' }),
    city: h('input', { type: 'text' }),
    state: select([['', '—'], ...Object.entries(ctx.meta.states)], 'FL'),
  };
  const owner = ctx.isAdmin && select([['', 'Unassigned'], ...ctx.meta.users.filter((u) => u.active).map((u) => [String(u.id), u.name])], '');
  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      const body = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
      if (owner) body.owner_id = owner.value;
      const { id } = await api('/companies', { method: 'POST', body });
      modal.close();
      ctx.navigate(`#/company/${id}`);
    }),
  }, 'Create company');
  const modal = openModal({
    title: 'New company',
    body: h('div', { class: 'form-grid' },
      h('div', { class: 'wide' }, field('Company name', inputs.name)),
      field('HQ phone', inputs.hq_phone), field('Website', inputs.website), field('City', inputs.city), field('State', inputs.state),
      owner && field('Owner', owner)),
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save],
  });
}

/** Company picker: contacts must belong to a company that already exists (no free-text company names). */
export function companyPicker(onPick) {
  const results = h('select', { size: 5, 'aria-label': 'Matching companies' });
  const search = h('input', {
    type: 'search',
    placeholder: 'Type to search companies',
    oninput: debounce(async () => {
      const { rows } = await api(`/companies/search?q=${encodeURIComponent(search.value)}`);
      results.replaceChildren(...rows.map((c) => h('option', { value: c.id }, [c.name, [c.city, c.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))));
      if (rows.length) {
        results.value = String(rows[0].id);
        onPick(rows[0].id);
      }
    }, 200),
  });
  results.addEventListener('change', () => onPick(Number(results.value)));
  search.dispatchEvent(new Event('input'));
  return h('div', { class: 'stack' }, search, results);
}

function newContactDialog(ctx, companyId = null) {
  let picked = companyId;
  const inputs = {
    first_name: h('input', { type: 'text' }),
    last_name: h('input', { type: 'text' }),
    job_title: h('input', { type: 'text' }),
    email: h('input', { type: 'email' }),
    mobile: h('input', { type: 'text' }),
    direct_line: h('input', { type: 'text' }),
    role_type: select(ctx.meta.roleTypes, 'other'),
  };
  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      if (!picked) throw new Error('Pick the company this contact works at.');
      const body = { company_id: picked, ...Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])) };
      const { id } = await api('/contacts', { method: 'POST', body });
      modal.close();
      ctx.navigate(`#/contact/${id}`);
    }),
  }, 'Create contact');
  const modal = openModal({
    title: 'New contact',
    body: h('div', { class: 'form-grid' },
      !companyId && h('div', { class: 'wide' }, field('Company', companyPicker((id) => { picked = id; }))),
      field('First name', inputs.first_name), field('Last name', inputs.last_name),
      field('Job title', inputs.job_title), field('Role', inputs.role_type),
      field('Email', inputs.email), field('Mobile', inputs.mobile), field('Direct line', inputs.direct_line)),
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save],
  });
}

export { newContactDialog };

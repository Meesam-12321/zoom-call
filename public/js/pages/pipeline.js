// Pipeline: a board (drag cards between stages) and a list view. Moving a lead to Lost asks for the reason.
import { api, fill, debounce, empty, exportButton, field, fmt, h, openModal, pageHead, select, tabs, toast } from '../ui.js';

function lostReasonDialog(ctx, deal) {
  return new Promise((resolve) => {
    const reason = select([['', 'Choose a reason…'], ...ctx.meta.lostReasons.map((r) => [r, r])], '');
    let result = null;
    const save = h('button', {
      class: 'btn danger',
      type: 'button',
      onclick: () => {
        if (!reason.value) return toast('Choose why the lead is lost.', { kind: 'warn' });
        result = reason.value;
        modal.close();
      },
    }, 'Mark lost');
    const modal = openModal({
      title: `Mark ${deal.company_name} as lost`,
      body: field('Lost reason', reason),
      footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save],
      onClose: () => resolve(result),
    });
  });
}

async function moveDeal(ctx, deal, stage) {
  const body = { stage };
  if (stage === 'lost') {
    body.lost_reason = await lostReasonDialog(ctx, deal);
    if (!body.lost_reason) return false;
  }
  try {
    await api(`/deals/${deal.id}`, { method: 'PATCH', body });
    toast(`${deal.company_name} moved to ${Object.fromEntries(ctx.meta.stages)[stage]}.`, { kind: 'ok' });
    return true;
  } catch (error) {
    toast(error.message, { kind: 'error' });
    return false;
  }
}

function card(ctx, deal) {
  const el = h('article', {
    class: 'deal-card',
    draggable: 'true',
    ondragstart: (event) => {
      event.dataTransfer.setData('text/plain', String(deal.id));
      el.classList.add('dragging');
    },
    ondragend: () => el.classList.remove('dragging'),
  },
  h('a', { href: `#/company/${deal.company_id}` }, deal.company_name),
  h('div', { class: 'sub' }, [fmt.name(deal) !== 'Unnamed contact' && fmt.name(deal), [deal.city, deal.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')),
  deal.value ? h('div', {}, fmt.money(deal.value)) : null,
  deal.next_step && h('div', { class: 'sub' }, `Next: ${deal.next_step}${deal.next_step_date ? ` (${deal.next_step_date})` : ''}`),
  deal.lost_reason && deal.stage === 'lost' && h('div', { class: 'sub' }, `Lost: ${deal.lost_reason}`),
  h('div', { class: 'sub' }, [deal.last_called_at ? `Called ${fmt.ago(deal.last_called_at)}` : 'Never called', ctx.isAdmin && deal.owner_name].filter(Boolean).join(' · ')));
  return el;
}

export async function render(root, { query }, ctx, isCurrent) {
  const view = query.get('view') === 'list' ? 'list' : 'board';
  const owner = ctx.isAdmin ? query.get('owner') || '' : '';
  const q = query.get('q') || '';
  const params = new URLSearchParams({ ...(owner && { owner }), ...(q && { q }) });
  const { deals } = await api(`/deals?${params}`);
  if (!isCurrent()) return;

  const go = (changes) => ctx.navigate(`#/pipeline?${new URLSearchParams({ view, ...(owner && { owner }), ...(q && { q }), ...changes })}`);
  const search = h('input', { type: 'search', value: q, placeholder: 'Company name', oninput: debounce((event) => go({ q: event.target.value }), 400) });
  const total = deals.filter((d) => !['lost'].includes(d.stage)).reduce((sum, d) => sum + (d.value || 0), 0);

  const board = () => h('div', { class: 'kanban' }, ctx.meta.stages.map(([stage, label]) => {
    const items = deals.filter((d) => d.stage === stage);
    const value = items.reduce((sum, d) => sum + (d.value || 0), 0);
    const column = h('section', {
      class: 'kanban-col',
      'aria-label': label,
      ondragover: (event) => {
        event.preventDefault();
        column.classList.add('drop');
      },
      ondragleave: () => column.classList.remove('drop'),
      ondrop: async (event) => {
        event.preventDefault();
        column.classList.remove('drop');
        const deal = deals.find((d) => d.id === Number(event.dataTransfer.getData('text/plain')));
        if (deal && deal.stage !== stage && (await moveDeal(ctx, deal, stage))) ctx.rerender();
      },
    },
    h('div', { class: 'kanban-head' }, h('h2', {}, label, h('span', { class: 'count' }, items.length)), value ? h('span', { class: 'muted small' }, fmt.money(value)) : null),
    h('div', { class: 'kanban-cards' }, items.slice(0, 200).map((deal) => card(ctx, deal))));
    return column;
  }));

  const list = () => (deals.length
    ? h('section', { class: 'card panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Company'), h('th', {}, 'Primary contact'), h('th', {}, 'Stage'), h('th', { class: 'num' }, 'Value'),
        h('th', {}, 'Next step'), h('th', {}, 'Last called'), ctx.isAdmin && h('th', {}, 'Owner'))),
      h('tbody', {}, deals.map((deal) => {
        const stage = select(ctx.meta.stages, deal.stage, {
          'aria-label': `Stage for ${deal.company_name}`,
          onchange: async () => {
            if (await moveDeal(ctx, deal, stage.value)) ctx.rerender();
            else stage.value = deal.stage;
          },
        });
        return h('tr', {},
          h('td', { class: 'title-cell' }, h('a', { href: `#/company/${deal.company_id}` }, deal.company_name), h('div', { class: 'sub' }, [deal.city, deal.state].filter(Boolean).join(', '))),
          h('td', {}, deal.primary_contact_id ? h('a', { href: `#/contact/${deal.primary_contact_id}` }, fmt.name(deal)) : '—'),
          h('td', {}, stage, deal.stage === 'lost' && deal.lost_reason ? h('div', { class: 'sub' }, deal.lost_reason) : null),
          h('td', { class: 'num' }, deal.value ? fmt.money(deal.value) : '—'),
          h('td', { class: 'wrap' }, deal.next_step || '—', deal.next_step_date ? h('div', { class: 'sub' }, deal.next_step_date) : null),
          h('td', { class: 'time' }, deal.last_called_at ? fmt.ago(deal.last_called_at) : '—'),
          ctx.isAdmin && h('td', {}, deal.owner_name || '—'));
      })))))
    : empty('No leads in the pipeline yet. Import some on the Import page.'));

  fill(root, 
    pageHead('Pipeline', `${fmt.num(deals.length)} leads · ${fmt.money(total)} open value`, [exportButton(`/deals/export?${params}`)]),
    h('div', { class: 'toolbar' },
      tabs([['board', 'Board'], ['list', 'List']], view, (key) => go({ view: key })),
      h('label', { class: 'field grow' }, h('span', {}, 'Search'), search),
      ctx.isAdmin && field('Owner', select([['', 'Anyone'], ['none', 'Unassigned'], ...ctx.meta.users.map((u) => [String(u.id), u.name])], owner, { onchange: (event) => go({ owner: event.target.value }) }))),
    view === 'board' ? board() : list(),
    view === 'board' && h('p', { class: 'muted small' }, 'Drag a card to another column to change its stage. Call outcomes also move leads automatically.'),
  );
}

// Dashboard: call metrics from logged calls and outcomes, outcome breakdown, daily targets and pipeline totals.
import { api, fill, exportButton, field, fmt, h, pageHead, select } from '../ui.js';

const RANGES = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['last_7_days', 'Last 7 days'],
  ['this_month', 'This month'], ['last_month', 'Last month'], ['last_30_days', 'Last 30 days'], ['custom', 'Custom range'],
];

const stat = (label, value, sub) => h('div', { class: 'card stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-sub' }, sub));

function meter(value, target) {
  const share = target ? Math.min(1, value / target) : 0;
  const bar = h('div', {});
  bar.style.width = `${Math.round(share * 100)}%`;
  return h('div', { class: `meter${target && value >= target ? ' done' : ''}`, role: 'img', 'aria-label': target ? `${value} of ${target}` : String(value) }, bar);
}

export async function render(root, { query }, ctx, isCurrent) {
  const state = {
    range: query.get('range') || 'today',
    from: query.get('from') || '',
    to: query.get('to') || '',
    user: ctx.isAdmin ? query.get('user') || '' : '',
    list: query.get('list') || '',
  };
  if (state.range === 'custom' && !(state.from && state.to)) state.range = 'today';
  const params = new URLSearchParams(Object.entries(state).filter(([, v]) => v));

  // Pull the latest Zoom durations first (bounded so a slow Zoom never blocks the page).
  await Promise.race([api('/zoom/sync', { method: 'POST' }).catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
  const [report, { lists }] = await Promise.all([api(`/analytics?${params}`), api('/lists')]);
  if (!isCurrent()) return;

  const go = (changes) => ctx.navigate(`#/dashboard?${new URLSearchParams(Object.entries({ ...state, ...changes }).filter(([, v]) => v))}`);
  const s = report.summary;
  const period = report.range.firstDay === report.range.lastDay ? report.range.firstDay : `${report.range.firstDay} to ${report.range.lastDay}`;
  const fromInput = h('input', { type: 'date', value: state.from || report.range.firstDay });
  const toInput = h('input', { type: 'date', value: state.to || report.range.lastDay });
  const applyCustom = () => fromInput.value && toInput.value && go({ range: 'custom', from: fromInput.value, to: toInput.value });
  fromInput.addEventListener('change', applyCustom);
  toInput.addEventListener('change', applyCustom);

  const notes = [
    s.pendingOutcome && `${s.pendingOutcome} call${s.pendingOutcome === 1 ? '' : 's'} still need an outcome.`,
    s.awaitingZoom && `${s.awaitingZoom} call${s.awaitingZoom === 1 ? ' has' : 's have'} no Zoom record yet, so ${s.awaitingZoom === 1 ? 'its' : 'their'} duration is missing (Zoom adds it within a few minutes).`,
  ].filter(Boolean);

  fill(root, 
    pageHead('Dashboard', `${RANGES.find(([key]) => key === report.range.preset)?.[1] || report.range.label} · ${period}`, [exportButton(`/analytics/export?${params}`, 'Export report')]),
    h('div', { class: 'toolbar' },
      field('Period', select(RANGES, state.range, { onchange: (event) => (event.target.value === 'custom' ? applyCustom() : go({ range: event.target.value, from: '', to: '' })) })),
      state.range === 'custom' && [field('From', fromInput), field('To', toInput)],
      ctx.isAdmin && field('Caller', select([['', 'All callers'], ...ctx.meta.users.map((u) => [String(u.id), u.name])], state.user, { onchange: (event) => go({ user: event.target.value }) })),
      field('Call list', select([['', 'All calls'], ...lists.map((l) => [String(l.id), l.name])], state.list, { onchange: (event) => go({ list: event.target.value }) }))),
    notes.length ? h('div', { class: 'note' }, notes.join(' ')) : null,
    h('section', { class: 'stats', 'aria-label': 'Call summary' },
      stat('Total calls', fmt.num(s.totalCalls), 'Every call dialed from the CRM'),
      stat('Calls picked up', fmt.num(s.pickedUp), 'Outcome counts as connected'),
      stat('Connect rate', fmt.pct(s.connectRate), `${fmt.num(s.pickedUp)} of ${fmt.num(s.totalCalls)} calls`),
      stat('Total talk time', fmt.span(s.talkTime), 'Sum of Zoom call durations'),
      stat('Average call duration', fmt.span(s.avgDuration), 'Per connected call'),
      stat('Conversations', fmt.num(s.conversations), `Connected calls over ${report.conversationSeconds}s`),
      stat('Meetings booked', fmt.num(s.meetings), 'Positive outcomes with a meeting'),
      stat('Meeting rate', fmt.pct(s.meetingRate), 'Meetings ÷ conversations')),
    h('div', { class: 'split' },
      h('section', { class: 'card panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Outcomes'), h('span', { class: 'muted' }, `${fmt.num(s.totalCalls)} calls`)),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Outcome'), h('th', { class: 'num' }, 'Calls'), h('th', { class: 'num' }, 'Share'), h('th', {}, ''))),
          h('tbody', {}, report.breakdown.map((d) => h('tr', {},
            h('td', {}, d.label, h('div', { class: 'sub' }, d.key ? (d.connected ? 'Counts as connected' : 'Not connected') : '')),
            h('td', { class: 'num' }, fmt.num(d.count)),
            h('td', { class: 'num' }, fmt.pct(d.share)),
            h('td', { class: 'bar-cell' }, meter(d.count, Math.max(1, s.totalCalls))))))))),
      h('div', { class: 'stack' },
        h('section', { class: 'card panel' },
          h('div', { class: 'panel-head' }, h('h2', {}, 'Daily targets'), h('span', { class: 'muted' }, 'Today')),
          report.targets.length
            ? report.targets.map((t) => h('div', { class: 'block' },
              h('h3', {}, t.name),
              [['Calls', t.calls], ['Conversations', t.conversations], ['Meetings', t.meetings]].map(([label, [done, target]]) => h('div', { class: 'block' },
                h('div', { class: 'row' }, h('span', {}, label), h('span', { class: 'muted' }, target ? `${done} of ${target}` : `${done} (no target set)`)),
                target ? meter(done, target) : null))))
            : h('p', { class: 'muted' }, 'Add callers and their targets in Settings.')),
        h('section', { class: 'card panel' },
          h('div', { class: 'panel-head' }, h('h2', {}, 'Pipeline')),
          h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), h('th', { class: 'num' }, 'Leads'), h('th', { class: 'num' }, 'Value'))),
            h('tbody', {}, report.pipeline.map((p) => h('tr', {},
              h('td', {}, h('a', { href: '#/pipeline?view=list' }, p.label)),
              h('td', { class: 'num' }, fmt.num(p.count)),
              h('td', { class: 'num' }, p.value ? fmt.money(p.value) : '—'))))))))),
  );
}

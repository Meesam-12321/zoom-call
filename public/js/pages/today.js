// Today: what to do next (one big Call button), today's numbers, then overdue tasks, callbacks and tasks due today,
// and leads never called, each one click away from a call.
import { startCall } from '../call.js';
import { bestPhone } from '../lead.js';
import { emailButton } from '../mail.js';
import { api, callStats, fill, badge, busy, empty, exportButton, field, fmt, h, icon, localInput, openModal, pageHead, plural, select, stat, tabs } from '../ui.js';

export async function render(root, { query }, ctx, isCurrent) {
  const view = query.get('view') || 'today';
  const user = ctx.isAdmin ? query.get('user') || 'all' : '';
  const userParam = user ? `user=${user}` : '';
  const data = view === 'today' ? await api(`/today?${userParam}`) : await api(`/tasks?view=${view}&${userParam}`);
  if (!isCurrent()) return;

  const go = (params) => ctx.navigate(`#/today?${new URLSearchParams({ view, ...(user && { user }), ...params })}`);
  const options = { onChange: () => ctx.rerender(), showDate: view !== 'today' };

  const controls = h('div', { class: 'toolbar' },
    tabs([['today', 'Today'], ['upcoming', 'Upcoming'], ['open', 'All open'], ['done', 'Done']], view, (key) => go({ view: key })),
    h('div', { class: 'row toolbar-end' },
      ctx.isAdmin && select([['all', 'All callers'], ...ctx.meta.users.filter((u) => u.active).map((u) => [String(u.id), u.name])], user, {
        'aria-label': 'Caller',
        onchange: (event) => go({ user: event.target.value }),
      }),
      exportButton(`/tasks/export?${userParam}`, 'Export open tasks')));

  if (view !== 'today') {
    fill(root,
      pageHead('Tasks', plural(data.tasks.length, 'task')),
      controls,
      h('section', { class: 'card panel' }, taskTable(ctx, data.tasks, options) || empty('No tasks here.')));
    return;
  }

  const kpis = h('section', { class: 'stats', 'aria-label': "Today's calls" }, [1, 2, 3, 4].map(() => h('div', { class: 'card stat skeleton' })));
  fill(root,
    hero(ctx, data),
    kpis,
    controls,
    data.overdue.length > 0 && section('Overdue', data.overdue.length, taskTable(ctx, data.overdue, { ...options, showDate: true })),
    data.today.length > 0 && section('Due today', data.today.length, taskTable(ctx, data.today, options)),
    section('New leads', data.newLeadsTotal, newLeadsTable(ctx, data.newLeads), 'Every lead has been called at least once.',
      data.newLeadsTotal > data.newLeads.length && h('a', { href: '#/leads?lastCalled=never&sort=priority' }, `See all ${fmt.num(data.newLeadsTotal)}`)),
  );

  // The same numbers as Reports. Zoom can take a moment, so these fill in after the page is up.
  const params = new URLSearchParams({ range: 'today', ...(user && user !== 'all' && { user }) });
  api(`/analytics?${params}`).then(({ summary: s }) => {
    if (isCurrent()) fill(kpis, callStats(s), stat('Meetings booked', fmt.num(s.meetings), 'Positive outcomes with a meeting'));
  }).catch(() => kpis.remove());
}

const greeting = (ctx) => {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: ctx.meta.settings.business_tz }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
};

function hero(ctx, data) {
  const due = data.overdue.length + data.today.length;
  const first = ctx.user.name.split(/\s+/)[0];
  const headline = due ? plural(due, 'task') : data.newLeadsTotal ? plural(data.newLeadsTotal, 'new lead') : null;
  return h('section', { class: 'hero' },
    h('div', { class: 'hero-copy' },
      h('span', { class: 'pill' }, fmt.date(new Date().toISOString())),
      h('h1', { class: 'hero-title' }, `${greeting(ctx)}, ${first}.`, h('br'), headline ? [h('em', {}, headline), due ? ' due today.' : ' to call.'] : 'All caught up.'),
      h('p', { class: 'hero-sub' }, `${fmt.num(data.overdue.length)} overdue · ${fmt.num(data.today.length)} due today · ${fmt.num(data.newLeadsTotal)} leads never called`),
      h('button', { class: 'btn large', type: 'button', onclick: () => ctx.startCalling() }, 'Start calling', h('span', { class: 'arrow' }, icon('arrow')))),
    upNext(ctx, data));
}

/** The one thing to do next: the oldest callable task, else the top lead nobody has called. */
function upNext(ctx, data) {
  const task = [...data.overdue, ...data.today].find((t) => t.type === 'call' && !t.contact_dnc && !t.company_dnc && bestPhone(t.contact_id ? t : null, { hq_phone_e164: t.hq_phone_e164 }));
  const lead = data.newLeads.find((l) => bestPhone(l, l));
  if (!task && !lead) {
    return h('section', { class: 'card focus' },
      h('div', { class: 'eyebrow' }, 'Up next'),
      h('h2', { class: 'focus-name' }, 'Nothing waiting'),
      h('p', { class: 'muted' }, 'No calls are due. Import a sheet or add leads to a call list to fill your day.'),
      h('div', { class: 'focus-foot' }, h('a', { class: 'btn secondary', href: '#/lists' }, 'Open call lists')));
  }
  const company = task ? task.company_name : lead.company_name;
  const contactId = task ? task.contact_id : lead.id;
  const companyId = task ? task.company_id : lead.company_id;
  const person = task ? (task.contact_id ? fmt.name(task) : task.company_name) : fmt.name(lead);
  const phone = task ? bestPhone(task.contact_id ? task : null, { hq_phone_e164: task.hq_phone_e164 }) : bestPhone(lead, lead);
  const zone = task ? task.time_zone : lead.time_zone;
  const reason = task ? (Date.parse(task.due_at) < Date.now() ? (task.is_callback ? 'Callback · late' : 'Task · late') : task.is_callback ? `Callback at ${fmt.time(task.due_at)}` : `Task at ${fmt.time(task.due_at)}`) : 'Never called';
  return h('section', { class: 'card focus', 'aria-label': 'Up next' },
    h('div', {},
      h('div', { class: 'eyebrow' }, `Up next · ${reason}`),
      h('h2', { class: 'focus-name' }, h('a', { href: contactId ? `#/contact/${contactId}` : `#/company/${companyId}` }, person)),
      h('div', { class: 'muted' }, [person !== company && company, task?.title, zone && `Their time: ${fmt.localTime(zone)}`].filter(Boolean).join(' · '))),
    h('div', { class: 'focus-foot' },
      h('span', { class: 'number' }, fmt.phone(phone)),
      h('button', { class: 'btn call large', type: 'button', onclick: () => callLead(ctx, { contactId, companyId, phone }) }, icon('phone'), 'Call now')));
}

function section(title, count, table, emptyText, link) {
  return h('section', { class: 'card panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, title, h('span', { class: 'count' }, fmt.num(count))), link),
    count ? table : h('p', { class: 'muted' }, emptyText));
}

function callLead(ctx, { contactId, companyId, phone }) {
  return startCall(ctx, { contactId, companyId, phone, onDone: () => ctx.rerender() });
}

/** Task rows with Call / Reschedule / Done. On a lead's own page the Lead column is left out (showLead: false). */
export function taskTable(ctx, tasks, { onChange, showDate, showLead = true }) {
  if (!tasks.length) return null;
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Due'), h('th', {}, 'Task'), showLead && h('th', {}, 'Lead'), ctx.isAdmin && h('th', {}, 'Assigned to'), h('th', {}))),
    h('tbody', {}, tasks.map((t) => taskRow(ctx, t, { onChange, showDate, showLead })))));
}

function taskRow(ctx, t, { onChange, showDate, showLead }) {
  const types = Object.fromEntries(ctx.meta.taskTypes);
  const hasContact = Boolean(t.contact_id);
  const phone = bestPhone(hasContact ? t : null, { hq_phone_e164: t.hq_phone_e164 });
  const blocked = t.contact_dnc || t.company_dnc;
  const open = t.status === 'open';
  const late = open && Date.parse(t.due_at) < Date.now();
  const update = (button, body) => busy(button, async () => {
    await api(`/tasks/${t.id}`, { method: 'PATCH', body });
    onChange();
  });

  const done = h('button', { class: 'btn small secondary', type: 'button', title: 'Mark done', onclick: (e) => update(e.currentTarget, { status: 'done' }) }, icon('check', 14), 'Done');
  const reopen = h('button', { class: 'btn small ghost', type: 'button', onclick: (e) => update(e.currentTarget, { status: 'open' }) }, 'Reopen');
  const reschedule = h('button', { class: 'btn small ghost', type: 'button', onclick: () => rescheduleDialog(ctx, t, onChange) }, icon('clock', 14), 'Reschedule');
  const call = t.type === 'call' && phone && !blocked && h('button', {
    class: 'btn small call',
    type: 'button',
    onclick: () => callLead(ctx, { contactId: t.contact_id, companyId: t.company_id, phone }),
  }, icon('phone', 14), 'Call');
  const email = t.type === 'email' && emailButton(ctx, hasContact ? { contactId: t.contact_id } : { companyId: t.company_id }, { small: true });

  return h('tr', {},
    h('td', { class: 'time' }, showDate ? fmt.dateTime(t.due_at) : fmt.time(t.due_at), late && h('div', {}, badge('Late', 'warn'))),
    h('td', { class: 'wrap' },
      h('div', { class: 'row' }, badge(types[t.type] || t.type, 'neutral'), t.is_callback ? badge('Callback', 'info') : null, !open && badge(t.status === 'done' ? 'Done' : 'Canceled', t.status === 'done' ? 'ok' : 'neutral')),
      h('div', {}, t.title)),
    showLead && h('td', { class: 'title-cell' },
      h('a', { href: hasContact ? `#/contact/${t.contact_id}` : `#/company/${t.company_id}` }, hasContact ? fmt.name(t) : t.company_name),
      h('div', { class: 'sub' }, [hasContact && t.company_name, phone && fmt.phone(phone), t.time_zone && fmt.localTime(t.time_zone)].filter(Boolean).join(' · '))),
    ctx.isAdmin && h('td', {}, t.user_name || '—'),
    h('td', { class: 'actions' }, h('div', { class: 'row end' }, open ? [call, email, reschedule, done] : reopen)));
}

function rescheduleDialog(ctx, task, onChange) {
  const input = h('input', { type: 'datetime-local', value: localInput(new Date(task.due_at)) });
  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: { due: input.value } });
      modal.close();
      onChange();
    }),
  }, 'Save');
  const modal = openModal({
    title: 'Reschedule task',
    body: [h('p', {}, task.title), field(`Due (${fmt.zoneName(ctx.meta.settings.business_tz)})`, input)],
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save],
  });
}

function newLeadsTable(ctx, leads) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Lead'), h('th', {}, 'Company'), h('th', {}, 'Priority'), h('th', {}, 'Their time'), h('th', {}))),
    h('tbody', {}, leads.map((lead) => {
      const phone = bestPhone(lead, lead);
      return h('tr', {},
        h('td', { class: 'title-cell' }, h('a', { href: `#/contact/${lead.id}` }, fmt.name(lead)), h('div', { class: 'sub' }, lead.job_title || '')),
        h('td', { class: 'title-cell' }, h('a', { href: `#/company/${lead.company_id}` }, lead.company_name), h('div', { class: 'sub' }, [lead.city, lead.state].filter(Boolean).join(', '))),
        h('td', {}, lead.priority || '—'),
        h('td', { class: 'time' }, fmt.localTime(lead.time_zone)),
        h('td', { class: 'actions' }, phone
          ? h('button', { class: 'btn small call', type: 'button', onclick: () => callLead(ctx, { contactId: lead.id, phone }) }, icon('phone', 14), 'Call')
          : h('span', { class: 'muted small' }, 'No number')));
    }))));
}

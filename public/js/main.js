// CRM entry point: sign-in, the app shell (sidebar + page), hash routing, the pending-outcome banner and reminders.
import { showOutcome } from './call.js';
import { renderAuth } from './pages/auth.js';
import * as dashboard from './pages/dashboard.js';
import * as importer from './pages/import.js';
import * as leads from './pages/leads.js';
import * as lists from './pages/lists.js';
import * as pipeline from './pages/pipeline.js';
import * as record from './pages/record.js';
import * as settings from './pages/settings.js';
import * as today from './pages/today.js';
import * as zoomlog from './pages/zoomlog.js';
import { api, fmt, h, icon, setZone, toast } from './ui.js';

const ROUTES = {
  today: today.render,
  leads: leads.render,
  company: record.renderCompany,
  contact: record.renderContact,
  pipeline: pipeline.render,
  lists: lists.renderLists,
  list: lists.renderList,
  dial: lists.renderDialer,
  dashboard: dashboard.render,
  import: importer.render,
  zoom: zoomlog.render,
  settings: settings.render,
};

// [route, label, icon, admin only]
const NAV = [
  ['today', 'Today', 'today'],
  ['leads', 'Leads', 'leads'],
  ['pipeline', 'Pipeline', 'pipeline'],
  ['lists', 'Call lists', 'lists'],
  ['dashboard', 'Dashboard', 'dashboard'],
  ['zoom', 'Zoom call log', 'zoom'],
  ['import', 'Import', 'import', true],
  ['settings', 'Settings', 'settings'],
];
const ACTIVE = { company: 'leads', contact: 'leads', list: 'lists', dial: 'lists' };

const ctx = {
  meta: null,
  user: null,
  isAdmin: false,
  navigate: (hash) => (location.hash === hash ? route() : (location.hash = hash)),
  rerender: () => route(),
  refreshMeta,
  setPending,
};

let routeSeq = 0;

async function refreshMeta() {
  ctx.meta = await api('/meta');
  ctx.user = ctx.meta.user;
  ctx.isAdmin = ctx.user.role === 'admin';
  setZone(ctx.meta.settings.business_tz);
}

function renderShell() {
  const nav = NAV.filter(([, , , adminOnly]) => !adminOnly || ctx.isAdmin).map(([key, label, iconName]) =>
    h('a', { href: `#/${key}`, 'data-route': key }, icon(iconName, 16), label));
  const initials = ctx.user.name.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('app').replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('phone', 16)), 'Cold-Calling CRM'),
      h('nav', { class: 'nav', 'aria-label': 'Main' }, nav),
      h('div', { class: 'sidebar-foot' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials),
        h('div', { class: 'user-meta' }, h('div', { class: 'user-name', title: ctx.user.name }, ctx.user.name), h('div', { class: 'muted small' }, ctx.isAdmin ? 'Admin' : 'Caller')),
        h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Sign out',
          'aria-label': 'Sign out',
          onclick: async () => {
            await api('/auth/logout', { method: 'POST' }).catch(() => {});
            location.hash = '';
            location.reload();
          },
        }, icon('logout')))),
    h('main', { class: 'main' }, h('div', { id: 'pending', hidden: true }), h('div', { id: 'page' }))));
}

async function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, id] = path.split('/');
  const render = ROUTES[name] || ROUTES.today;
  for (const link of document.querySelectorAll('.nav a')) {
    link.classList.toggle('active', link.dataset.route === (ACTIVE[name] || (ROUTES[name] ? name : 'today')));
  }
  const root = document.getElementById('page');
  const seq = ++routeSeq;
  root.replaceChildren(h('div', { class: 'loading-state' }, 'Loading…'));
  try {
    await render(root, { id, query: new URLSearchParams(query) }, ctx, () => seq === routeSeq);
  } catch (error) {
    if (seq === routeSeq) root.replaceChildren(h('div', { class: 'alert' }, error.message));
  }
}

/** Shows (or hides) the banner for a call that still needs its outcome. */
function setPending(call) {
  const banner = document.getElementById('pending');
  if (!banner) return;
  banner.hidden = !call;
  if (!call) return banner.replaceChildren();
  const who = [call.first_name, call.last_name].filter(Boolean).join(' ') || call.company_name;
  banner.className = 'pending-banner';
  banner.replaceChildren(
    h('span', {}, `Outcome needed for your call to ${who} at ${call.company_name} (${fmt.time(call.started_at)}).`),
    h('button', { class: 'btn small', type: 'button', onclick: () => showOutcome(ctx, call, { onDone: () => ctx.rerender() }) }, 'Enter outcome'));
}

function notify(task) {
  const who = [task.first_name, task.last_name].filter(Boolean).join(' ') || task.company_name;
  const text = `Callback at ${fmt.time(task.due_at)}: ${who}, ${task.company_name}`;
  const href = task.contact_id ? `#/contact/${task.contact_id}` : `#/company/${task.company_id}`;
  toast(text, { kind: 'warn', timeout: 0, action: { label: 'Open', run: () => ctx.navigate(href) } });
  if ('Notification' in window && Notification.permission === 'granted') {
    const note = new Notification('Callback due', { body: text });
    note.onclick = () => {
      window.focus();
      ctx.navigate(href);
    };
  }
}

async function poll() {
  try {
    const { reminders, pending } = await api('/reminders');
    setPending(pending);
    reminders.forEach(notify);
  } catch {
    // Offline for a moment; the next poll retries.
  }
}

async function boot() {
  const state = await api('/auth/state').catch((error) => ({ error }));
  if (state.error) {
    document.getElementById('app').replaceChildren(h('div', { class: 'auth-wrap' }, h('div', { class: 'alert' }, state.error.message)));
    return;
  }
  if (!state.user) return renderAuth(state);
  await refreshMeta();
  renderShell();
  window.addEventListener('hashchange', route);
  await route();
  const { call } = await api('/calls/pending');
  setPending(call);
  if (call) showOutcome(ctx, call, { onDone: () => ctx.rerender() });
  setInterval(poll, 30_000);
  poll();
}

boot();

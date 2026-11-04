// CRM entry point: sign-in, the app shell (top bar + page), search, hash routing, the pending-outcome banner and reminders.
import { showOutcome } from './call.js';
import { snoozeMenu } from './followup.js';
import { openPalette } from './palette.js';
import { renderAuth } from './pages/auth.js';
import * as dashboard from './pages/dashboard.js';
import * as importer from './pages/import.js';
import * as inbox from './pages/inbox.js';
import * as leads from './pages/leads.js';
import * as lists from './pages/lists.js';
import * as pipeline from './pages/pipeline.js';
import * as record from './pages/record.js';
import * as settings from './pages/settings.js';
import * as today from './pages/today.js';
import * as zoomlog from './pages/zoomlog.js';
import { api, fmt, h, icon, logo, setZone, themeButton, toast, toggleTheme } from './ui.js';

const ROUTES = {
  today: today.render,
  leads: leads.render,
  company: record.renderCompany,
  contact: record.renderContact,
  pipeline: pipeline.render,
  lists: lists.renderLists,
  list: lists.renderList,
  dial: lists.renderDialer,
  inbox: inbox.render,
  thread: inbox.renderThread,
  dashboard: dashboard.render,
  import: importer.render,
  zoom: zoomlog.render,
  settings: settings.render,
};

// [route, label, icon, admin only]. Settings lives in the account menu; the Zoom call log is a tab inside Reports.
const NAV = [
  ['today', 'Today', 'today'],
  ['leads', 'Leads', 'leads'],
  ['pipeline', 'Pipeline', 'pipeline'],
  ['lists', 'Call lists', 'lists'],
  ['inbox', 'Inbox', 'inbox', true],
  ['dashboard', 'Reports', 'dashboard'],
  ['import', 'Import', 'import', true],
];
const ACTIVE = { company: 'leads', contact: 'leads', list: 'lists', dial: 'lists', thread: 'inbox', zoom: 'dashboard' };

const ctx = {
  meta: null,
  user: null,
  isAdmin: false,
  navigate: (hash) => (location.hash === hash ? route() : (location.hash = hash)),
  rerender: () => route(),
  refreshMeta,
  setPending,
  startCalling,
};

let routeSeq = 0;

async function refreshMeta() {
  ctx.meta = await api('/meta');
  ctx.user = ctx.meta.user;
  ctx.isAdmin = ctx.user.role === 'admin';
  setZone(ctx.meta.settings.business_tz);
}

/** Opens the dialer on the newest list that still has leads nobody has called. */
async function startCalling() {
  try {
    const { lists } = await api('/lists');
    const list = lists.find((l) => l.never_called > 0) || lists.find((l) => l.total > 0);
    ctx.navigate(list ? `#/dial/${list.id}` : '#/lists');
  } catch (error) {
    toast(error.message, { kind: 'error' });
  }
}

async function signOut() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.hash = '';
  location.reload();
}

async function syncZoom() {
  try {
    const { linked } = await api('/zoom/sync', { method: 'POST' });
    toast(linked ? `Zoom synced: ${linked} call${linked === 1 ? '' : 's'} matched to leads.` : 'Zoom is up to date.', { kind: 'ok' });
  } catch (error) {
    toast(error.message, { kind: 'error' });
  }
}

function search() {
  const go = (hash) => () => ctx.navigate(hash);
  const pages = [...NAV.filter(([, , , adminOnly]) => !adminOnly || ctx.isAdmin), ['zoom', 'Zoom call log', 'zoom'], ['settings', 'Settings', 'settings']]
    .map(([key, label, iconName]) => ({ label, icon: iconName, run: go(`#/${key}`) }));
  openPalette([
    { label: 'Start calling', icon: 'play', run: startCalling },
    ...pages,
    ctx.meta.zoomConfigured && { label: 'Sync Zoom calls now', icon: 'refresh', run: syncZoom },
    { label: 'Switch theme (light / dark)', icon: 'moon', run: toggleTheme },
    { label: 'Sign out', icon: 'logout', run: signOut },
  ].filter(Boolean));
}

/** A menu that closes on the next click anywhere else. */
function popover(trigger, content) {
  const panel = h('div', { class: 'popover', hidden: true }, content);
  const setOpen = (open) => {
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', () => setOpen(panel.hidden));
  panel.addEventListener('click', () => setOpen(false));
  const wrap = h('div', { class: 'popover-wrap' }, trigger, panel);
  document.addEventListener('mousedown', (event) => {
    if (!wrap.contains(event.target)) setOpen(false);
  });
  return wrap;
}

function renderShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
    NAV.filter(([, , , adminOnly]) => !adminOnly || ctx.isAdmin).map(([key, label, iconName]) =>
      h('a', { href: `#/${key}`, 'data-route': key }, icon(iconName, 16), label, key === 'today' && h('span', { class: 'nav-count', id: 'today-count', hidden: true }))));
  nav.addEventListener('click', () => nav.classList.remove('open'));
  const initials = ctx.user.name.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase();
  const shortcut = /mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl K';

  document.getElementById('app').replaceChildren(h('div', { class: 'shell' },
    h('header', { class: 'topbar' },
      h('div', { class: 'topnav' },
        h('a', { class: 'brand', href: '#/today', title: 'Veloq CRM home' }, logo()),
        nav,
        h('div', { class: 'nav-side' },
          h('button', { class: 'search-pill', type: 'button', title: `Search (${shortcut})`, 'aria-label': 'Search', onclick: search }, icon('search', 16), h('span', {}, 'Search'), h('kbd', {}, shortcut)),
          themeButton(),
          h('button', { class: 'btn nav-cta', type: 'button', title: 'Start calling', onclick: startCalling },
            h('span', { class: 'cta-label' }, 'Start calling'), h('span', { class: 'arrow' }, icon('arrow', 16)), h('span', { class: 'cta-icon' }, icon('phone', 16))),
          h('button', { class: 'icon-btn nav-icon menu-toggle', type: 'button', 'aria-label': 'Menu', onclick: () => nav.classList.toggle('open') }, icon('menu', 18)),
          popover(h('button', { class: 'avatar-btn', type: 'button', 'aria-label': `Account: ${ctx.user.name}` }, initials), [
            h('div', { class: 'popover-head' }, h('strong', {}, ctx.user.name), h('span', { class: 'muted small' }, ctx.isAdmin ? 'Admin' : 'Caller')),
            h('a', { class: 'popover-item', href: '#/settings' }, icon('settings'), 'Settings'),
            h('button', { class: 'popover-item', type: 'button', onclick: signOut }, icon('logout'), 'Sign out'),
          ])))),
    h('main', { class: 'main' }, h('div', { id: 'pending', hidden: true }), h('div', { id: 'page' }))));
}

// Ctrl+K / Cmd+K anywhere, or "/" when not typing. Nothing opens over a dialog (call outcomes must be finished first).
function listenForSearch() {
  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
    const wanted = ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') || (event.key === '/' && !typing);
    if (!wanted || document.querySelector('.overlay')) return;
    event.preventDefault();
    search();
  });
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
  toast(text, {
    kind: 'warn',
    timeout: 0,
    actions: [
      { label: 'Open', run: () => ctx.navigate(href) },
      {
        label: 'Snooze',
        keepOpen: true,
        run: (button, el) => snoozeMenu(ctx, button, task, () => {
          el.remove();
          if (/^#\/(today|list\/)/.test(location.hash)) ctx.rerender();
        }),
      },
    ],
  });
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
    const { overdue, today } = await api(`/today${ctx.isAdmin ? '?user=all' : ''}`);
    const count = overdue.length + today.length;
    const badge = document.getElementById('today-count');
    badge.textContent = count;
    badge.hidden = !count;
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
  listenForSearch();
  window.addEventListener('hashchange', route);
  await route();
  const { call } = await api('/calls/pending');
  setPending(call);
  if (call) showOutcome(ctx, call, { onDone: () => ctx.rerender() });
  setInterval(poll, 30_000);
  poll();
}

boot();

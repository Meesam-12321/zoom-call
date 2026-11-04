// DOM, API, formatting and dialog helpers shared by every page. Data is always inserted as text, never as HTML.

const SVG_NS = 'http://www.w3.org/2000/svg';
const PROPS = new Set(['value', 'checked', 'indeterminate']);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (PROPS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/** el.replaceChildren() with h()'s rules: nested arrays are flattened and null / false are skipped. */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
  return el;
}

// Lucide-style 24px stroke icons.
const ICONS = {
  today: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'm9 16 2 2 4-4'],
  leads: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  pipeline: ['M5 3h4v18H5z', 'M10 3h4v12h-4z', 'M15 3h4v8h-4z'],
  lists: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  dashboard: ['M3 3v18h18', 'M18 17V9', 'M13 17V5', 'M8 17v-3'],
  zoom: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  import: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  settings: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  phone: ['M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z'],
  plus: ['M12 5v14', 'M5 12h14'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  search: ['m21 21-4.3-4.3', 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z'],
  skip: ['m5 4 10 8-10 8V4z', 'M19 5v14'],
  back: ['m15 18-6-6 6-6'],
  next: ['m9 18 6-6-6-6'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  clock: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z', 'M12 6v6l4 2'],
  mail: ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'm22 6-10 7L2 6'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
  send: ['m22 2-7 20-4-9-9-4 20-7z', 'M22 2 11 13'],
  reply: ['m9 17-5-5 5-5', 'M20 18v-2a4 4 0 0 0-4-4H4'],
  replyAll: ['m7 17-5-5 5-5', 'm12 17-5-5 5-5', 'M22 18v-2a4 4 0 0 0-4-4H7'],
  clip: ['m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'],
  ban: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z', 'm4.9 4.9 14.2 14.2'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  alert: ['M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  link: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  play: ['m6 3 14 9-14 9V3z'],
  refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
  outbound: ['M7 7h10v10', 'M7 17 17 7'],
  inbound: ['M17 7 7 17', 'M17 17H7V7'],
};

export function icon(name, size = 16) {
  const el = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    el.setAttribute(key, value);
  }
  for (const d of ICONS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    el.append(path);
  }
  return el;
}

// ---------- API

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { 'X-CRM': '1', ...headers } };
  if (body instanceof Blob) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw Object.assign(new Error('Cannot reach the CRM server. Is it still running?'), { status: 0, data: {} });
  }
  const data = await res.json().catch(() => ({}));
  // Signed out (session expired or account switched off): reload to show the sign-in page.
  if (res.status === 401 && !path.startsWith('/auth/')) location.reload();
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (HTTP ${res.status}).`), { status: res.status, data });
  return data;
}

/** Downloads an Excel export from the API. */
export async function download(path) {
  const res = await fetch(`/api${path}`, { headers: { 'X-CRM': '1' } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'The export failed.');
  }
  const url = URL.createObjectURL(await res.blob());
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'export.xlsx';
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const exportButton = (path, label = 'Export to Excel') =>
  h('button', {
    class: 'btn secondary',
    type: 'button',
    onclick: async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await download(typeof path === 'function' ? path() : path);
      } catch (error) {
        toast(error.message, { kind: 'error' });
      } finally {
        button.disabled = false;
      }
    },
  }, icon('download'), label);

// ---------- formatting (times are shown in the business time zone set in Settings)

let zone = 'America/New_York';
export const setZone = (tz) => {
  zone = tz;
};
export const businessZone = () => zone;

const formatters = new Map();
function dtf(options, tz = zone) {
  const key = `${tz}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(undefined, { timeZone: tz, ...options }));
  return formatters.get(key);
}
const pad = (n) => String(n).padStart(2, '0');

export const fmt = {
  phone(e164) {
    const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
    return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164 || '';
  },
  date: (iso) => (iso ? dtf({ weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso)) : ''),
  dateTime: (iso) => (iso ? dtf({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : ''),
  time: (iso) => (iso ? dtf({ hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : ''),
  /** "3 min ago", "Today 2:15 PM", "Yesterday 4:01 PM", or a date. */
  ago(iso) {
    if (!iso) return 'Never';
    const ms = Date.now() - Date.parse(iso);
    if (ms >= 0 && ms < 60_000) return 'Just now';
    if (ms >= 0 && ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
    const day = (d) => dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    if (day(new Date(iso)) === day(new Date())) return `Today ${fmt.time(iso)}`;
    if (day(new Date(iso)) === day(new Date(Date.now() - 86_400_000))) return `Yesterday ${fmt.time(iso)}`;
    return fmt.dateTime(iso);
  },
  /** 0:23 · 12:04 */
  clock(sec) {
    if (sec === null || sec === undefined) return '—';
    const s = Math.round(sec);
    return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
  },
  /** 45s · 3m 05s · 2h 14m */
  span(sec) {
    if (sec === null || sec === undefined) return '—';
    const s = Math.round(sec);
    if (s < 60) return `${s}s`;
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    return hours ? `${hours}h ${pad(minutes)}m` : `${minutes}m ${pad(s % 60)}s`;
  },
  num: (n) => new Intl.NumberFormat().format(n ?? 0),
  pct: (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`),
  money: (n) => (n === null || n === undefined ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)),
  name: (c) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || 'Unnamed contact',
  /** The lead's local time, e.g. "Tue 2:14 PM EST". */
  localTime: (tz) => (tz ? dtf({ weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, tz).format(new Date()) : 'Unknown time zone'),
  zoneName: (tz) => dtf({ timeZoneName: 'short' }, tz).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || tz,
};

/** "YYYY-MM-DDTHH:MM" for a datetime-local input, in `tz`. */
export function localInput(date, tz = zone) {
  const p = Object.fromEntries(dtf({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, tz).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// ---------- small components

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), control, hint && h('small', { class: 'muted' }, hint));
}

/** <select> from [value, label] pairs. */
export function select(options, value, attrs = {}) {
  const el = h('select', attrs, options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = value ?? '';
  return el;
}

export const badge = (text, tone = 'neutral') => h('span', { class: `badge ${tone}` }, text);

export function stageBadge(ctx, stage) {
  const label = Object.fromEntries(ctx.meta.stages)[stage] || stage;
  return badge(label, stage === 'won' ? 'ok' : stage === 'lost' ? 'missed' : stage === 'new' ? 'neutral' : 'info');
}

export function outcomeBadge(ctx, key) {
  if (!key) return badge('No outcome yet', 'warn');
  const d = ctx.meta.dispositions.find((x) => x.key === key);
  if (!d) return badge(key);
  return badge(d.label, d.action === 'dnc' || d.action === 'lost' ? 'missed' : d.connected ? 'ok' : 'warn');
}

export function pageHead(title, subtitle, actions = [], crumb) {
  return h('div', { class: 'page-head' },
    h('div', {}, crumb && h('a', { class: 'crumb', href: crumb[1] }, `← ${crumb[0]}`), h('h1', {}, title), subtitle && h('p', { class: 'subtitle muted' }, subtitle)),
    h('div', { class: 'row' }, actions));
}

export function tabs(items, active, onChange) {
  return h('div', { class: 'tabs', role: 'tablist' },
    items.map(([key, label]) => h('button', { class: `tab${key === active ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(key === active), onclick: () => onChange(key) }, label)));
}

export const empty = (text) => h('div', { class: 'empty-state' }, text);

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- toasts and dialogs

export function toast(message, { kind = 'info', action, timeout = 6000 } = {}) {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', {}, message),
    action && h('button', { class: 'btn small secondary', type: 'button', onclick: () => { el.remove(); action.run(); } }, action.label),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => el.remove() }, icon('x', 14)));
  document.getElementById('toasts').append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

/** A dialog. Not dismissable = no close button, Esc or backdrop click (used for mandatory call outcomes). */
export function openModal({ title, body, footer, wide = false, dismissable = true, onClose }) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape' && dismissable) close();
  };
  const dialog = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', {}, title),
      dismissable && h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    footer && h('div', { class: 'modal-foot' }, footer));
  const overlay = h('div', { class: 'overlay', onmousedown: (event) => event.target === overlay && dismissable && close() }, dialog);
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  dialog.querySelector('input:not([type=radio]), textarea, select')?.focus();
  return { close, dialog };
}

export function confirmDialog({ title, message, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      modal.close();
      resolve(value);
    };
    const modal = openModal({
      title,
      body: h('p', {}, message),
      footer: [
        h('button', { class: 'btn secondary', type: 'button', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: `btn${danger ? ' danger' : ''}`, type: 'button', onclick: () => finish(true) }, confirm),
      ],
      onClose: () => finish(false),
    });
  });
}

/** Runs an async action from a button, disabling it meanwhile and showing errors as toasts. */
export async function busy(button, action) {
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (error) {
    toast(error.message, { kind: 'error' });
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

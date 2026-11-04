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
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  arrow: ['M5 12h14', 'm12 5 7 7-7 7'],
  chevron: ['m6 9 6 6 6-6'],
  sheet: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M8 13h2', 'M14 13h2', 'M8 17h2', 'M14 17h2'],
  filter: ['M3 6h18', 'M7 12h10', 'M10 18h4'],
  note: ['M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7', 'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z'],
};

export function icon(name, size = 16) {
  const el = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    el.setAttribute(key, value);
  }
  for (const d of ICONS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    el.append(path);
  }
  return el;
}

// The Veloq logo: the mark, then the "veloq" wordmark (traced from veloq.tech/assets/logo_black.svg). Uses the text color.
const MARK = 'M225 0V7L214 41L129 197L124 201H93L89 198V192L154 76L113 98L116 112L79 176L0 37V30L3 28H50L54 30L58 35L83 82Z';
const WORD = 'M468 37L481 38L481 159L480 161L467 160L468 37ZM395 72L408 72L417 74L432 83L439 91L444 101L446 109L446 121L371 122L372 130L376 137L383 144L394 149L411 149L423 142L429 135L440 141L440 145L433 152L415 161L394 162L377 156L365 145L362 138L360 137L356 123L356 113L358 103L363 92L373 81L375 81L379 77L395 72ZM541 72L560 73L578 82L590 98L594 112L593 128L584 146L569 158L555 162L534 161L523 156L509 143L502 127L502 108L508 93L519 81L521 81L525 77L541 72ZM647 72L659 72L668 74L680 81L685 87L687 87L688 74L701 75L701 190L687 190L687 165L687 148L685 148L677 156L668 160L659 162L646 162L635 159L625 153L618 146L612 136L609 127L609 109L615 93L620 88L620 86L630 78L647 72ZM259 74L272 75L301 139L304 138L332 77L335 74L347 74L347 78L341 91L339 92L339 95L334 102L331 112L321 130L321 133L308 160L297 160L258 79L259 74ZM396 85L388 87L380 92L373 101L371 110L406 110L431 110L431 104L428 98L415 87L408 85L396 85ZM542 85L532 88L521 98L516 110L516 124L521 136L529 144L540 149L554 149L565 145L575 135L579 126L580 113L575 99L566 90L554 85L542 85ZM651 85L638 89L628 98L623 110L623 125L630 139L637 145L647 149L659 149L666 148L672 145L680 138L686 127L687 112L684 102L676 92L664 86L651 85Z';

export function logo() {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 701 201');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Veloq');
  for (const d of [MARK, WORD]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('fill-rule', 'evenodd');
    el.append(path);
  }
  return el;
}

// ---------- theme (theme.js applies the saved one before the first paint)

export const currentTheme = () => document.documentElement.getAttribute('data-theme') || 'light';

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('veloq-theme', next);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  window.dispatchEvent(new Event('themechange'));
}

/** The sun / moon button; it shows the theme you would switch to. */
export function themeButton(extraClass = '') {
  const button = h('button', { class: `icon-btn nav-icon ${extraClass}`, type: 'button', onclick: toggleTheme });
  const draw = () => {
    const dark = currentTheme() === 'dark';
    button.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    button.setAttribute('aria-label', button.title);
    button.replaceChildren(icon(dark ? 'sun' : 'moon', 18));
  };
  window.addEventListener('themechange', draw);
  draw();
  return button;
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

export const plural = (n, word) => `${fmt.num(n)} ${word}${n === 1 ? '' : 's'}`;

export const stat = (label, value, sub) =>
  h('div', { class: 'card stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-sub' }, sub));

/**
 * The call cards the Zoom call log and the Dashboard share, so both pages show the same numbers in the same words.
 * `s` is a summary with totalCalls, connected, notConnected, talkTime, avgDuration and longestDuration.
 */
export function callStats(s, emptyText = 'No calls in this period') {
  return [
    stat('Connected calls',
      [fmt.num(s.connected), s.totalCalls ? h('span', { class: 'stat-of' }, ` of ${fmt.num(s.totalCalls)}`) : null],
      s.totalCalls ? `${fmt.pct(s.connected / s.totalCalls)} connection rate · ${fmt.num(s.notConnected)} not connected` : emptyText),
    stat('Total talk time', fmt.span(s.talkTime), `Across ${plural(s.connected, 'connected call')}`),
    stat('Average call duration', s.connected ? fmt.span(s.avgDuration) : '—', s.connected ? `Per connected call · longest ${fmt.clock(s.longestDuration)}` : 'No connected calls'),
  ];
}

export function tabs(items, active, onChange) {
  return h('div', { class: 'tabs', role: 'tablist' },
    items.map(([key, label]) => h('button', { class: `tab${key === active ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(key === active), onclick: () => onChange(key) }, label)));
}

/** A progress bar. Green means a target was reached, so only goals get it (goal: false for plain shares). */
export function meter(value, target, { goal = true } = {}) {
  const share = target ? Math.min(1, value / target) : 0;
  const bar = h('div', {});
  bar.style.width = `${Math.round(share * 100)}%`;
  return h('div', { class: `meter${goal && target && value >= target ? ' done' : ''}`, role: 'img', 'aria-label': target ? `${value} of ${target}` : String(value) }, bar);
}

/** The switch between the two report pages. */
export const reportTabs = (ctx, active) => tabs([['dashboard', 'Dashboard'], ['zoom', 'Zoom call log']], active, (key) => ctx.navigate(`#/${key}`));

export const empty = (text) => h('div', { class: 'empty-state' }, text);

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- toasts and dialogs

export function toast(message, { kind = 'info', action, actions = [], timeout = 6000 } = {}) {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', {}, message),
    [action, ...actions].filter(Boolean).map((a) => h('button', {
      class: 'btn small secondary',
      type: 'button',
      onclick: (event) => {
        if (!a.keepOpen) el.remove();
        a.run(event.currentTarget, el);
      },
    }, a.label)),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => el.remove() }, icon('x', 14)));
  document.getElementById('toasts').append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

let closeMenu = null;
let menuAnchor = null;

/** A small menu beside a button, on top of everything so a scrolling table can't cut it off. items = [[label, run], ...]. */
export function openMenu(anchor, items) {
  const again = anchor === menuAnchor;
  closeMenu?.();
  if (again) return;
  const menu = h('div', { class: 'popover menu-pop', role: 'menu' }, items.map(([label, run]) => h('button', {
    class: 'popover-item',
    type: 'button',
    role: 'menuitem',
    onclick: () => {
      closeMenu();
      run();
    },
  }, label)));
  const outside = (event) => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) closeMenu();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') closeMenu();
  };
  const onScroll = () => closeMenu();
  closeMenu = () => {
    menu.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', onScroll, true);
    closeMenu = null;
    menuAnchor = null;
  };
  menuAnchor = anchor;
  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(box.right - width, innerWidth - width - 8))}px`;
  menu.style.top = `${box.bottom + height + 8 > innerHeight ? Math.max(8, box.top - height - 8) : box.bottom + 8}px`;
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', onScroll, true);
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

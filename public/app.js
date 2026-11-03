// Call logs page: fetches /api/calls and renders the summary, daily chart, daily table and call log.

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'zoom-call-logs';
const SVG_NS = 'http://www.w3.org/2000/svg';
const DAY_MS = 86_400_000;

const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const ZONES = [
  [localTz, `Local (${localTz})`],
  ['America/New_York', 'US Eastern'],
  ['America/Chicago', 'US Central'],
  ['America/Denver', 'US Mountain'],
  ['America/Los_Angeles', 'US Pacific'],
  ['UTC', 'UTC'],
].filter(([zone], i, all) => all.findIndex(([z]) => z === zone) === i);

const ICONS = {
  outbound: ['M7 7h10v10', 'M7 17 17 7'],
  inbound: ['M17 7 7 17', 'M17 17H7V7'],
  refresh: [
    'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
    'M21 3v5h-5',
    'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
    'M8 16H3v5',
  ],
  prev: ['m15 18-6-6 6-6'],
  next: ['m9 18 6-6-6-6'],
};

// Single-day periods are relative to today in the selected timezone; 'date' is one specific day.
const RELATIVE_DAYS = { today: 0, yesterday: 1, day_before_yesterday: 2 };
const isRelativeDay = (preset) => Object.hasOwn(RELATIVE_DAYS, preset);
const isDayPreset = (preset) => preset === 'date' || isRelativeDay(preset);
const isDayKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value));

const state = { preset: 'last_30_days', tz: localTz, date: '', from: '', to: '', data: null };
let customOpen = false; // "Custom range…" chosen but not applied yet
let requestSeq = 0;

// ---------- DOM helpers (data is always inserted as text, never parsed as HTML)

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) el.setAttribute(key, value);
  for (const child of children.flat()) if (child !== null && child !== undefined) el.append(child);
  return el;
}

function icon(name, size = 16) {
  return svg(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ICONS[name].map((d) => svg('path', { d })),
  );
}

// ---------- formatting

const intFmt = new Intl.NumberFormat();
const decFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const pad = (n) => String(n).padStart(2, '0');
const plural = (n, word) => `${intFmt.format(n)} ${word}${n === 1 ? '' : 's'}`;

/** Per-call duration: 0:23 · 12:04 · 1:02:03 */
function clock(sec) {
  const s = Math.round(sec);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(s % 60)}` : `${minutes}:${pad(s % 60)}`;
}

/** Totals: 45s · 3m 05s · 2h 14m */
function span(sec) {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours ? `${hours}h ${pad(minutes)}m` : `${minutes}m ${pad(s % 60)}s`;
}

function phone(number) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number || '');
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : number || 'Unknown number';
}

/** Day keys are calendar dates (YYYY-MM-DD) already resolved in the chosen timezone. */
function dayLabel(key, options) {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...options }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

const timeLabel = (iso) =>
  new Intl.DateTimeFormat(undefined, { timeZone: state.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

// ---------- days

/** Today's date (YYYY-MM-DD) in the selected timezone. */
function todayKey() {
  const parts = {};
  const format = new Intl.DateTimeFormat('en-US', { timeZone: state.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  for (const { type, value } of format.formatToParts(new Date())) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const shiftDay = (key, n) => new Date(Date.parse(key) + n * DAY_MS).toISOString().slice(0, 10);
const daysAgo = (key) => Math.round((Date.parse(todayKey()) - Date.parse(key)) / DAY_MS);
const selectedDay = () => (isRelativeDay(state.preset) ? shiftDay(todayKey(), -RELATIVE_DAYS[state.preset]) : state.date);
const presetForDay = (key) => Object.keys(RELATIVE_DAYS).find((p) => RELATIVE_DAYS[p] === daysAgo(key)) || 'date';

function relativeName(key) {
  const ago = daysAgo(key);
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  if (ago === 2) return 'Day before yesterday';
  return ago > 2 ? `${ago} days ago` : 'Single day';
}

// ---------- state (URL first, then this browser's last view)

function restoreState() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    /* storage unavailable */
  }
  const url = new URLSearchParams(location.search);
  const fromUrl = {};
  if (url.has('period')) fromUrl.preset = url.get('period');
  if (url.has('date')) Object.assign(fromUrl, { preset: 'date', date: url.get('date') });
  if (url.has('from') && url.has('to')) Object.assign(fromUrl, { preset: 'custom', from: url.get('from'), to: url.get('to') });
  if (url.has('tz')) fromUrl.tz = url.get('tz');
  const wanted = { ...saved, ...fromUrl };

  const presets = [...$('preset').options].map((o) => o.value);
  if (presets.includes(wanted.preset)) state.preset = wanted.preset;
  if (ZONES.some(([z]) => z === wanted.tz)) state.tz = wanted.tz;
  for (const key of ['date', 'from', 'to']) if (isDayKey(wanted[key])) state[key] = wanted[key];

  if (state.preset === 'custom' && !(state.from && state.to)) state.preset = 'last_30_days';
  if (state.preset === 'date') state.preset = !state.date || state.date > todayKey() ? 'today' : presetForDay(state.date);
}

function persist() {
  const { preset, tz, date, from, to } = state;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ preset, tz, date, from, to }));
  } catch {
    /* storage unavailable — the view just won't be remembered */
  }
  const url = new URLSearchParams();
  if (preset === 'date') url.set('date', date);
  else if (preset === 'custom') {
    url.set('from', from);
    url.set('to', to);
  } else url.set('period', preset);
  if (tz !== localTz) url.set('tz', tz);
  history.replaceState(null, '', `?${url}`);
}

// ---------- data

async function load({ refresh = false } = {}) {
  const seq = ++requestSeq;
  const params = new URLSearchParams({ tz: state.tz });
  if (isDayPreset(state.preset)) {
    params.set('preset', 'day');
    params.set('date', selectedDay());
  } else {
    params.set('preset', state.preset);
    if (state.preset === 'custom') {
      params.set('from', state.from);
      params.set('to', state.to);
    }
  }
  if (refresh) params.set('refresh', '1');

  setBusy(true);
  try {
    const res = await fetch(`/api/calls?${params}`);
    const body = await res.json().catch(() => ({}));
    if (seq !== requestSeq) return;
    if (!res.ok) throw new Error(body.error || `Request failed (HTTP ${res.status}).`);
    state.data = body;
    $('error').hidden = true;
    render();
  } catch (error) {
    if (seq !== requestSeq) return;
    showError(error.message === 'Failed to fetch' ? 'Cannot reach the local server. Is `npm start` still running?' : error.message);
    $('loading').hidden = true;
  } finally {
    if (seq === requestSeq) setBusy(false);
  }
}

function setBusy(busy) {
  const button = $('refresh');
  button.disabled = busy;
  button.classList.toggle('loading', busy);
  $('content').classList.toggle('is-loading', busy && Boolean(state.data));
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

// ---------- rendering

function render() {
  const { range, summary, days, calls, fetchedAt, beforeZoomHistory } = state.data;
  const singleDay = range.firstDay === range.lastDay;
  const zone = ZONES.find(([z]) => z === range.tz)?.[1] || range.tz;
  const period = singleDay
    ? dayLabel(range.firstDay, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    : `${dayLabel(range.firstDay, { month: 'short', day: 'numeric' })} – ${dayLabel(range.lastDay, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const updated = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(fetchedAt));
  $('subtitle').textContent = `${singleDay ? relativeName(range.firstDay) : range.label} · ${period} · ${zone} · Updated ${updated}`;

  $('note').textContent = 'Zoom only keeps the last 6 months of call history, so earlier days show no calls.';
  $('note').hidden = !beforeZoomHistory;
  $('loading').hidden = true;
  $('content').hidden = false;
  $('daysPanel').hidden = singleDay;

  renderStats(summary, singleDay);
  renderChart([...days].reverse(), summary.avgPerDay);
  if (!singleDay) renderDays(days);
  renderLog(days, calls, singleDay);
}

function renderStats(s, singleDay) {
  const card = (label, value, sub) =>
    h('div', { class: 'card stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-sub' }, sub));

  const talkTime = card('Total talk time', span(s.talkTime), `Across ${plural(s.connected, 'connected call')}`);
  const avgDuration = card(
    'Average call duration',
    s.connected ? span(s.avgDuration) : '—',
    s.connected ? `Per connected call · longest ${clock(s.longestDuration)}` : 'No connected calls',
  );

  const cards = singleDay
    ? [
        card('Calls', intFmt.format(s.totalCalls), s.totalCalls ? `${intFmt.format(s.connected)} connected · ${intFmt.format(s.notConnected)} not connected` : 'No calls on this day'),
        card(
          'Connection rate',
          s.totalCalls ? `${Math.round((s.connected / s.totalCalls) * 100)}%` : '—',
          s.totalCalls ? `${intFmt.format(s.connected)} of ${plural(s.totalCalls, 'call')} connected` : 'No calls on this day',
        ),
        talkTime,
        avgDuration,
      ]
    : [
        card('Total calls', intFmt.format(s.totalCalls), `${intFmt.format(s.connected)} connected · ${intFmt.format(s.notConnected)} not connected`),
        card(
          'Average calls per day',
          decFmt.format(s.avgPerDay),
          s.activeDays
            ? `${plural(s.days, 'day')} in range · ${decFmt.format(s.avgPerActiveDay)}/day on the ${plural(s.activeDays, 'day')} with calls`
            : `${plural(s.days, 'day')} in range`,
        ),
        talkTime,
        avgDuration,
      ];
  $('stats').replaceChildren(...cards);
}

function niceScale(maxValue) {
  const rough = Math.max(1, maxValue) / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * power).find((v) => v >= rough));
  return { step, max: Math.max(step, Math.ceil(maxValue / step) * step) };
}

function barPath(x, y, w, height, r) {
  const radius = Math.min(r, w / 2, height);
  return `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${y + height}Z`;
}

/** Single-series column chart (oldest → newest) with a solid average line. */
function renderChart(days, avg) {
  const panel = $('chartPanel');
  const box = $('chart');
  panel.hidden = days.length < 2;
  if (panel.hidden) return;
  $('chartNote').textContent = `Average ${decFmt.format(avg)} calls per day`;

  const width = Math.max(320, box.clientWidth);
  const height = 240;
  const m = { top: 16, right: 64, bottom: 28, left: 40 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const { step, max } = niceScale(Math.max(avg, ...days.map((d) => d.calls)));
  const y = (v) => m.top + plotH - (v / max) * plotH;
  const band = plotW / days.length;
  const barW = Math.min(24, Math.max(2, band - 2));
  const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor(plotW / 64)));
  const labelFormat = days.length > 14 ? { month: 'short', day: 'numeric' } : { weekday: 'short', day: 'numeric' };

  const chart = svg('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `Calls per day over ${days.length} days. Average ${decFmt.format(avg)} per day. Values are listed in the daily summary table.`,
  });

  for (let v = 0; v <= max; v += step) {
    chart.append(
      svg('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }),
      svg('text', { x: m.left - 8, y: y(v), class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, intFmt.format(v)),
    );
  }

  const bars = days.map((d, i) => {
    const cx = m.left + band * i + band / 2;
    if ((days.length - 1 - i) % labelEvery === 0) {
      chart.append(svg('text', { x: cx, y: height - 8, class: 'tick', 'text-anchor': 'middle' }, dayLabel(d.day, labelFormat)));
    }
    if (!d.calls) return null;
    const top = y(d.calls);
    const bar = svg('path', { d: barPath(cx - barW / 2, top, barW, y(0) - top, 4), class: 'bar' });
    chart.append(bar);
    return bar;
  });

  if (avg > 0) {
    chart.append(
      svg('line', { x1: m.left, x2: width - m.right, y1: y(avg), y2: y(avg), class: 'avg' }),
      svg('text', { x: width - m.right + 8, y: y(avg), class: 'avg-label', 'dominant-baseline': 'middle' }, `avg ${decFmt.format(avg)}`),
    );
  }

  // Hit areas span the whole day column so hovering never needs pixel precision.
  days.forEach((d, i) => {
    const hit = svg('rect', { x: m.left + band * i, y: m.top, width: band, height: plotH, class: 'hit' });
    hit.addEventListener('pointerenter', (event) => {
      bars[i]?.classList.add('active');
      showTooltip(event, d);
    });
    hit.addEventListener('pointermove', moveTooltip);
    hit.addEventListener('pointerleave', () => {
      bars[i]?.classList.remove('active');
      $('tooltip').hidden = true;
    });
    hit.addEventListener('click', () => d.calls && scrollToDay(d.day));
    chart.append(hit);
  });

  box.replaceChildren(chart);
}

function showTooltip(event, d) {
  const tip = $('tooltip');
  tip.replaceChildren(
    h('strong', {}, plural(d.calls, 'call')),
    dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric' }),
    h('br'),
    d.calls ? `${intFmt.format(d.connected)} connected · ${span(d.talkTime)} talk time` : 'No calls',
  );
  tip.hidden = false;
  moveTooltip(event);
}

function moveTooltip(event) {
  const tip = $('tooltip');
  const x = Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${event.clientY + 14}px`;
}

function renderDays(days) {
  const rows = days.map((d) =>
    h(
      'tr',
      { class: d.calls ? 'clickable' : 'empty', onclick: d.calls ? () => scrollToDay(d.day) : null },
      h('td', {}, dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric' })),
      h('td', { class: 'num' }, intFmt.format(d.calls)),
      h('td', { class: 'num' }, intFmt.format(d.connected)),
      h('td', { class: 'num' }, intFmt.format(d.calls - d.connected)),
      h('td', { class: 'num' }, d.connected ? span(d.talkTime) : '—'),
      h('td', { class: 'num' }, d.connected ? span(d.avgDuration) : '—'),
    ),
  );
  $('daysTable').tBodies[0].replaceChildren(...rows);
}

function renderLog(days, calls, singleDay) {
  const byDay = new Map();
  for (const call of calls) {
    if (!byDay.has(call.day)) byDay.set(call.day, []);
    byDay.get(call.day).push(call);
  }
  const showUser = new Set(calls.map((c) => c.agent).filter(Boolean)).size > 1;

  const sections = days
    .filter((d) => d.calls > 0)
    .map((d) =>
      h(
        'section',
        { class: 'card day', id: `day-${d.day}` },
        h(
          'div',
          { class: 'day-head' },
          h('h3', {}, dayLabel(d.day, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })),
          h('span', { class: 'muted' }, `${plural(d.calls, 'call')} · ${intFmt.format(d.connected)} connected · ${span(d.talkTime)} talk time`),
        ),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'table' },
            h(
              'thead',
              {},
              h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Direction'), h('th', {}, 'Number'), showUser && h('th', {}, 'User'), h('th', {}, 'Result'), h('th', { class: 'num' }, 'Duration')),
            ),
            h('tbody', {}, byDay.get(d.day).map((call) => callRow(call, showUser))),
          ),
        ),
      ),
    );

  const empty = h('div', { class: 'card empty-state' }, singleDay ? 'No calls on this day.' : 'No calls in this period.');
  $('log').replaceChildren(...(sections.length ? sections : [empty]));
}

function callRow(call, showUser) {
  const outbound = call.direction === 'outbound';
  const tone = call.connected ? 'ok' : outbound ? 'warn' : 'missed';
  return h(
    'tr',
    {},
    h('td', { class: 'time' }, timeLabel(call.start)),
    h('td', {}, h('span', { class: 'dir' }, icon(call.direction, 14), outbound ? 'Outgoing' : 'Incoming')),
    h('td', {}, h('div', { class: 'number' }, phone(call.number)), call.name && h('div', { class: 'muted small' }, call.name)),
    showUser && h('td', {}, call.agent || '—'),
    h('td', {}, h('span', { class: `badge ${tone}` }, call.result)),
    h('td', { class: `num${call.duration ? '' : ' muted'}` }, clock(call.duration)),
  );
}

function scrollToDay(day) {
  const section = $(`day-${day}`);
  if (!section) return;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  section.classList.remove('flash');
  void section.offsetWidth;
  section.classList.add('flash');
}

// ---------- controls

function syncControls() {
  const dayMode = isDayPreset(state.preset) && !customOpen;
  $('preset').value = customOpen ? 'custom' : state.preset;
  $('custom').hidden = !(customOpen || state.preset === 'custom');
  $('dayNav').hidden = !dayMode;
  if (dayMode) {
    const today = todayKey();
    const day = selectedDay();
    $('date').max = today;
    $('date').value = day;
    $('nextDay').disabled = day >= today;
  }
}

function applyState() {
  persist();
  syncControls();
  load();
}

function goToDay(key) {
  state.date = key;
  state.preset = presetForDay(key);
  customOpen = false;
  applyState();
}

function prefillCustom() {
  if ($('from').value && $('to').value) return;
  $('from').value = state.data?.range.firstDay || shiftDay(todayKey(), -6);
  $('to').value = state.data?.range.lastDay || todayKey();
}

function init() {
  $('tz').replaceChildren(...ZONES.map(([value, label]) => h('option', { value }, label)));
  restoreState();
  $('tz').value = state.tz;
  $('from').value = state.from;
  $('to').value = state.to;
  $('refresh').replaceChildren(icon('refresh'), 'Refresh');
  $('prevDay').replaceChildren(icon('prev'));
  $('nextDay').replaceChildren(icon('next'));

  $('preset').addEventListener('change', (event) => {
    const value = event.target.value;
    customOpen = value === 'custom';
    if (customOpen) {
      prefillCustom();
      syncControls();
      return;
    }
    if (value === 'date') {
      state.date = isDayPreset(state.preset) ? selectedDay() : todayKey();
      state.preset = 'date';
      applyState();
      try {
        $('date').showPicker();
      } catch {
        $('date').focus();
      }
      return;
    }
    state.preset = value;
    applyState();
  });

  $('date').addEventListener('change', (event) => {
    const value = event.target.value;
    if (!isDayKey(value)) return;
    if (value > todayKey()) {
      showError('That date is in the future.');
      syncControls();
      return;
    }
    goToDay(value);
  });

  $('prevDay').addEventListener('click', () => goToDay(shiftDay(selectedDay(), -1)));
  $('nextDay').addEventListener('click', () => {
    const next = shiftDay(selectedDay(), 1);
    if (next <= todayKey()) goToDay(next);
  });

  $('apply').addEventListener('click', () => {
    const from = $('from').value;
    const to = $('to').value;
    if (!from || !to || from > to) {
      showError('Choose a start date that is on or before the end date.');
      return;
    }
    Object.assign(state, { preset: 'custom', from, to });
    customOpen = false;
    applyState();
  });

  $('tz').addEventListener('change', (event) => {
    state.tz = event.target.value;
    if (state.preset === 'date') state.preset = state.date > todayKey() ? 'today' : presetForDay(state.date);
    applyState();
  });

  $('refresh').addEventListener('click', () => load({ refresh: true }));

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.data && renderChart([...state.data.days].reverse(), state.data.summary.avgPerDay), 150);
  });

  persist();
  syncControls();
  load();
}

init();

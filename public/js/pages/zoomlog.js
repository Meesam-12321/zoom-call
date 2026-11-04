// Zoom call log: every Zoom Phone call in a period, straight from Zoom (not only calls dialed from the CRM),
// with daily totals and a chart. Calls to a CRM lead's number link to that lead.
import { api, busy, callStats, field, fill, fmt, h, icon, pageHead, plural, reportTabs, select, stat, toast } from '../ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DAY_MS = 86_400_000;
const STORE_KEY = 'crm-zoom-log';

const PERIODS = [
  ['Single day', [['today', 'Today'], ['yesterday', 'Yesterday'], ['day_before_yesterday', 'Day before yesterday'], ['date', 'Pick a date…']]],
  ['Range', [['last_7_days', 'Last 7 days'], ['last_30_days', 'Last 30 days'], ['this_month', 'This month'], ['last_month', 'Last month'], ['last_90_days', 'Last 90 days'], ['custom', 'Custom range…']]],
];
const PERIOD_KEYS = new Set(PERIODS.flatMap(([, items]) => items.map(([key]) => key)));
// Single-day periods count back from today; 'date' is one specific day.
const RELATIVE_DAYS = { today: 0, yesterday: 1, day_before_yesterday: 2 };
const isRelative = (period) => Object.hasOwn(RELATIVE_DAYS, period);
const isSingleDay = (view) => view.period === 'date' || isRelative(view.period);
const isDayKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value));

const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function zoneOptions(business) {
  return [
    [business, `CRM time zone (${business})`],
    [localTz, `This computer (${localTz})`],
    ['America/New_York', 'US Eastern'],
    ['America/Chicago', 'US Central'],
    ['America/Denver', 'US Mountain'],
    ['America/Los_Angeles', 'US Pacific'],
    ['UTC', 'UTC'],
  ].filter(([zone], i, all) => all.findIndex(([z]) => z === zone) === i);
}

// ---------- days (YYYY-MM-DD keys, already resolved in the view's time zone)

function todayKey(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const shiftDay = (key, n) => new Date(Date.parse(key) + n * DAY_MS).toISOString().slice(0, 10);
const daysAgo = (key, tz) => Math.round((Date.parse(todayKey(tz)) - Date.parse(key)) / DAY_MS);
const selectedDay = (view) => (isRelative(view.period) ? shiftDay(todayKey(view.tz), -RELATIVE_DAYS[view.period]) : view.date);

function dayLabel(key, options) {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...options }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

function relativeName(key, tz) {
  const ago = daysAgo(key, tz);
  return ago === 0 ? 'Today' : ago === 1 ? 'Yesterday' : ago === 2 ? 'Day before yesterday' : `${ago} days ago`;
}

// ---------- view (kept in the URL, e.g. #/zoom?period=last_7_days, and remembered by this browser)

function readView(params, business) {
  const view = { period: 'last_30_days', date: '', from: '', to: '', tz: business };
  if (zoneOptions(business).some(([zone]) => zone === params.get('tz'))) view.tz = params.get('tz');
  const [date, from, to, period] = ['date', 'from', 'to', 'period'].map((key) => params.get(key));
  if (isDayKey(date)) Object.assign(view, { period: 'date', date });
  else if (isDayKey(from) && isDayKey(to) && from <= to) Object.assign(view, { period: 'custom', from, to });
  else if (PERIOD_KEYS.has(period) && period !== 'date' && period !== 'custom') view.period = period;
  if (view.period === 'date') {
    // Today, yesterday and the day before show under their own names; a future day shows today.
    const ago = daysAgo(view.date, view.tz);
    view.period = ago < 0 ? 'today' : Object.keys(RELATIVE_DAYS).find((key) => RELATIVE_DAYS[key] === ago) || 'date';
  }
  return view;
}

function viewParams(view, business) {
  const params = new URLSearchParams();
  if (view.period === 'date') params.set('date', view.date);
  else if (view.period === 'custom') {
    params.set('from', view.from);
    params.set('to', view.to);
  } else params.set('period', view.period);
  if (view.tz !== business) params.set('tz', view.tz);
  return params;
}

function apiParams(view) {
  const params = new URLSearchParams({ tz: view.tz });
  if (isSingleDay(view)) {
    params.set('preset', 'day');
    params.set('date', selectedDay(view));
  } else {
    params.set('preset', view.period);
    if (view.period === 'custom') {
      params.set('from', view.from);
      params.set('to', view.to);
    }
  }
  return params;
}

function remembered() {
  try {
    return new URLSearchParams(localStorage.getItem(STORE_KEY) || '');
  } catch {
    return new URLSearchParams();
  }
}

function remember(params) {
  try {
    localStorage.setItem(STORE_KEY, String(params));
  } catch {
    // Storage unavailable: the view just isn't remembered.
  }
}

// ---------- page

export async function render(root, { query }, ctx, isCurrent) {
  if (!ctx.meta.zoomConfigured) {
    fill(root,
      pageHead('Zoom call log', 'Every Zoom Phone call, by day'),
      reportTabs(ctx, 'zoom'),
      h('div', { class: 'card empty-state' }, 'Add your Zoom credentials (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET) to .env and restart the CRM to see Zoom calls here.'));
    return;
  }
  const business = ctx.meta.settings.business_tz;
  const view = readView([...query.keys()].length ? query : remembered(), business);
  const params = viewParams(view, business);
  remember(params);
  history.replaceState(null, '', `#/zoom?${params}`);
  const data = await api(`/zoom/calls?${apiParams(view)}`);
  if (isCurrent()) draw(root, ctx, view, data, isCurrent);
}

function draw(root, ctx, view, data, isCurrent) {
  const { range, summary: s, days, calls, fetchedAt, beforeZoomHistory, minConnectedSeconds } = data;
  const business = ctx.meta.settings.business_tz;
  const singleDay = range.firstDay === range.lastDay;
  const go = (changes) => ctx.navigate(`#/zoom?${viewParams({ ...view, ...changes }, business)}`);
  const today = todayKey(view.tz);
  const day = selectedDay(view);

  const period = singleDay
    ? dayLabel(range.firstDay, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    : `${dayLabel(range.firstDay, { month: 'short', day: 'numeric' })} – ${dayLabel(range.lastDay, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const updated = new Intl.DateTimeFormat(undefined, { timeZone: view.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(fetchedAt));
  const subtitle = `${singleDay ? relativeName(range.firstDay, view.tz) : range.label} · ${period} · ${fmt.zoneName(view.tz)} · Updated ${updated}`;

  const refresh = h('button', {
    class: 'btn secondary',
    type: 'button',
    title: 'Fetch the latest calls from Zoom',
    onclick: async (event) => {
      const button = event.currentTarget;
      button.classList.add('loading');
      const fresh = await busy(button, () => api(`/zoom/calls?${apiParams(view)}&refresh=1`));
      button.classList.remove('loading');
      if (fresh && isCurrent()) draw(root, ctx, view, fresh, isCurrent);
    },
  }, icon('refresh'), 'Refresh');

  // ---------- controls
  const dateInput = h('input', {
    type: 'date',
    value: day,
    max: today,
    onchange: (event) => isDayKey(event.target.value) && event.target.value <= today && go({ period: 'date', date: event.target.value }),
  });
  const periodSelect = h('select', {
    onchange: (event) => {
      const value = event.target.value;
      if (value === 'custom') return go({ period: 'custom', from: range.firstDay, to: range.lastDay });
      if (value !== 'date') return go({ period: value });
      if (!isSingleDay(view)) return go({ period: 'date', date: today });
      // Already showing one day: open its date picker.
      event.target.value = view.period;
      try {
        dateInput.showPicker();
      } catch {
        dateInput.focus();
      }
    },
  }, PERIODS.map(([label, items]) => h('optgroup', { label }, items.map(([value, text]) => h('option', { value }, text)))));
  periodSelect.value = view.period;

  const fromInput = h('input', { type: 'date', value: view.from, max: today });
  const toInput = h('input', { type: 'date', value: view.to, max: today });
  const applyCustom = () => {
    if (!fromInput.value || !toInput.value) return;
    if (fromInput.value > toInput.value) return toast('Choose a start date on or before the end date.', { kind: 'error' });
    go({ period: 'custom', from: fromInput.value, to: toInput.value });
  };
  fromInput.addEventListener('change', applyCustom);
  toInput.addEventListener('change', applyCustom);

  const controls = h('div', { class: 'toolbar' },
    field('Period', periodSelect),
    isSingleDay(view) && h('div', { class: 'day-nav' },
      h('button', { class: 'btn secondary icon-only', type: 'button', title: 'Previous day', 'aria-label': 'Previous day', onclick: () => go({ period: 'date', date: shiftDay(day, -1) }) }, icon('back')),
      field('Date', dateInput),
      h('button', { class: 'btn secondary icon-only', type: 'button', title: 'Next day', 'aria-label': 'Next day', disabled: day >= today, onclick: () => go({ period: 'date', date: shiftDay(day, 1) }) }, icon('next'))),
    view.period === 'custom' && [field('From', fromInput), field('To', toInput)],
    field('Time zone', select(zoneOptions(business), view.tz, { onchange: (event) => go({ tz: event.target.value }) })));

  // ---------- summary: "Connected calls: 70 of 103" in one card, the same cards the Dashboard shows
  const [connected, talk, avg] = callStats(s, singleDay ? 'No calls on this day' : 'No calls in this period');
  const perDay = stat('Average calls per day', decimal.format(s.avgPerDay), s.activeDays
    ? `${plural(s.days, 'day')} in range · ${decimal.format(s.avgPerActiveDay)}/day on the ${plural(s.activeDays, 'day')} with calls`
    : `${plural(s.days, 'day')} in range`);
  const cards = singleDay ? [connected, talk, avg] : [connected, perDay, talk, avg];

  const tip = h('div', { class: 'tooltip', hidden: true });
  const chartBox = h('div', { class: 'chart' });
  const toDay = (key) => scrollToDay(root, key);

  fill(root,
    pageHead('Zoom call log', subtitle, [refresh]),
    reportTabs(ctx, 'zoom'),
    controls,
    beforeZoomHistory && h('div', { class: 'note' }, 'Zoom only keeps the last 6 months of call history, so earlier days show no calls.'),
    h('section', { class: `stats${cards.length === 3 ? ' cols-3' : ''}`, 'aria-label': 'Summary' }, cards),
    days.length > 1 && h('section', { class: 'card panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Calls per day'), h('span', { class: 'muted' }, `Average ${decimal.format(s.avgPerDay)} calls per day`)),
      chartBox),
    !singleDay && h('section', { class: 'card panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Daily summary'), h('span', { class: 'muted' }, 'Click a day to jump to its calls')),
      h('div', { class: 'table-wrap scroll' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), ['Calls', 'Connected', 'Not connected', 'Talk time', 'Avg duration'].map((label) => h('th', { class: 'num' }, label)))),
        h('tbody', {}, days.map((d) => h('tr', { class: d.calls ? 'clickable' : 'empty', onclick: d.calls ? () => toDay(d.day) : null },
          h('td', {}, dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric' })),
          h('td', { class: 'num' }, fmt.num(d.calls)),
          h('td', { class: 'num' }, fmt.num(d.connected)),
          h('td', { class: 'num' }, fmt.num(d.calls - d.connected)),
          h('td', { class: 'num' }, d.connected ? fmt.span(d.talkTime) : '—'),
          h('td', { class: 'num' }, d.connected ? fmt.span(d.avgDuration) : '—'))))))),
    h('div', { class: 'panel-head section-head' },
      h('h2', { class: 'section-title' }, 'Call log'),
      minConnectedSeconds > 0 && h('span', { class: 'muted' }, `Outgoing calls under ${minConnectedSeconds}s count as not connected: usually voicemail or a phone menu, which Zoom also marks connected.`)),
    callLog(days, calls, singleDay, view.tz),
    tip);

  if (days.length < 2) return;
  const chronological = [...days].reverse();
  drawChart(chartBox, chronological, s.avgPerDay, tip, toDay);
  let timer;
  const onResize = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!chartBox.isConnected) return window.removeEventListener('resize', onResize);
      drawChart(chartBox, chronological, s.avgPerDay, tip, toDay);
    }, 150);
  };
  window.addEventListener('resize', onResize);
}

// ---------- call log

function callLog(days, calls, singleDay, tz) {
  const byDay = new Map();
  for (const call of calls) {
    if (!byDay.has(call.day)) byDay.set(call.day, []);
    byDay.get(call.day).push(call);
  }
  const showUser = new Set(calls.map((c) => c.agent).filter(Boolean)).size > 1;
  const time = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const sections = days.filter((d) => d.calls > 0).map((d) => h('section', { class: 'card day', id: `day-${d.day}` },
    h('div', { class: 'day-head' },
      h('h3', {}, dayLabel(d.day, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })),
      h('span', { class: 'muted' }, `${plural(d.calls, 'call')} · ${fmt.num(d.connected)} connected · ${fmt.span(d.talkTime)} talk time`)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Time'), h('th', {}, 'Direction'), h('th', {}, 'Number'), showUser && h('th', {}, 'User'), h('th', {}, 'Result'), h('th', { class: 'num' }, 'Duration'))),
      h('tbody', {}, byDay.get(d.day).map((call) => callRow(call, showUser, time)))))));
  return sections.length ? sections : h('div', { class: 'card empty-state' }, singleDay ? 'No calls on this day.' : 'No calls in this period.');
}

/** Hover text for a result: how long it rang, and why a short outgoing call is not connected. */
function resultHint(call) {
  if (call.ringTime == null) return null;
  const rang = `Rang ${call.ringTime}s before the line was answered`;
  return call.tooShort ? `${rang}, then ended after ${call.duration}s: usually voicemail, a phone menu or a wrong number.` : `${rang}.`;
}

function callRow(call, showUser, time) {
  const outbound = call.direction === 'outbound';
  return h('tr', {},
    h('td', { class: 'time' }, time.format(new Date(call.start))),
    h('td', {}, h('span', { class: 'dir' }, icon(call.direction, 14), outbound ? 'Outgoing' : 'Incoming')),
    h('td', {},
      h('div', { class: 'number' }, fmt.phone(call.number) || 'Unknown number'),
      call.lead
        ? h('div', { class: 'small' }, h('a', { href: call.lead.href }, call.lead.name))
        : call.name && h('div', { class: 'muted small' }, call.name)),
    showUser && h('td', {}, call.agent || '—'),
    h('td', {}, h('span', { class: `badge ${call.connected ? 'ok' : outbound ? 'warn' : 'missed'}`, title: resultHint(call) }, call.result)),
    h('td', { class: `num${call.duration ? '' : ' muted'}` }, fmt.clock(call.duration)));
}

function scrollToDay(root, key) {
  const section = root.querySelector(`#day-${key}`);
  if (!section) return;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  section.classList.remove('flash');
  void section.offsetWidth;
  section.classList.add('flash');
}

// ---------- chart

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  el.append(...children);
  return el;
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

function showTip(tip, event, d) {
  fill(tip,
    h('strong', {}, plural(d.calls, 'call')),
    dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric' }),
    h('br'),
    d.calls ? `${fmt.num(d.connected)} connected · ${fmt.span(d.talkTime)} talk time` : 'No calls');
  tip.hidden = false;
  moveTip(tip, event);
}

function moveTip(tip, event) {
  tip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${event.clientY + 14}px`;
}

/** Calls per day (oldest → newest) as columns, with the average as a labeled line. */
function drawChart(box, days, avg, tip, onDay) {
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
    'aria-label': `Calls per day over ${days.length} days. Average ${decimal.format(avg)} per day. Values are listed in the daily summary table.`,
  });
  for (let v = 0; v <= max; v += step) {
    chart.append(
      svg('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }),
      svg('text', { x: m.left - 8, y: y(v), class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, fmt.num(v)),
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
      svg('text', { x: width - m.right + 8, y: y(avg), class: 'avg-label', 'dominant-baseline': 'middle' }, `avg ${decimal.format(avg)}`),
    );
  }

  // Hit areas span the whole day column so hovering never needs pixel precision.
  days.forEach((d, i) => {
    const hit = svg('rect', { x: m.left + band * i, y: m.top, width: band, height: plotH, class: 'hit' });
    hit.addEventListener('pointerenter', (event) => {
      bars[i]?.classList.add('active');
      showTip(tip, event, d);
    });
    hit.addEventListener('pointermove', (event) => moveTip(tip, event));
    hit.addEventListener('pointerleave', () => {
      bars[i]?.classList.remove('active');
      tip.hidden = true;
    });
    hit.addEventListener('click', () => d.calls && onDay(d.day));
    chart.append(hit);
  });

  box.replaceChildren(chart);
}

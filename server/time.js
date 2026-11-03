// Timezone-aware date ranges using Intl (no dependencies). "Days" are calendar days in `tz`.

const formatters = new Map();

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(date, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = Number(part.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

function offsetMs(date, tz) {
  const p = zonedParts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Midnight of a calendar day in `tz` as a UTC Date (handles DST). */
export function startOfDay({ year, month, day }, tz) {
  const guess = Date.UTC(year, month - 1, day);
  const first = offsetMs(new Date(guess), tz);
  const second = offsetMs(new Date(guess - first), tz);
  return new Date(guess - (second === first ? first : second));
}

/** A wall-clock time in `tz` ("2026-11-04T15:30") as a UTC Date, or null if the value is not a valid time. */
export function zonedDateTime(value, tz) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
  const day = m && parseDay(m[1]);
  const hour = Number(m?.[2]);
  const minute = Number(m?.[3]);
  if (!day || hour > 23 || minute > 59) return null;
  const target = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  const first = offsetMs(new Date(target), tz);
  const second = offsetMs(new Date(target - first), tz);
  return new Date(target - (second === first ? first : second));
}

/** [start, end) of today in `tz`. */
export function todayBounds(tz, now = new Date()) {
  const p = zonedParts(now, tz);
  const today = { year: p.year, month: p.month, day: p.day };
  return { start: startOfDay(today, tz), end: startOfDay(addDays(today, 1), tz) };
}

export function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function diffDays(a, b) {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export const dayKey = ({ year, month, day }) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

export function parseDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return dayKey(addDays(d, 0)) === m[0] ? d : null;
}

const LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  last_90_days: 'Last 90 days',
  this_month: 'This month',
  last_month: 'Last month',
  custom: 'Custom range',
  day: 'Single day',
};

/** Preset, single day or custom inclusive day range → UTC instants [from, to) for `tz`. */
export function resolveRange({ preset, from, to, date, tz = 'UTC', now = new Date() }) {
  if (!LABELS[preset]) preset = 'last_30_days';
  const p = zonedParts(now, tz);
  const today = { year: p.year, month: p.month, day: p.day };
  let first;
  let last = today;

  switch (preset) {
    case 'today':
      first = today;
      break;
    case 'yesterday':
      first = last = addDays(today, -1);
      break;
    case 'this_week': {
      // Weeks start on Monday.
      const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
      first = addDays(today, -((weekday + 6) % 7));
      break;
    }
    case 'last_7_days':
      first = addDays(today, -6);
      break;
    case 'last_90_days':
      first = addDays(today, -89);
      break;
    case 'this_month':
      first = { ...today, day: 1 };
      break;
    case 'last_month':
      last = addDays({ ...today, day: 1 }, -1);
      first = { ...last, day: 1 };
      break;
    case 'day':
      first = last = parseDay(date);
      if (!first) throw new RangeError('Pick a valid date (YYYY-MM-DD).');
      if (diffDays(first, today) < 0) throw new RangeError('That date is in the future.');
      break;
    case 'custom':
      first = parseDay(from);
      last = parseDay(to);
      if (!first || !last) throw new RangeError('Pick a start and end date for the custom range.');
      if (diffDays(first, last) < 0) throw new RangeError('The start date must be on or before the end date.');
      if (diffDays(first, last) > 365) throw new RangeError('Custom ranges can be at most one year.');
      break;
    default:
      first = addDays(today, -29);
  }

  return {
    preset,
    label: LABELS[preset],
    tz,
    from: startOfDay(first, tz),
    to: startOfDay(addDays(last, 1), tz),
    firstDay: dayKey(first),
    lastDay: dayKey(last),
  };
}

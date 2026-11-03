// Dashboard metrics, calculated from logged calls and their outcomes, plus pipeline totals per stage.
import express from 'express';
import { sendWorkbook } from './excel.js';
import { STAGES } from './fields.js';
import { stamp } from './leads.js';
import { resolveRange, todayBounds } from './time.js';

const RANGES = new Set(['today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'last_month', 'last_30_days', 'custom']);
const ratio = (a, b) => (b ? a / b : null);
const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) || 0), 0);

function callerFilter(user, query) {
  if (user.role !== 'admin') return user.id;
  return Number(query.user) || null;
}

function callsBetween(store, from, to, userId, listId) {
  const where = ['cl.started_at >= ?', 'cl.started_at < ?'];
  const params = [from.toISOString(), to.toISOString()];
  if (userId) {
    where.push('cl.user_id = ?');
    params.push(userId);
  }
  if (listId) {
    where.push('cl.list_id = ?');
    params.push(listId);
  }
  return store.all(
    `SELECT cl.*, d.label AS disposition_label, d.connected, d.action, u.name AS user_name,
       ct.first_name, ct.last_name, co.name AS company_name, l.name AS list_name
     FROM calls cl
     LEFT JOIN dispositions d ON d.key = cl.disposition
     LEFT JOIN users u ON u.id = cl.user_id
     LEFT JOIN contacts ct ON ct.id = cl.contact_id
     LEFT JOIN companies co ON co.id = cl.company_id
     LEFT JOIN lists l ON l.id = cl.list_id
     WHERE ${where.join(' AND ')} ORDER BY cl.started_at DESC`,
    ...params,
  );
}

/**
 * Definitions (from the requirements):
 *  - calls picked up   = calls whose outcome counts as connected (a person answered)
 *  - connect rate      = picked up ÷ total calls
 *  - total talk time   = sum of Zoom call durations
 *  - avg call duration = talk time of connected calls ÷ connected calls
 *  - conversations     = connected calls longer than the conversation threshold (default 60 s)
 *  - meeting rate      = meetings booked ÷ conversations
 */
function metrics(calls, conversationSeconds) {
  const connected = calls.filter((c) => c.connected === 1);
  const conversations = connected.filter((c) => (c.duration || 0) > conversationSeconds).length;
  const meetings = calls.filter((c) => c.action === 'positive' && c.meeting_booked).length;
  // Calls whose Zoom record has not arrived yet have no duration and are left out of the average.
  const timed = connected.filter((c) => c.duration !== null);
  return {
    totalCalls: calls.length,
    pickedUp: connected.length,
    connectRate: ratio(connected.length, calls.length),
    talkTime: sum(calls, (c) => c.duration),
    avgDuration: timed.length ? Math.round(sum(timed, (c) => c.duration) / timed.length) : null,
    conversations,
    meetings,
    meetingRate: ratio(meetings, conversations),
    pendingOutcome: calls.filter((c) => !c.disposition).length,
    awaitingZoom: calls.filter((c) => !c.zoom_uuid).length,
  };
}

export function analyticsReport(store, user, query) {
  const tz = store.setting('business_tz');
  const conversationSeconds = store.setting('conversation_seconds');
  const preset = RANGES.has(query.range) ? query.range : 'today';
  const range = resolveRange({ preset, from: query.from, to: query.to, tz });
  const userId = callerFilter(user, query);
  const listId = Number(query.list) || null;
  const calls = callsBetween(store, range.from, range.to, userId, listId);

  const dispositions = store.all('SELECT key, label, connected, active FROM dispositions ORDER BY position');
  const breakdown = [...dispositions, { key: null, label: 'Outcome not saved yet', connected: 0, active: 0 }]
    .map((d) => ({ ...d, count: calls.filter((c) => (c.disposition ?? null) === d.key).length }))
    .filter((d) => d.count > 0 || d.active)
    .map((d) => ({ ...d, share: ratio(d.count, calls.length) }));

  // Daily targets are always for today, per caller.
  const { start, end } = todayBounds(tz);
  const people = userId
    ? store.all('SELECT * FROM users WHERE id = ?', userId)
    : store.all("SELECT * FROM users WHERE active = 1 AND (role = 'caller' OR id IN (SELECT user_id FROM calls WHERE started_at >= ?)) ORDER BY name", start.toISOString());
  const targets = people.map((person) => {
    const m = metrics(callsBetween(store, start, end, person.id, listId), conversationSeconds);
    return {
      userId: person.id,
      name: person.name,
      calls: [m.totalCalls, person.target_calls],
      conversations: [m.conversations, person.target_conversations],
      meetings: [m.meetings, person.target_meetings],
    };
  });

  const scope = user.role === 'admin' ? (userId ? 'WHERE co.owner_id = ?' : '') : 'WHERE co.owner_id = ?';
  const scopeParams = user.role === 'admin' ? (userId ? [userId] : []) : [user.id];
  const byStage = new Map(store.all(
    `SELECT d.stage, COUNT(*) AS count, SUM(d.value) AS value FROM deals d JOIN companies co ON co.id = d.company_id ${scope} GROUP BY d.stage`,
    ...scopeParams,
  ).map((row) => [row.stage, row]));
  const pipeline = STAGES.map(([key, label]) => ({ stage: key, label, count: byStage.get(key)?.count || 0, value: byStage.get(key)?.value || 0 }));

  return {
    range: { preset: range.preset, label: range.label, firstDay: range.firstDay, lastDay: range.lastDay, tz },
    conversationSeconds,
    summary: metrics(calls, conversationSeconds),
    breakdown,
    targets,
    pipeline,
    calls,
  };
}

export function analyticsRoutes(store) {
  const r = express.Router();

  r.get('/analytics', (req, res) => {
    const { calls, ...report } = analyticsReport(store, req.user, req.query);
    res.json(report);
  });

  r.get('/analytics/export', async (req, res) => {
    const report = analyticsReport(store, req.user, req.query);
    const s = report.summary;
    const pct = (x) => (x === null ? '' : `${Math.round(x * 100)}%`);
    await sendWorkbook(res, 'call-report', [
      {
        name: 'Summary',
        columns: [['metric', 'Metric', 28], ['value', 'Value', 16]],
        rows: [
          { metric: 'Period', value: report.range.firstDay === report.range.lastDay ? report.range.firstDay : `${report.range.firstDay} to ${report.range.lastDay}` },
          { metric: 'Total calls', value: s.totalCalls },
          { metric: 'Calls picked up', value: s.pickedUp },
          { metric: 'Connect rate', value: pct(s.connectRate) },
          { metric: 'Total talk time (seconds)', value: s.talkTime },
          { metric: 'Average call duration (seconds)', value: s.avgDuration ?? '' },
          { metric: `Conversations (over ${report.conversationSeconds}s)`, value: s.conversations },
          { metric: 'Meetings booked', value: s.meetings },
          { metric: 'Meeting rate', value: pct(s.meetingRate) },
        ],
      },
      {
        name: 'Outcomes',
        columns: [['label', 'Outcome', 36], ['count', 'Calls', 10], ['share', 'Share', 10]],
        rows: report.breakdown.map((d) => ({ ...d, share: pct(d.share) })),
      },
      {
        name: 'Targets today',
        columns: [['name', 'Caller', 24], ['calls', 'Calls'], ['conversations', 'Conversations', 16], ['meetings', 'Meetings']],
        rows: report.targets.map((t) => ({
          name: t.name,
          calls: `${t.calls[0]} / ${t.calls[1]}`,
          conversations: `${t.conversations[0]} / ${t.conversations[1]}`,
          meetings: `${t.meetings[0]} / ${t.meetings[1]}`,
        })),
      },
      {
        name: 'Pipeline',
        columns: [['label', 'Stage', 18], ['count', 'Leads', 10], ['value', 'Value', 14]],
        rows: report.pipeline,
      },
      {
        name: 'Calls',
        columns: [
          ['started', 'Started', 18], ['user_name', 'Caller'], ['contact', 'Contact', 24], ['company_name', 'Company', 30],
          ['phone_e164', 'Number', 16], ['disposition_label', 'Outcome', 28], ['duration', 'Duration (s)', 12],
          ['meeting', 'Meeting booked', 14], ['list_name', 'Call list', 24], ['notes', 'Notes', 50],
        ],
        rows: report.calls.map((c) => ({
          ...c,
          started: stamp(c.started_at, report.range.tz),
          contact: [c.first_name, c.last_name].filter(Boolean).join(' '),
          meeting: c.meeting_booked ? 'Yes' : '',
        })),
      },
    ]);
  });

  return r;
}

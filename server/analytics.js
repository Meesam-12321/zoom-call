// Dashboard metrics. Call counts, connections and talk time come from Zoom, the very same records and rules as the Zoom call
// log, so the two pages always agree. Outcomes and meetings come from what callers saved in the CRM. Also pipeline totals.
import express from 'express';
import { sendWorkbook } from './excel.js';
import { STAGES } from './fields.js';
import { stamp } from './leads.js';
import { asE164 } from './phone.js';
import { buildReport, configuredMinSeconds } from './report.js';
import { resolveRange } from './time.js';
import * as zoomApi from './zoom.js';

const RANGES = new Set(['today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'last_month', 'last_30_days', 'custom']);
const ratio = (a, b) => (b ? a / b : null);
const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) || 0), 0);
const isMeeting = (call) => call.action === 'positive' && call.meeting_booked;

function callerFilter(user, query) {
  if (user.role !== 'admin') return user.id;
  return Number(query.user) || null;
}

/** Calls dialed from the CRM, with the outcome saved for each. */
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

/** Every phone number of the leads in a call list, as Zoom reports numbers. */
function listNumbers(store, listId) {
  const rows = store.all(
    `SELECT ct.mobile_e164 AS mobile, ct.direct_e164 AS direct, co.hq_phone_e164 AS hq
     FROM list_contacts lc JOIN contacts ct ON ct.id = lc.contact_id JOIN companies co ON co.id = ct.company_id
     WHERE lc.list_id = ?`,
    listId,
  );
  return new Set(rows.flatMap((row) => [row.mobile, row.direct, row.hq]).filter(Boolean));
}

/**
 * What the CRM knows about Zoom's call records. A record belongs to the user who dialed it from the CRM, otherwise to the user
 * whose email is the Zoom user's (the caller on outgoing calls, the callee on incoming ones). `outcome` is the outcome saved
 * for it: calls dialed outside the CRM have none.
 */
function crmView(store, items) {
  const byEmail = new Map(store.all('SELECT id, email FROM users').map((u) => [u.email.toLowerCase(), u.id]));
  const dialed = new Map(store.all('SELECT zoom_uuid, user_id, disposition FROM calls WHERE zoom_uuid IS NOT NULL').map((c) => [c.zoom_uuid, c]));
  const owner = new Map();
  for (const item of items) {
    const id = item.call_history_uuid || item.id;
    const email = String((item.direction === 'inbound' ? item.callee_email : item.caller_email) || '').toLowerCase();
    owner.set(id, dialed.get(id)?.user_id ?? byEmail.get(email) ?? null);
  }
  return { owner, outcome: (id) => dialed.get(id)?.disposition ?? null };
}

/** The Zoom call log's own report over Zoom's records, narrowed to a caller and/or call list as the CRM knows them. */
function zoomReport(store, crm, items, range, { userId, listId }) {
  const numbers = listId ? listNumbers(store, listId) : null;
  const keep = (call) => (!userId || crm.owner.get(call.id) === userId) && (!numbers || numbers.has(asE164(call.number)));
  return buildReport(items, range, { minConnectedSeconds: configuredMinSeconds(), keep });
}

/**
 * Definitions, shared with the Zoom call log:
 *  - connected         = Zoom says the line was answered and, for outgoing calls, it lasted at least MIN_CONNECTED_SECONDS
 *  - connection rate   = connected ÷ total calls
 *  - total talk time   = sum of the durations of connected calls
 *  - avg call duration = talk time ÷ connected calls
 * and from the requirements:
 *  - conversations     = connected calls longer than the conversation threshold (default 60 s)
 *  - meeting rate      = meetings booked ÷ conversations (meetings are the positive outcomes callers saved with "meeting booked")
 */
function zoomFigures(report, conversationSeconds) {
  const { totalCalls, connected, notConnected, talkTime, avgDuration, longestDuration } = report.summary;
  const conversations = report.calls.filter((c) => c.connected && c.duration > conversationSeconds).length;
  return { totalCalls, connected, notConnected, talkTime, avgDuration, longestDuration, conversations };
}

/** The same figures from the calls dialed in the CRM (a person answered, by the outcome saved): used when Zoom is not available. */
function crmFigures(calls, conversationSeconds) {
  const connected = calls.filter((c) => c.connected === 1);
  // Calls whose Zoom record has not arrived yet have no duration and are left out of the talk time and the average.
  const timed = connected.filter((c) => c.duration !== null);
  const talkTime = sum(timed, (c) => c.duration);
  return {
    totalCalls: calls.length,
    connected: connected.length,
    notConnected: calls.length - connected.length,
    talkTime,
    avgDuration: timed.length ? Math.round(talkTime / timed.length) : 0,
    longestDuration: Math.max(0, ...timed.map((c) => c.duration)),
    conversations: connected.filter((c) => (c.duration || 0) > conversationSeconds).length,
  };
}

export async function analyticsReport(store, user, query, zoom = zoomApi) {
  const tz = store.setting('business_tz');
  const conversationSeconds = store.setting('conversation_seconds');
  const preset = RANGES.has(query.range) ? query.range : 'today';
  const range = resolveRange({ preset, from: query.from, to: query.to, tz });
  const today = resolveRange({ preset: 'today', tz });
  const userId = callerFilter(user, query);
  const listId = Number(query.list) || null;
  const calls = callsBetween(store, range.from, range.to, userId, listId);

  // Call counts come from Zoom, like the Zoom call log. Without Zoom (not set up, or it cannot be reached) they come from the
  // calls dialed in the CRM instead, and zoomError says why.
  let records = null;
  let zoomError = null;
  if (zoom.configured()) {
    try {
      records = { range: (await zoom.callHistory(range)).items, today: (await zoom.callHistory(today)).items };
    } catch (error) {
      zoomError = error.message;
    }
  }
  const crm = records && crmView(store, [...records.range, ...records.today]);
  const zoomCalls = records && zoomReport(store, crm, records.range, range, { userId, listId });

  const figures = zoomCalls ? zoomFigures(zoomCalls, conversationSeconds) : crmFigures(calls, conversationSeconds);
  const meetings = calls.filter(isMeeting).length;
  // The outcome saved for each call counted above (calls dialed outside the CRM have none).
  const outcomes = zoomCalls ? zoomCalls.calls.map((c) => crm.outcome(c.id)) : calls.map((c) => c.disposition);

  const dispositions = store.all('SELECT key, label, connected, active FROM dispositions ORDER BY position');
  const breakdown = [...dispositions, { key: null, label: 'Outcome not saved yet', connected: 0, active: 0 }]
    .map((d) => ({ ...d, count: outcomes.filter((outcome) => (outcome ?? null) === d.key).length }))
    .filter((d) => d.count > 0 || d.active)
    .map((d) => ({ ...d, share: ratio(d.count, outcomes.length) }));

  // Daily targets are always for today, per caller: everyone with a caller account plus anyone who made calls today.
  const todayCalls = records && zoomReport(store, crm, records.today, today, {});
  const active = new Set([
    ...store.all('SELECT DISTINCT user_id FROM calls WHERE started_at >= ? AND started_at < ?', today.from.toISOString(), today.to.toISOString()).map((c) => c.user_id),
    ...(todayCalls ? todayCalls.calls.map((c) => crm.owner.get(c.id)) : []),
  ].filter(Boolean));
  const people = userId
    ? store.all('SELECT * FROM users WHERE id = ?', userId)
    : store.all(`SELECT * FROM users WHERE active = 1 AND (role = 'caller' OR id IN (${[...active].map(() => '?').join(', ') || 'NULL'})) ORDER BY name`, ...active);
  const targets = people.map((person) => {
    const mine = callsBetween(store, today.from, today.to, person.id, listId);
    const done = records
      ? zoomFigures(zoomReport(store, crm, records.today, today, { userId: person.id, listId }), conversationSeconds)
      : crmFigures(mine, conversationSeconds);
    return {
      userId: person.id,
      name: person.name,
      calls: [done.totalCalls, person.target_calls],
      conversations: [done.conversations, person.target_conversations],
      meetings: [mine.filter(isMeeting).length, person.target_meetings],
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
    // Where the call counts come from: 'zoom' (matches the Zoom call log) or 'crm' (only calls dialed from the CRM).
    source: zoomCalls ? 'zoom' : 'crm',
    zoomError,
    range: { preset: range.preset, label: range.label, firstDay: range.firstDay, lastDay: range.lastDay, tz },
    conversationSeconds,
    summary: {
      ...figures,
      connectRate: ratio(figures.connected, figures.totalCalls),
      meetings,
      meetingRate: ratio(meetings, figures.conversations),
      withOutcome: outcomes.filter(Boolean).length,
      pendingOutcome: calls.filter((c) => !c.disposition).length,
      awaitingZoom: zoomCalls ? 0 : calls.filter((c) => !c.zoom_uuid).length,
    },
    breakdown,
    targets,
    pipeline,
    calls,
    zoomCalls: zoomCalls?.calls ?? null,
  };
}

export function analyticsRoutes(store, zoom = zoomApi) {
  const r = express.Router();

  r.get('/analytics', async (req, res) => {
    const { calls, zoomCalls, ...report } = await analyticsReport(store, req.user, req.query, zoom);
    res.json(report);
  });

  r.get('/analytics/export', async (req, res) => {
    const report = await analyticsReport(store, req.user, req.query, zoom);
    const s = report.summary;
    const pct = (x) => (x === null ? '' : `${Math.round(x * 100)}%`);
    await sendWorkbook(res, 'call-report', [
      {
        name: 'Summary',
        columns: [['metric', 'Metric', 28], ['value', 'Value', 16]],
        rows: [
          { metric: 'Period', value: report.range.firstDay === report.range.lastDay ? report.range.firstDay : `${report.range.firstDay} to ${report.range.lastDay}` },
          { metric: 'Call numbers from', value: report.source === 'zoom' ? 'Zoom (as in the Zoom call log)' : 'Calls dialed from the CRM' },
          { metric: 'Total calls', value: s.totalCalls },
          { metric: 'Connected calls', value: s.connected },
          { metric: 'Connection rate', value: pct(s.connectRate) },
          { metric: 'Total talk time (seconds)', value: s.talkTime },
          { metric: 'Average call duration (seconds)', value: s.connected ? s.avgDuration : '' },
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
      report.zoomCalls && {
        name: 'Zoom calls',
        columns: [
          ['started', 'Started', 18], ['direction', 'Direction', 12], ['number', 'Number', 16], ['name', 'Name in Zoom', 24],
          ['agent', 'Zoom user', 24], ['result', 'Result', 16], ['duration', 'Duration (s)', 12],
        ],
        rows: report.zoomCalls.map((c) => ({ ...c, started: stamp(c.start, report.range.tz) })),
      },
      {
        name: 'CRM calls',
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
    ].filter(Boolean));
  });

  return r;
}

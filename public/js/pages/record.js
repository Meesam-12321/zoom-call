// Company and contact pages: lead panel with calling, contacts, call history, tasks, pipeline, details and history.
import { startCall } from '../call.js';
import { bestPhone, leadPanel, phonesOf } from '../lead.js';
import {
  api, badge, busy, confirmDialog, field, fmt, h, icon, localInput, outcomeBadge, pageHead, select, toast,
} from '../ui.js';
import { addToListDialog, newContactDialog } from './leads.js';
import { taskTable } from './today.js';

const COMPANY_EDIT = [
  ['name', 'Company name'], ['hq_phone', 'HQ phone'], ['website', 'Website'], ['email', 'Email'], ['industry', 'Industry'],
  ['status', 'Status'], ['category', 'Category'], ['priority', 'Priority'], ['revenue_range', 'Revenue range'],
  ['employee_range', 'Employee range'], ['city', 'City'], ['state', 'State', 'state'], ['region', 'Region'],
  ['time_zone', 'Time zone', 'tz'], ['address', 'Address', 'wide'], ['linkedin_url', 'LinkedIn URL', 'wide'],
  ['date_founded', 'Date founded'], ['lead_score', 'Lead score', 'number'], ['about', 'About', 'textarea'],
];
const CONTACT_EDIT = [
  ['first_name', 'First name'], ['last_name', 'Last name'], ['middle_name', 'Middle name'], ['job_title', 'Job title'],
  ['role_type', 'Role', 'role'], ['department', 'Department'], ['email', 'Email', 'email'], ['mobile', 'Mobile'],
  ['direct_line', 'Direct line'], ['location', 'Location'], ['linkedin_url', 'LinkedIn URL', 'wide'], ['notes', 'Notes', 'textarea'],
];
const ZONES = [
  ['America/New_York', 'US Eastern'], ['America/Chicago', 'US Central'], ['America/Denver', 'US Mountain'], ['America/Phoenix', 'Arizona'],
  ['America/Los_Angeles', 'US Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii'],
  ['America/Detroit', 'Michigan (Eastern)'], ['America/Indiana/Indianapolis', 'Indiana (Eastern)'], ['America/Boise', 'Idaho (Mountain)'],
];

function withCurrent(options, value) {
  return value && !options.some(([key]) => key === value) ? [...options, [value, value]] : options;
}

function panel(title, count, ...content) {
  return h('section', { class: 'card panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, title, count !== null && count !== undefined ? h('span', { class: 'count' }, count) : null)),
    content);
}

function detailsForm(ctx, title, fields, record, endpoint, onSaved, { owner = false } = {}) {
  const inputs = {};
  const controls = fields.map(([key, label, kind]) => {
    const value = record[key] ?? '';
    let input;
    if (kind === 'textarea') input = h('textarea', { rows: 4, value });
    else if (kind === 'state') input = select(withCurrent([['', '—'], ...Object.entries(ctx.meta.states)], value), value);
    else if (kind === 'tz') input = select(withCurrent([['', 'Automatic (from state and area code)'], ...ZONES], value), value);
    else if (kind === 'role') input = select(ctx.meta.roleTypes, value);
    else input = h('input', { type: kind === 'number' || kind === 'email' ? kind : 'text', value });
    inputs[key] = input;
    return h('div', { class: kind === 'textarea' || kind === 'wide' ? 'wide' : '' }, field(label, input));
  });
  if (owner && ctx.isAdmin) {
    inputs.owner_id = select([['', 'Unassigned'], ...ctx.meta.users.map((u) => [String(u.id), u.name])], record.owner_id ? String(record.owner_id) : '');
    controls.push(h('div', {}, field('Owner (who calls this lead)', inputs.owner_id)));
  }
  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      const original = (key) => (key === 'owner_id' ? (record.owner_id ? String(record.owner_id) : '') : String(record[key] ?? ''));
      const body = Object.fromEntries(Object.entries(inputs).filter(([key, input]) => input.value !== original(key)).map(([key, input]) => [key, input.value]));
      if (!Object.keys(body).length) return toast('Nothing changed.');
      await api(endpoint, { method: 'PATCH', body });
      toast('Saved.', { kind: 'ok' });
      onSaved();
    }),
  }, 'Save changes');
  return panel(title, null, h('div', { class: 'form-grid' }, controls), h('div', { class: 'row end section-gap' }, save));
}

function dealCard(ctx, detail, onSaved) {
  const { deal, contacts } = detail;
  if (!deal) return null;
  const stage = select(ctx.meta.stages, deal.stage);
  const reasons = withCurrent([['', 'Choose a reason…'], ...ctx.meta.lostReasons.map((r) => [r, r])], deal.lost_reason);
  const lost = select(reasons, deal.lost_reason || '');
  const lostField = field('Lost reason', lost);
  const value = h('input', { type: 'number', min: 0, step: 1, value: deal.value ?? '' });
  const nextStep = h('input', { type: 'text', value: deal.next_step ?? '' });
  const nextDate = h('input', { type: 'date', value: deal.next_step_date ?? '' });
  const primary = select([['', 'Not set'], ...contacts.map((c) => [String(c.id), fmt.name(c)])], deal.contact_id ? String(deal.contact_id) : '');
  const toggle = () => {
    lostField.hidden = stage.value !== 'lost';
  };
  stage.addEventListener('change', toggle);
  toggle();
  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      const next = { stage: stage.value, lost_reason: lost.value, value: value.value, next_step: nextStep.value, next_step_date: nextDate.value, contact_id: primary.value };
      const before = { stage: deal.stage, lost_reason: deal.lost_reason ?? '', value: deal.value ?? '', next_step: deal.next_step ?? '', next_step_date: deal.next_step_date ?? '', contact_id: deal.contact_id ? String(deal.contact_id) : '' };
      const body = Object.fromEntries(Object.entries(next).filter(([key, v]) => String(v) !== String(before[key])));
      if (!Object.keys(body).length) return toast('Nothing changed.');
      if (body.stage === 'lost' || (next.stage === 'lost' && 'lost_reason' in body)) body.lost_reason = lost.value;
      await api(`/deals/${deal.id}`, { method: 'PATCH', body });
      toast('Pipeline updated.', { kind: 'ok' });
      onSaved();
    }),
  }, 'Save');
  return panel('Pipeline', null,
    h('div', { class: 'form-grid' },
      field('Stage', stage), field('Value ($)', value),
      h('div', { class: 'wide' }, lostField),
      h('div', { class: 'wide' }, field('Next step', nextStep)),
      field('Next step date', nextDate), field('Primary contact', primary)),
    h('div', { class: 'row end section-gap' }, h('span', { class: 'muted small' }, `Updated ${fmt.ago(deal.updated_at)}`), save));
}

function callsCard(ctx, calls) {
  const onLine = (c) => {
    if (c.duration !== null && c.duration !== undefined) return fmt.clock(c.duration);
    return h('span', { class: 'muted', title: 'Zoom adds the duration within a few minutes of the call.' }, Date.now() - Date.parse(c.started_at) < 3 * 86_400_000 ? 'Waiting for Zoom' : '—');
  };
  return panel('Calls', calls.length, calls.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Outcome'), h('th', {}, 'Number'), h('th', { class: 'num' }, 'On the line'), h('th', {}, 'Caller'), h('th', {}, 'Notes'))),
      h('tbody', {}, calls.map((c) => h('tr', {},
        h('td', { class: 'time' }, fmt.dateTime(c.started_at)),
        h('td', {}, outcomeBadge(ctx, c.disposition), c.meeting_booked ? h('div', {}, badge('Meeting booked', 'ok')) : null,
          c.recording_status && c.recording_status !== 'non_recorded' ? h('div', {}, badge('Recorded in Zoom', 'info')) : null),
        h('td', { class: 'number' }, fmt.phone(c.phone_e164), c.first_name || c.last_name ? h('div', { class: 'sub' }, fmt.name(c)) : null),
        h('td', { class: 'num' }, onLine(c)),
        h('td', {}, c.user_name || '—'),
        h('td', { class: 'wrap' }, c.notes || h('span', { class: 'muted' }, '—')))))))
    : h('p', { class: 'muted' }, 'No calls yet.'));
}

function tasksCard(ctx, detail, { contactId, companyId, onChange }) {
  const open = detail.tasks.filter((t) => t.status === 'open' && (!contactId || !t.contact_id || t.contact_id === contactId));
  const type = select(ctx.meta.taskTypes, 'call');
  const title = h('input', { type: 'text', placeholder: 'e.g. Call back the owner, send the case study' });
  const tomorrow = new Date(Date.now() + 86_400_000);
  const due = h('input', { type: 'datetime-local', value: `${localInput(tomorrow).slice(0, 10)}T10:00` });
  const callback = h('input', { type: 'checkbox' });
  const add = h('button', {
    class: 'btn secondary',
    type: 'button',
    onclick: () => busy(add, async () => {
      await api('/tasks', { method: 'POST', body: { contact_id: contactId, company_id: companyId, type: type.value, title: title.value, due: due.value, is_callback: callback.checked } });
      toast('Task added.', { kind: 'ok' });
      onChange();
    }),
  }, icon('plus'), 'Add task');
  return panel('Tasks', open.length,
    open.length ? taskTable(ctx, open, { onChange, showDate: true, showLead: false }) : h('p', { class: 'muted' }, 'No open tasks. Every lead should have a next step.'),
    h('div', { class: 'form-grid section-gap' },
      h('div', { class: 'wide' }, field('New task', title)),
      field('Type', type),
      field(`Due (${fmt.zoneName(ctx.meta.settings.business_tz)})`, due),
      h('label', { class: 'check' }, callback, 'Callback (remind me 10 minutes before)'),
      h('div', { class: 'row end' }, add)));
}

const STAGE_NAME = (ctx, key) => Object.fromEntries(ctx.meta.stages)[key] || key || '—';

function describe(ctx, entry) {
  const d = entry.details || {};
  const what = { company: 'Company', contact: 'Contact', deal: 'Pipeline' }[entry.entity] || entry.entity;
  const changes = () => Object.entries(d)
    .filter(([, v]) => Array.isArray(v))
    .map(([key, [from, to]]) => `${key.replace(/_/g, ' ')}: ${from ?? '—'} → ${to ?? '—'}`)
    .join('; ');
  switch (entry.action) {
    case 'created':
      return `${what} created`;
    case 'imported':
      return `${what} imported from a spreadsheet`;
    case 'merged from import':
      return `${what} gaps filled from a spreadsheet: ${changes()}`;
    case 'updated':
      return `${what} edited: ${changes()}`;
    case 'stage_changed':
      return `Stage ${STAGE_NAME(ctx, d.stage?.[0])} → ${STAGE_NAME(ctx, d.stage?.[1])}${d.lost_reason?.[1] ? ` (lost reason: ${d.lost_reason[1]})` : ''}${d.via ? `, after the outcome "${d.via}"` : ''}`;
    case 'do_not_call_set':
      return `Marked Do Not Call${d.via ? ` (outcome "${d.via}")` : ''}`;
    case 'do_not_call_cleared':
      return 'Do Not Call removed';
    default:
      return `${what} ${entry.action.replace(/_/g, ' ')}`;
  }
}

function historyCard(ctx, activity) {
  return panel('History', null, activity.length
    ? h('ul', { class: 'timeline' }, activity.slice(0, 50).map((entry) => h('li', {},
      h('div', { class: 'meta' }, h('span', {}, fmt.dateTime(entry.created_at)), h('span', {}, entry.user_name || 'System')),
      h('p', {}, describe(ctx, entry)))))
    : h('p', { class: 'muted' }, 'No changes yet.'));
}

function dncButton(ctx, path, record, onChange) {
  const on = Boolean(record.do_not_call);
  if (on && !ctx.isAdmin) return badge('Do Not Call', 'missed');
  return h('button', {
    class: 'btn secondary',
    type: 'button',
    onclick: async (event) => {
      const button = event.currentTarget;
      if (!on && !(await confirmDialog({ title: 'Mark as Do Not Call?', message: 'Calls to this lead will be blocked. Only an admin can undo this.', confirm: 'Mark Do Not Call', danger: true }))) return;
      await busy(button, async () => {
        await api(`${path}/dnc`, { method: 'POST', body: { on: !on } });
        onChange();
      });
    },
  }, icon('ban'), on ? 'Remove Do Not Call' : 'Do Not Call');
}

function deleteButton(ctx, path, label, after) {
  if (!ctx.isAdmin) return null;
  return h('button', {
    class: 'btn ghost',
    type: 'button',
    onclick: async (event) => {
      const button = event.currentTarget;
      if (!(await confirmDialog({ title: `Delete ${label}?`, message: 'This also deletes its calls and tasks. The activity log keeps a record.', confirm: 'Delete', danger: true }))) return;
      await busy(button, async () => {
        await api(path, { method: 'DELETE' });
        toast('Deleted.');
        ctx.navigate(after);
      });
    },
  }, icon('trash'), 'Delete');
}

function wrongNumbersCard(detail, onChange) {
  if (!detail.invalid.length) return null;
  return panel('Wrong numbers', detail.invalid.length,
    h('p', { class: 'muted' }, 'These numbers were marked as wrong after a call, so they cannot be dialed.'),
    detail.invalid.map((e164) => h('div', { class: 'phone-row' }, h('span', { class: 'number' }, fmt.phone(e164)), h('button', {
      class: 'btn small secondary',
      type: 'button',
      onclick: (event) => busy(event.currentTarget, async () => {
        await api(`/invalid-numbers/${encodeURIComponent(e164)}`, { method: 'DELETE' });
        onChange();
      }),
    }, 'Mark as valid'))));
}

export async function renderContact(root, { id }, ctx, isCurrent) {
  const detail = await api(`/contacts/${id}`);
  if (!isCurrent()) return;
  const { contact, company } = detail;
  const reload = () => ctx.rerender();
  const colleagues = detail.contacts.filter((c) => c.id !== contact.id);

  root.replaceChildren(
    pageHead(fmt.name(contact), [contact.job_title, company.name].filter(Boolean).join(' · '), [
      dncButton(ctx, `/contacts/${contact.id}`, contact, reload),
      deleteButton(ctx, `/contacts/${contact.id}`, 'this contact', '#/leads'),
    ], ['Leads', '#/leads']),
    h('div', { class: 'split' },
      h('div', { class: 'stack' },
        leadPanel(ctx, detail, { onCall: (phone) => startCall(ctx, { contactId: contact.id, phone, onDone: reload }) }),
        wrongNumbersCard(detail, reload),
        callsCard(ctx, detail.calls),
        tasksCard(ctx, detail, { contactId: contact.id, companyId: company.id, onChange: reload }),
        historyCard(ctx, detail.activity)),
      h('div', { class: 'stack' },
        dealCard(ctx, detail, reload),
        detailsForm(ctx, 'Contact details', CONTACT_EDIT, contact, `/contacts/${contact.id}`, reload),
        panel('Call lists', detail.lists.length,
          detail.lists.length ? h('div', { class: 'row' }, detail.lists.map((l) => h('a', { class: 'badge info', href: `#/list/${l.id}` }, l.name))) : h('p', { class: 'muted' }, 'Not on any call list.'),
          h('div', { class: 'row end section-gap' }, h('button', { class: 'btn small secondary', type: 'button', onclick: () => addToListDialog(ctx, { contactIds: [contact.id] }) }, icon('plus', 14), 'Add to a call list'))),
        panel(`Others at ${company.name}`, colleagues.length, colleagues.length
          ? h('ul', { class: 'timeline' }, colleagues.map((c) => h('li', {},
            h('a', { href: `#/contact/${c.id}` }, fmt.name(c)),
            h('div', { class: 'sub' }, [c.job_title, phonesOf(c, null)[0] && fmt.phone(phonesOf(c, null)[0].e164)].filter(Boolean).join(' · ')))))
          : h('p', { class: 'muted' }, 'No other contacts.')))),
  );
}

export async function renderCompany(root, { id }, ctx, isCurrent) {
  const detail = await api(`/companies/${id}`);
  if (!isCurrent()) return;
  const { company, contacts } = detail;
  const reload = () => ctx.rerender();
  const max = ctx.meta.settings.max_attempts;

  const contactsTable = contacts.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Contact'), h('th', {}, 'Phone'), h('th', {}, 'Last outcome'), h('th', { class: 'num' }, 'Attempts'), h('th', {}))),
      h('tbody', {}, contacts.map((c) => {
        const phone = bestPhone(c, company);
        const blocked = Boolean(c.do_not_call || company.do_not_call);
        return h('tr', {},
          h('td', { class: 'title-cell' }, h('a', { href: `#/contact/${c.id}` }, fmt.name(c)), h('div', { class: 'sub' }, c.job_title || '')),
          h('td', { class: 'number' }, phone ? fmt.phone(phone) : '—', c.do_not_call ? h('div', {}, badge('Do Not Call', 'missed')) : null),
          h('td', {}, c.last_disposition ? outcomeBadge(ctx, c.last_disposition) : h('span', { class: 'muted' }, 'Never called')),
          h('td', { class: 'num' }, c.attempts >= max ? badge(`${c.attempts}/${max}`, 'missed') : c.attempts),
          h('td', { class: 'actions' }, phone && h('button', {
            class: 'btn small call',
            type: 'button',
            disabled: blocked,
            onclick: () => startCall(ctx, { contactId: c.id, phone, onDone: reload }),
          }, icon('phone', 14), 'Call')));
      }))))
    : h('p', { class: 'muted' }, 'No contacts yet.');

  root.replaceChildren(
    pageHead(company.name, [company.city, company.state].filter(Boolean).join(', ') || null, [
      dncButton(ctx, `/companies/${company.id}`, company, reload),
      deleteButton(ctx, `/companies/${company.id}`, company.name, '#/leads?view=companies'),
    ], ['Leads', '#/leads?view=companies']),
    h('div', { class: 'split' },
      h('div', { class: 'stack' },
        leadPanel(ctx, { ...detail, contact: null }, { onCall: (phone) => startCall(ctx, { companyId: company.id, phone, onDone: reload }) }),
        wrongNumbersCard(detail, reload),
        panel('Contacts', contacts.length, contactsTable,
          h('div', { class: 'row end section-gap' }, h('button', { class: 'btn small secondary', type: 'button', onclick: () => newContactDialog(ctx, company.id) }, icon('plus', 14), 'Add contact'))),
        callsCard(ctx, detail.calls),
        tasksCard(ctx, detail, { companyId: company.id, onChange: reload }),
        historyCard(ctx, detail.activity)),
      h('div', { class: 'stack' },
        dealCard(ctx, detail, reload),
        detailsForm(ctx, 'Company details', COMPANY_EDIT, company, `/companies/${company.id}`, reload, { owner: true }))),
  );
}

// Company and contact pages: lead panel with calling, contacts, call history, tasks, pipeline, details and history.
import { startCall } from '../call.js';
import { bestPhone, callTimeline, leadPanel, phonesOf, urlLinks } from '../lead.js';
import { logCallDialog } from '../logcall.js';
import { canEmail, emailButton, emailLink, threadRow } from '../mail.js';
import {
  api, badge, busy, confirmDialog, field, fill, fmt, h, icon, localInput, outcomeBadge, pageHead, select, toast,
} from '../ui.js';
import { addToListDialog, newContactDialog } from './leads.js';
import { taskTable } from './today.js';

// Fields and their labels come from the import sheet (ctx.meta.companyFields / contactFields). This is how each is
// edited; the rest are one-line text boxes.
const FIELD_KINDS = {
  about: 'textarea', evidence_notes: 'textarea', key_people: 'textarea', source_urls: 'textarea', notes: 'textarea',
  address: 'wide', current_address: 'wide', state: 'state', time_zone: 'tz', lead_score: 'number', role_type: 'role', email: 'email',
};
const URL_FIELDS = new Set(['website', 'linkedin_url', 'facebook_url', 'instagram_url', 'source_urls']);
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

function displayValue(ctx, key, value) {
  if (URL_FIELDS.has(key)) {
    const links = urlLinks(value);
    return links.length ? h('div', { class: 'url-list' }, links) : String(value);
  }
  if (key === 'email') return emailLink(ctx, value, { class: 'url', title: value });
  if (key === 'state') return ctx.meta.states[value] || value;
  if (key === 'time_zone') return `${ZONES.find(([zone]) => zone === value)?.[1] || value} (${fmt.zoneName(value)})`;
  if (key === 'role_type') return Object.fromEntries(ctx.meta.roleTypes)[value] || value;
  return String(value);
}

/** A record's sheet fields: the filled ones listed in sheet order, and every one editable after "Edit". */
function detailsCard(ctx, title, fields, record, endpoint, onSaved, { owner = false } = {}) {
  const editable = fields.filter(([key]) => key !== 'do_not_call');
  const body = h('div', {});
  const editButton = h('button', { class: 'btn small secondary', type: 'button', onclick: () => edit() }, 'Edit');

  const view = () => {
    editButton.hidden = false;
    const filled = editable.filter(([key]) => record[key] !== null && record[key] !== undefined && record[key] !== '');
    const blank = editable.length - filled.length;
    const ownerName = record.owner_id ? ctx.meta.users.find((u) => u.id === record.owner_id)?.name : 'Unassigned';
    fill(body,
      h('dl', { class: 'details' },
        filled.map(([key, label]) => h('div', {}, h('dt', {}, label), h('dd', {}, displayValue(ctx, key, record[key])))),
        owner && h('div', {}, h('dt', {}, 'Owner (who calls this lead)'), h('dd', {}, ownerName || '—')),
        // Where the record came from: the file an import created it from, or typed in.
        h('div', {}, h('dt', {}, 'Source'), h('dd', {}, [record.source ? `Imported from ${record.source}` : 'Added by hand', fmt.date(record.created_at)].join(' · ')))),
      blank > 0 && h('p', { class: 'muted small section-gap' }, `${blank} empty field${blank === 1 ? ' is' : 's are'} hidden. Choose Edit to fill ${blank === 1 ? 'it' : 'them'} in.`));
  };

  const edit = () => {
    editButton.hidden = true;
    const inputs = {};
    const controls = editable.map(([key, label]) => {
      const kind = FIELD_KINDS[key];
      const value = record[key] ?? '';
      let input;
      if (kind === 'textarea') input = h('textarea', { rows: 4, value });
      else if (kind === 'state') input = select(withCurrent([['', '—'], ...Object.entries(ctx.meta.states)], value), value);
      else if (kind === 'tz') input = select(withCurrent([['', 'Automatic (from state and area code)'], ...ZONES], value), value);
      else if (kind === 'role') input = select(ctx.meta.roleTypes, value);
      else input = h('input', { type: kind === 'number' || kind === 'email' ? kind : 'text', value });
      inputs[key] = input;
      return h('div', { class: kind === 'textarea' || kind === 'wide' ? 'wide' : null }, field(label, input));
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
        const changes = Object.fromEntries(Object.entries(inputs).filter(([key, input]) => input.value !== original(key)).map(([key, input]) => [key, input.value]));
        if (!Object.keys(changes).length) return toast('Nothing changed.');
        await api(endpoint, { method: 'PATCH', body: changes });
        toast('Saved.', { kind: 'ok' });
        onSaved();
      }),
    }, 'Save changes');
    fill(body,
      h('div', { class: 'form-grid auto' }, controls),
      h('div', { class: 'row end section-gap' }, h('button', { class: 'btn secondary', type: 'button', onclick: view }, 'Cancel'), save));
    body.querySelector('input, select, textarea')?.focus();
  };

  view();
  return h('section', { class: 'card panel' }, h('div', { class: 'panel-head' }, h('h2', {}, title), editButton), body);
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

// Same layout as History: each call's details on one line and its notes in full underneath, at any width.
function callsCard(ctx, calls) {
  return panel('Calls', calls.length, calls.length ? callTimeline(ctx, calls) : h('p', { class: 'muted' }, 'No calls yet.'));
}

// Gmail's search takes a few seconds to find a message that was just sent.
const SEARCH_LAG_MS = 5000;
let emailSentAt = 0;

// Conversations with the lead, straight from the mailbox. Filled in after the page shows, so Gmail never slows it down.
function emailsCard(ctx, lead) {
  if (!canEmail(ctx)) return null;
  const count = h('span', { class: 'count', hidden: true });
  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading emails…'));
  const load = () => api(`/mail/lead-threads?${new URLSearchParams(lead)}`)
    .then(({ threads, addresses }) => {
      count.textContent = threads.length;
      count.hidden = !threads.length;
      fill(body, threads.length
        ? h('div', { class: 'mail-rows compact' }, threads.map((thread) => threadRow(thread, location.hash)))
        : h('p', { class: 'muted' }, addresses.length ? 'No emails with this lead yet.' : 'No email address on file.'));
    })
    .catch((error) => fill(body, h('p', { class: 'muted' }, error.message)));
  load();
  // Only this card refreshes later: reloading the page would wipe anything typed on it in the meantime.
  if (Date.now() - emailSentAt < SEARCH_LAG_MS) {
    setTimeout(() => {
      if (body.isConnected) load();
    }, SEARCH_LAG_MS);
  }
  return h('section', { class: 'card panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Emails', count)), body);
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

// What an import did with a later row that repeated this record.
const DUPLICATE_RESULT = {
  merge: 'merged into this record, empty fields filled',
  skip: 'skipped, nothing changed',
  create: 'created as a separate record anyway',
};

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
      return `${what} imported from ${d.file || 'a spreadsheet'}`;
    case 'merged from import':
      return `${what} gaps filled from a spreadsheet: ${changes()}`;
    case 'duplicate in import':
      return `${what} repeated in ${d.file} (${d.sheet}, row ${d.row}), matching on ${d.matched}: ${DUPLICATE_RESULT[d.result] || d.result}`;
    case 'updated':
      return `${what} edited: ${changes()}`;
    case 'stage_changed':
      return `Stage ${STAGE_NAME(ctx, d.stage?.[0])} → ${STAGE_NAME(ctx, d.stage?.[1])}${d.lost_reason?.[1] ? ` (lost reason: ${d.lost_reason[1]})` : ''}${d.via ? `, after the outcome "${d.via}"` : ''}`;
    case 'do_not_call_set':
      return `Marked Do Not Call${d.via ? ` (outcome "${d.via}")` : ''}`;
    case 'do_not_call_cleared':
      return 'Do Not Call removed';
    case 'email_sent':
      return `Email sent to ${(d.to || []).join(', ')}${d.subject ? `: "${d.subject}"` : ''}${d.do_not_call_override ? ' (despite Do Not Call)' : ''}`;
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
  const afterEmail = () => {
    emailSentAt = Date.now();
    reload();
  };

  root.replaceChildren(
    pageHead(fmt.name(contact), [contact.job_title, company.name].filter(Boolean).join(' · '), [
      h('button', { class: 'btn secondary', type: 'button', title: 'Record a call you made in Zoom', onclick: () => logCallDialog(ctx, { contactId: contact.id, onDone: reload }) }, icon('note'), 'Log call'),
      dncButton(ctx, `/contacts/${contact.id}`, contact, reload),
      deleteButton(ctx, `/contacts/${contact.id}`, 'this contact', '#/leads?view=contacts'),
    ], ['Leads', '#/leads?view=contacts']),
    h('div', { class: 'split' },
      h('div', { class: 'stack' },
        leadPanel(ctx, detail, { activity: false, onEmailSent: afterEmail, onCall: (phone) => startCall(ctx, { contactId: contact.id, phone, onDone: reload }) }),
        wrongNumbersCard(detail, reload),
        callsCard(ctx, detail.calls),
        emailsCard(ctx, { contactId: contact.id }),
        tasksCard(ctx, detail, { contactId: contact.id, companyId: company.id, onChange: reload }),
        historyCard(ctx, detail.activity)),
      h('div', { class: 'stack' },
        dealCard(ctx, detail, reload),
        detailsCard(ctx, 'Contact Information', ctx.meta.contactFields, contact, `/contacts/${contact.id}`, reload),
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
  const afterEmail = () => {
    emailSentAt = Date.now();
    reload();
  };
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
          h('td', { class: 'actions' }, h('div', { class: 'row end nowrap' },
            emailButton(ctx, { contactId: c.id }, { small: true, onSent: afterEmail }),
            phone && h('button', {
              class: 'btn small call',
              type: 'button',
              disabled: blocked,
              onclick: () => startCall(ctx, { contactId: c.id, phone, onDone: reload }),
            }, icon('phone', 14), 'Call'))));
      }))))
    : h('p', { class: 'muted' }, 'No contacts yet.');

  root.replaceChildren(
    pageHead(company.name, [company.city, company.state].filter(Boolean).join(', ') || null, [
      h('button', { class: 'btn secondary', type: 'button', title: 'Record a call you made in Zoom', onclick: () => logCallDialog(ctx, { companyId: company.id, onDone: reload }) }, icon('note'), 'Log call'),
      dncButton(ctx, `/companies/${company.id}`, company, reload),
      deleteButton(ctx, `/companies/${company.id}`, company.name, '#/leads?view=companies'),
    ], ['Leads', '#/leads?view=companies']),
    h('div', { class: 'split' },
      h('div', { class: 'stack' },
        leadPanel(ctx, { ...detail, contact: null }, { activity: false, onEmailSent: afterEmail, onCall: (phone) => startCall(ctx, { companyId: company.id, phone, onDone: reload }) }),
        wrongNumbersCard(detail, reload),
        panel('Contacts', contacts.length, contactsTable,
          h('div', { class: 'row end section-gap' }, h('button', { class: 'btn small secondary', type: 'button', onclick: () => newContactDialog(ctx, company.id) }, icon('plus', 14), 'Add contact'))),
        callsCard(ctx, detail.calls),
        emailsCard(ctx, { companyId: company.id }),
        tasksCard(ctx, detail, { companyId: company.id, onChange: reload }),
        historyCard(ctx, detail.activity)),
      h('div', { class: 'stack' },
        dealCard(ctx, detail, reload),
        detailsCard(ctx, 'Company Information', ctx.meta.companyFields, company, `/companies/${company.id}`, reload, { owner: true }))),
  );
}

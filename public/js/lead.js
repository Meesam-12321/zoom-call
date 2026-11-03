// The lead panel: who the caller is talking to, their numbers, local time, research note, script and history.
import { badge, fmt, h, icon, outcomeBadge, stageBadge } from './ui.js';

/** Callable numbers for a lead, best first (the contact's own lines, then the store / HQ line). */
export function phonesOf(contact, company) {
  const list = [];
  if (contact?.mobile_e164) list.push({ label: 'Mobile', e164: contact.mobile_e164 });
  if (contact?.direct_e164 && contact.direct_e164 !== contact.mobile_e164) list.push({ label: 'Direct line', e164: contact.direct_e164 });
  if (company?.hq_phone_e164 && !list.some((p) => p.e164 === company.hq_phone_e164)) list.push({ label: 'Store / HQ', e164: company.hq_phone_e164 });
  return list;
}

export const bestPhone = (contact, company) => phonesOf(contact, company)[0]?.e164 || null;

export const websiteUrl = (value) => (/^https?:\/\//i.test(value) ? value : `https://${value}`);

/** The call script with {first_name}, {company}, {city} and {caller} filled in. */
export function fillScript(ctx, contact, company) {
  // Placeholder contacts such as "Store Team" are not greeted by name.
  const generic = !contact || (!contact.last_name && /team|staff|store|front desk|reception/i.test(contact.first_name || ''));
  const values = {
    first_name: generic ? 'there' : contact.first_name || 'there',
    last_name: contact?.last_name || '',
    company: company.name,
    city: company.city || '',
    caller: ctx.user.name.split(' ')[0],
  };
  return String(ctx.meta.settings.script || '').replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
}

export function consentLine(ctx, company) {
  const mode = ctx.meta.settings.recording_consent?.[company.state] || 'off';
  const where = ctx.meta.states[company.state] || company.state || 'this state';
  return h('p', { class: 'consent' }, icon('alert', 14), mode === 'notice'
    ? `Recording is on for ${where}: a "this call may be recorded" notice must play or be said at the start.`
    : `Recording is off for ${where} calls. Do not record without every party's consent.`);
}

const kv = (label, value) => h('div', { class: 'kv' }, h('span', {}, label), h('strong', {}, value));
const block = (title, ...content) => h('div', { class: 'block' }, h('h3', {}, title), content);

export function callTimeline(ctx, calls) {
  return h('ul', { class: 'timeline' }, calls.map((c) => h('li', {},
    h('div', { class: 'meta' },
      outcomeBadge(ctx, c.disposition),
      h('span', {}, fmt.ago(c.started_at)),
      c.duration !== null && c.duration !== undefined && h('span', {}, `${fmt.clock(c.duration)} on the line`),
      h('span', {}, fmt.phone(c.phone_e164)),
      c.user_name && h('span', {}, c.user_name)),
    c.notes && h('p', {}, c.notes))));
}

export function taskList(ctx, tasks) {
  const types = Object.fromEntries(ctx.meta.taskTypes);
  return h('ul', { class: 'timeline' }, tasks.map((t) => h('li', {},
    h('div', { class: 'meta' },
      badge(types[t.type] || t.type, 'neutral'),
      t.is_callback ? badge('Callback', 'info') : null,
      h('span', {}, `Due ${fmt.dateTime(t.due_at)}`),
      t.user_name && h('span', {}, t.user_name)),
    h('p', {}, t.title))));
}

export function leadPanel(ctx, detail, { onCall, compact = false } = {}) {
  const { contact, company, deal, calls = [], tasks = [], invalid = [] } = detail;
  const blocked = Boolean(contact?.do_not_call || company.do_not_call);
  const max = ctx.meta.settings.max_attempts;
  const roles = Object.fromEntries(ctx.meta.roleTypes);
  const openTasks = tasks.filter((t) => t.status === 'open' && (!contact || !t.contact_id || t.contact_id === contact.id));
  const extra = { ...(company.extra || {}), ...(contact?.extra || {}) };
  const phones = phonesOf(contact, company);

  return h('section', { class: 'card panel lead' },
    h('div', { class: 'lead-head' },
      h('div', {},
        h('h2', {}, contact ? fmt.name(contact) : company.name),
        h('div', { class: 'muted' },
          contact?.job_title ? `${contact.job_title} · ` : '',
          contact ? h('a', { href: `#/company/${company.id}` }, company.name) : [company.city, company.state].filter(Boolean).join(', '))),
      h('div', { class: 'row' },
        deal && stageBadge(ctx, deal.stage),
        contact && contact.role_type !== 'other' && badge(roles[contact.role_type] || contact.role_type, 'info'),
        blocked && badge('Do Not Call', 'missed'),
        contact && badge(`${contact.attempts}/${max} attempts`, contact.attempts >= max ? 'missed' : 'neutral'))),
    h('div', { class: 'facts' },
      kv('Their local time', fmt.localTime(company.time_zone)),
      kv('Location', [company.city, company.state].filter(Boolean).join(', ') || '—'),
      company.priority && kv('Priority', company.priority),
      company.website && kv('Website', h('a', { href: websiteUrl(company.website), target: '_blank', rel: 'noopener noreferrer' }, company.website.replace(/^https?:\/\//i, ''))),
      contact?.email && kv('Email', contact.email),
      kv('Last called', fmt.ago(contact ? contact.last_called_at : calls[0]?.started_at))),
    h('div', { class: 'phones' }, phones.length
      ? phones.map((p) => {
        const wrong = invalid.includes(p.e164);
        return h('div', { class: 'phone-row' },
          h('span', { class: 'muted small' }, p.label),
          h('span', { class: 'number' }, fmt.phone(p.e164)),
          wrong && badge('Wrong number', 'missed'),
          onCall && h('button', { class: 'btn call', type: 'button', disabled: blocked || wrong, onclick: () => onCall(p.e164) }, icon('phone'), 'Call'));
      })
      : h('p', { class: 'muted' }, 'No phone number on file.')),
    contact?.notes && block('Research note', h('div', { class: 'note-box' }, contact.notes)),
    block('Script', h('div', { class: 'script' }, fillScript(ctx, contact, company))),
    consentLine(ctx, company),
    openTasks.length > 0 && block('Open tasks', taskList(ctx, openTasks)),
    calls.length > 0 && block('Recent calls', callTimeline(ctx, calls.slice(0, compact ? 3 : 6))),
    !compact && Object.keys(extra).length > 0 && h('details', { class: 'extra block' },
      h('summary', {}, `More from the spreadsheet (${Object.keys(extra).length})`),
      h('dl', {}, Object.entries(extra).map(([key, value]) => [h('dt', {}, key), h('dd', {}, value)]))));
}

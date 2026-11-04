// The lead panel: who the caller is talking to, their numbers, local time, research note, script and history.
import { canEmail, emailButton, emailLink } from './mail.js';
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

/** The value as an http(s) URL, or null (so a spreadsheet can never inject another kind of link). */
export function safeUrl(value) {
  try {
    const url = new URL(websiteUrl(String(value).trim()));
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.') ? url : null;
  } catch {
    return null;
  }
}

/** Links for every URL in the text (the sheet puts one per line), each once, labeled by site and page. */
export function urlLinks(text) {
  const urls = new Map(String(text || '').split(/\s+/).map(safeUrl).filter(Boolean).map((url) => [url.href, url]));
  return [...urls.values()].map((url) =>
    h('a', { class: 'url', href: url.href, target: '_blank', rel: 'noopener noreferrer', title: url.href },
      `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`));
}

/** The sheet's own column name for a field, e.g. area → "Florida Region". */
export const fieldLabel = (fields, key) => fields.find(([k]) => k === key)?.[1] || key;

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

// Single-word values (emails, web addresses) are cut short with "…" instead of breaking mid-word; hovering shows them in full.
const kv = (label, value, { full } = {}) => h('div', { class: 'kv' }, h('span', {}, label), h('strong', { class: full ? 'truncate' : null, title: full }, value));
const block = (title, ...content) => h('div', { class: 'block' }, h('h3', {}, title), content);

/** "4:12 on the line", or a note while Zoom has not reported the call yet (it does within a few minutes). */
function onTheLine(call) {
  if (call.duration !== null && call.duration !== undefined) return h('span', {}, `${fmt.clock(call.duration)} on the line`);
  if (Date.now() - Date.parse(call.started_at) < 3 * 86_400_000) return h('span', { title: 'Zoom adds the duration within a few minutes of the call.' }, 'Waiting for Zoom');
  return null;
}

export function callTimeline(ctx, calls) {
  return h('ul', { class: 'timeline' }, calls.map((c) => h('li', {},
    h('div', { class: 'meta' },
      outcomeBadge(ctx, c.disposition),
      c.meeting_booked ? badge('Meeting booked', 'ok') : null,
      c.recording_status && c.recording_status !== 'non_recorded' ? badge('Recorded in Zoom', 'info') : null,
      h('span', {}, fmt.ago(c.started_at)),
      onTheLine(c),
      h('span', {}, fmt.phone(c.phone_e164)),
      (c.first_name || c.last_name) && h('span', {}, fmt.name(c)),
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

/** `activity: false` leaves out open tasks and recent calls, for pages that show them in their own cards. */
export function leadPanel(ctx, detail, { onCall, onEmailSent, compact = false, activity = true } = {}) {
  const { contact, company, deal, calls = [], tasks = [], invalid = [] } = detail;
  const blocked = Boolean(contact?.do_not_call || company.do_not_call);
  const max = ctx.meta.settings.max_attempts;
  const roles = Object.fromEntries(ctx.meta.roleTypes);
  const openTasks = tasks.filter((t) => t.status === 'open' && (!contact || !t.contact_id || t.contact_id === contact.id));
  const extra = { ...(company.extra || {}), ...(contact?.extra || {}) };
  const phones = phonesOf(contact, company);
  const label = (key) => fieldLabel(ctx.meta.companyFields, key);
  const email = contact?.email || company.email;
  const website = company.website && safeUrl(company.website);
  const socials = [['LinkedIn', company.linkedin_url], ['Facebook', company.facebook_url], ['Instagram', company.instagram_url], ['Contact LinkedIn', contact?.linkedin_url]]
    .map(([name, value]) => [name, value && safeUrl(value)])
    .filter(([, url]) => url)
    .map(([name, url]) => h('a', { class: 'badge neutral link-chip', href: url.href, target: '_blank', rel: 'noopener noreferrer', title: url.href }, name));
  const sources = urlLinks([company.source_urls, contact?.source_urls].filter(Boolean).join('\n'));

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
      company.area && kv(label('area'), company.area),
      company.priority && kv(label('priority'), company.priority),
      company.opening_hours && kv(label('opening_hours'), company.opening_hours),
      website && kv(label('website'), h('a', { href: website.href, target: '_blank', rel: 'noopener noreferrer' }, website.host.replace(/^www\./, '')), { full: website.href }),
      email && !canEmail(ctx) && kv(contact?.email ? 'Email' : label('email'), emailLink(ctx, email), { full: email }),
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
      : h('p', { class: 'muted' }, 'No phone number on file.'),
      canEmail(ctx) && h('div', { class: 'phone-row' },
        h('span', { class: 'muted small' }, 'Email'),
        h('span', { class: `number${email ? '' : ' muted'}` }, email || 'Not on file'),
        emailButton(ctx, contact ? { contactId: contact.id } : { companyId: company.id }, { onSent: onEmailSent }))),
    company.key_people && block(label('key_people'), h('p', { class: 'text' }, company.key_people)),
    contact?.notes && block(fieldLabel(ctx.meta.contactFields, 'notes'), h('div', { class: 'note-box' }, contact.notes)),
    company.evidence_notes && block(label('evidence_notes'), h('p', { class: 'text' }, company.evidence_notes)),
    block('Script', h('div', { class: 'script' }, fillScript(ctx, contact, company))),
    consentLine(ctx, company),
    activity && openTasks.length > 0 && block('Open tasks', taskList(ctx, openTasks)),
    activity && calls.length > 0 && block('Recent calls', callTimeline(ctx, calls.slice(0, compact ? 3 : 6))),
    !compact && company.about && block(label('about'), h('p', { class: 'text' }, company.about)),
    (socials.length > 0 || sources.length > 0) && block('Links',
      socials.length > 0 && h('div', { class: 'row' }, socials),
      sources.length > 0 && h('div', { class: 'url-list' }, sources)),
    !compact && Object.keys(extra).length > 0 && h('details', { class: 'extra block' },
      h('summary', {}, `More from the spreadsheet (${Object.keys(extra).length})`),
      h('dl', {}, Object.entries(extra).map(([key, value]) => [h('dt', {}, key), h('dd', {}, value)]))));
}

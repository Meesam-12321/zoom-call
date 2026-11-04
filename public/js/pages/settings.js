// Settings: users and targets, call outcomes, script, calling rules, recording consent, presets, activity log, password.
import { api, fill, badge, busy, confirmDialog, field, fmt, h, icon, openModal, pageHead, select, tabs, toast } from '../ui.js';

const ADMIN_TABS = [
  ['users', 'Users'], ['outcomes', 'Call outcomes'], ['script', 'Script'], ['general', 'Calling rules'],
  ['recording', 'Recording consent'], ['presets', 'Import presets'], ['activity', 'Activity log'], ['account', 'My account'],
];
const ZONES = [
  ['America/New_York', 'US Eastern'], ['America/Chicago', 'US Central'], ['America/Denver', 'US Mountain'],
  ['America/Phoenix', 'Arizona'], ['America/Los_Angeles', 'US Pacific'], ['Asia/Karachi', 'Pakistan'], ['UTC', 'UTC'],
];
const panel = (title, ...content) => h('section', { class: 'card panel' }, h('div', { class: 'panel-head' }, h('h2', {}, title)), content);

export async function render(root, { id }, ctx, isCurrent) {
  const tab = ctx.isAdmin && ADMIN_TABS.some(([key]) => key === id) ? id : ctx.isAdmin ? 'users' : 'account';
  const content = await (TABS[tab] || TABS.account)(ctx, () => ctx.rerender());
  if (!isCurrent()) return;
  fill(root, 
    pageHead('Settings', ctx.isAdmin ? 'Only admins see these settings.' : null),
    ctx.isAdmin && tabs(ADMIN_TABS, tab, (key) => ctx.navigate(`#/settings/${key}`)),
    content,
  );
}

async function saveSettings(ctx, body) {
  await api('/settings', { method: 'PATCH', body });
  await ctx.refreshMeta();
  toast('Settings saved.', { kind: 'ok' });
}

const TABS = {
  async users(ctx, reload) {
    const { users } = await api('/users');
    return panel('Users',
      h('p', { class: 'muted' }, 'Admins manage users, scripts, outcomes and imports and see every lead. Callers see and edit only the leads assigned to them.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'), h('th', {}, 'Daily targets (calls / conversations / meetings)'), h('th', {}, 'Status'), h('th', {}))),
        h('tbody', {}, users.map((u) => h('tr', {},
          h('td', {}, u.name), h('td', {}, u.email), h('td', {}, u.role === 'admin' ? 'Admin' : 'Caller'),
          h('td', {}, `${u.target_calls} / ${u.target_conversations} / ${u.target_meetings}`),
          h('td', {}, u.active ? badge('Active', 'ok') : badge('Switched off', 'neutral')),
          h('td', { class: 'actions' }, h('button', { class: 'btn small secondary', type: 'button', onclick: () => userDialog(ctx, u, reload) }, 'Edit'))))))),
      h('div', { class: 'row end section-gap' }, h('button', { class: 'btn', type: 'button', onclick: () => userDialog(ctx, null, reload) }, icon('plus'), 'Add user')));
  },

  async outcomes(ctx) {
    const rows = ctx.meta.dispositions.map((d) => ({ ...d }));
    const body = h('tbody', {});
    const draw = () => body.replaceChildren(...rows.map((d, i) => {
      const daysInput = h('input', { type: 'number', min: 0, max: 365, value: d.retry_days ?? '', disabled: !['retry', 'nurture'].includes(d.action), oninput: (e) => { d.retry_days = e.target.value; } });
      return h('tr', {},
        h('td', {}, h('input', { type: 'text', value: d.label, 'aria-label': 'Outcome name', oninput: (e) => { d.label = e.target.value; } })),
        h('td', {}, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(d.connected), onchange: (e) => { d.connected = e.target.checked; } }), 'Connected')),
        h('td', {}, select(ctx.meta.dispositionActions, d.action, { 'aria-label': 'What happens', onchange: (e) => { d.action = e.target.value; draw(); } })),
        h('td', {}, daysInput),
        h('td', {}, h('input', { type: 'text', value: d.task_title ?? '', placeholder: 'Follow-up task name', disabled: ['lost', 'invalid_number', 'dnc'].includes(d.action), oninput: (e) => { d.task_title = e.target.value; } })),
        h('td', {}, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.active !== 0 && d.active !== false, onchange: (e) => { d.active = e.target.checked; } }), 'On')),
        h('td', { class: 'actions' }, h('div', { class: 'row end nowrap' },
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); } }, '↑'),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move down', disabled: i === rows.length - 1, onclick: () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; draw(); } }, '↓'))));
    }));
    draw();
    const save = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => busy(save, async () => {
        await api('/dispositions', { method: 'PUT', body: { dispositions: rows } });
        await ctx.refreshMeta();
        toast('Call outcomes saved.', { kind: 'ok' });
      }),
    }, 'Save outcomes');
    return panel('Call outcomes',
      h('p', { class: 'muted' }, 'Every call must end with one of these. "Connected" outcomes count as calls picked up by a person. Outcomes used on past calls can be switched off but not deleted.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Outcome'), h('th', {}, 'Counts as'), h('th', {}, 'What happens next'), h('th', {}, 'Days'), h('th', {}, 'Task name'), h('th', {}, 'Active'), h('th', {}))),
        body)),
      h('div', { class: 'row end section-gap' },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => { rows.push({ label: 'New outcome', connected: 1, action: 'retry', retry_days: 1, task_title: 'Retry call', active: 1 }); draw(); } }, icon('plus'), 'Add outcome'),
        save));
  },

  async script(ctx) {
    const text = h('textarea', { rows: 16, value: ctx.meta.settings.script });
    const save = h('button', { class: 'btn', type: 'button', onclick: () => busy(save, () => saveSettings(ctx, { script: text.value })) }, 'Save script');
    return panel('Call script',
      h('p', { class: 'muted' }, 'Shown beside every call. Placeholders: {first_name}, {last_name}, {company}, {city}, {caller}. "Store Team" style contacts are greeted as "there".'),
      text,
      h('div', { class: 'row end section-gap' }, save));
  },

  async general(ctx) {
    const s = ctx.meta.settings;
    const maxAttempts = h('input', { type: 'number', min: 1, max: 100, value: s.max_attempts });
    const conversation = h('input', { type: 'number', min: 0, max: 3600, value: s.conversation_seconds });
    const zone = select(ZONES.some(([key]) => key === s.business_tz) ? ZONES : [...ZONES, [s.business_tz, s.business_tz]], s.business_tz);
    const scheme = select([['zoomphonecall', 'Zoom app (zoomphonecall: link)'], ['tel', 'Default phone app (tel: link)'], ['callto', 'callto: link']], s.dial_scheme);
    const save = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => busy(save, () => saveSettings(ctx, {
        max_attempts: Number(maxAttempts.value),
        conversation_seconds: Number(conversation.value),
        business_tz: zone.value,
        dial_scheme: scheme.value,
      })),
    }, 'Save');
    return panel('Calling rules',
      h('div', { class: 'form-grid' },
        field('Maximum attempts per lead', maxAttempts, 'Callers are warned before calling a lead this many times.'),
        field('Conversation length (seconds)', conversation, 'Connected calls longer than this count as conversations.'),
        field('Business time zone', zone, '"Today", task times and reports use this zone.'),
        field('How the Call button dials', scheme, 'Use "Default phone app" if the Zoom link does not open Zoom on your computer.')),
      h('div', { class: 'row end section-gap' }, save));
  },

  async recording(ctx) {
    const consent = { ...ctx.meta.settings.recording_consent };
    const states = Object.entries(ctx.meta.states);
    const save = h('button', { class: 'btn', type: 'button', onclick: () => busy(save, () => saveSettings(ctx, { recording_consent: consent })) }, 'Save');
    return panel('Recording consent by state',
      h('p', { class: 'muted' }, 'Florida and some other states require every party to agree before a call is recorded. Choose per state; the call screen reminds the caller. Zoom\'s own recording settings must match, and these rules should be confirmed with a legal advisor.'),
      h('div', { class: 'form-grid' }, states.map(([code, name]) => field(name, select([['off', 'Recording off'], ['notice', 'Recording on, with a "may be recorded" notice']], consent[code] || 'off', {
        onchange: (event) => {
          consent[code] = event.target.value;
        },
      })))),
      h('div', { class: 'row end section-gap' }, save));
  },

  async presets(ctx, reload) {
    const { presets } = await api('/import/presets');
    return panel('Import presets',
      h('p', { class: 'muted' }, 'Saved column mappings. A file whose sheet names match a preset uses it automatically.'),
      h('ul', { class: 'timeline' }, presets.map((p) => h('li', {}, h('div', { class: 'row' },
        h('span', {}, p.name),
        p.id !== 'hv' && h('button', {
          class: 'btn small ghost',
          type: 'button',
          onclick: async (event) => {
            const button = event.currentTarget;
            if (!(await confirmDialog({ title: `Delete the "${p.name}" preset?`, message: 'Imports will fall back to automatic matching.', confirm: 'Delete', danger: true }))) return;
            await busy(button, async () => {
              await api(`/import/presets/${p.id}`, { method: 'DELETE' });
              reload();
            });
          },
        }, icon('trash', 14), 'Delete'))))));
  },

  async activity(ctx) {
    const list = h('ul', { class: 'timeline' });
    const more = h('button', { class: 'btn secondary', type: 'button' }, 'Load more');
    let before = '';
    const load = async () => {
      const { activity } = await api(`/activity${before ? `?before=${before}` : ''}`);
      list.append(...activity.map((a) => h('li', {},
        h('div', { class: 'meta' }, h('span', {}, fmt.dateTime(a.created_at)), h('span', {}, a.user_name || 'System'), badge(`${a.entity}${a.entity_id ? ` #${a.entity_id}` : ''}`, 'neutral')),
        h('p', {}, `${a.action.replace(/_/g, ' ')}${a.details ? ` · ${summarize(a.details)}` : ''}`))));
      before = activity.at(-1)?.id || before;
      more.hidden = activity.length < 100;
    };
    more.addEventListener('click', () => busy(more, load));
    await load();
    return panel('Activity log', h('p', { class: 'muted' }, 'Every change, who made it and when.'), list, h('div', { class: 'row end section-gap' }, more));
  },

  async account(ctx) {
    const current = h('input', { type: 'password', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
    const save = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => busy(save, async () => {
        await api('/auth/password', { method: 'POST', body: { current: current.value, password: next.value } });
        current.value = '';
        next.value = '';
        toast('Password changed. Other devices were signed out.', { kind: 'ok' });
      }),
    }, 'Change password');
    return panel(`My account · ${ctx.user.name}`,
      h('p', { class: 'muted' }, `${ctx.user.email} · ${ctx.isAdmin ? 'Admin' : 'Caller'}`),
      h('div', { class: 'form-grid' }, field('Current password', current), field('New password', next, 'At least 8 characters.')),
      h('div', { class: 'row end section-gap' }, save));
  },
};

function summarize(details) {
  return Object.entries(details).map(([key, value]) => {
    if (Array.isArray(value)) return `${key.replace(/_/g, ' ')}: ${value[0] ?? '—'} → ${value[1] ?? '—'}`;
    if (value && typeof value === 'object') return `${key}: ${Object.entries(value).map(([k, v]) => `${k} ${v}`).join(', ')}`;
    return `${key.replace(/_/g, ' ')}: ${value}`;
  }).join('; ');
}

function userDialog(ctx, user, reload) {
  const inputs = {
    name: h('input', { type: 'text', value: user?.name ?? '' }),
    email: h('input', { type: 'email', value: user?.email ?? '' }),
    role: select([['caller', 'Caller'], ['admin', 'Admin']], user?.role ?? 'caller'),
    target_calls: h('input', { type: 'number', min: 0, value: user?.target_calls ?? 0 }),
    target_conversations: h('input', { type: 'number', min: 0, value: user?.target_conversations ?? 0 }),
    target_meetings: h('input', { type: 'number', min: 0, value: user?.target_meetings ?? 0 }),
    password: h('input', { type: 'password', autocomplete: 'new-password', placeholder: user ? 'Leave empty to keep it' : 'At least 8 characters' }),
  };
  const active = h('input', { type: 'checkbox', checked: user ? Boolean(user.active) : true });
  // A new caller can take every lead nobody owns yet (callers only see leads assigned to them).
  const unassigned = user ? 0 : ctx.meta.unassignedLeads;
  const takeLeads = h('input', { type: 'checkbox', checked: true });
  const takeLeadsRow = unassigned > 0 && h('label', { class: 'check wide' }, takeLeads, `Give this caller the ${fmt.num(unassigned)} lead${unassigned === 1 ? '' : 's'} nobody owns yet`);
  const toggleTake = () => {
    if (takeLeadsRow) takeLeadsRow.hidden = inputs.role.value !== 'caller';
  };
  inputs.role.addEventListener('change', toggleTake);
  toggleTake();
  const save = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => busy(save, async () => {
      const body = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
      if (user && !body.password) delete body.password;
      let assigned = 0;
      if (user) {
        body.active = active.checked;
        await api(`/users/${user.id}`, { method: 'PATCH', body });
      } else {
        body.assign_unassigned = Boolean(takeLeadsRow) && body.role === 'caller' && takeLeads.checked;
        ({ assigned } = await api('/users', { method: 'POST', body }));
      }
      await ctx.refreshMeta();
      modal.close();
      const leads = assigned ? ` with ${fmt.num(assigned)} lead${assigned === 1 ? '' : 's'}` : '';
      toast(user ? 'User updated.' : `User added${leads}. Give them their email and password to sign in.`, { kind: 'ok' });
      reload();
    }),
  }, user ? 'Save' : 'Add user');
  const modal = openModal({
    title: user ? `Edit ${user.name}` : 'Add a user',
    body: h('div', { class: 'form-grid' },
      field('Name', inputs.name), field('Email (used to sign in)', inputs.email),
      field('Role', inputs.role), field(user ? 'New password' : 'Password', inputs.password),
      field('Calls per day', inputs.target_calls), field('Conversations per day', inputs.target_conversations),
      field('Meetings per day', inputs.target_meetings),
      user && h('label', { class: 'check' }, active, 'Active (can sign in)'),
      takeLeadsRow),
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save],
  });
}

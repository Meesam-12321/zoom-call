// Sign-in, and first-run setup of the admin account.
import { api, field, h, logo, themeButton } from '../ui.js';

export function renderAuth(state) {
  const error = h('div', { class: 'alert', role: 'alert', hidden: true });
  const setup = state.needsSetup;
  const inputs = {
    name: h('input', { type: 'text', autocomplete: 'name', required: true }),
    email: h('input', { type: 'email', autocomplete: 'username', required: true }),
    password: h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 8 : null }),
  };
  const submit = h('button', { class: 'btn', type: 'submit' }, setup ? 'Create admin account' : 'Sign in');

  const form = h('form', {
    class: 'card auth-card',
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      try {
        if (setup) {
          await api('/auth/setup', { method: 'POST', body: { name: inputs.name.value, email: inputs.email.value, password: inputs.password.value } });
        } else {
          await api('/auth/login', { method: 'POST', body: { email: inputs.email.value, password: inputs.password.value } });
        }
        location.reload();
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
        submit.disabled = false;
      }
    },
  },
  h('div', {},
    h('h2', {}, setup ? 'Create the admin account' : 'Sign in'),
    h('p', { class: 'muted' }, setup ? 'You can add your callers in Settings afterwards.' : 'Welcome back.')),
  error,
  setup && field('Your name', inputs.name),
  field('Email', inputs.email),
  field('Password', inputs.password, setup ? 'At least 8 characters.' : null),
  submit);

  document.getElementById('app').replaceChildren(h('div', { class: 'auth-wrap' },
    themeButton('auth-theme'),
    h('div', { class: 'auth-hero' },
      h('span', { class: 'brand' }, logo()),
      h('h1', { class: 'hero-title' }, 'Every call. ', h('em', {}, 'Every lead.')),
      h('p', { class: 'hero-sub' }, 'Your cold-calling CRM, from first dial to booked meeting.')),
    form));
  (setup ? inputs.name : inputs.email).focus();
}

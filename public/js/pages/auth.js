// Sign-in, and first-run setup of the admin account.
import { api, field, h } from '../ui.js';

export function renderAuth(state) {
  const error = h('div', { class: 'alert', role: 'alert', hidden: true });
  const setup = state.needsSetup;
  const inputs = {
    name: h('input', { type: 'text', autocomplete: 'name', required: true }),
    email: h('input', { type: 'email', autocomplete: 'username', required: true }),
    password: h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 8 : null }),
    setupCode: h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code' }),
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
          await api('/auth/setup', { method: 'POST', body: { name: inputs.name.value, email: inputs.email.value, password: inputs.password.value, setupCode: inputs.setupCode.value } });
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
    h('h1', {}, setup ? 'Set up the CRM' : 'Sign in'),
    h('p', { class: 'muted' }, setup ? 'Create the admin account. You can add your callers in Settings afterwards.' : 'Cold-Calling CRM')),
  error,
  setup && field('Your name', inputs.name),
  field('Email', inputs.email),
  field('Password', inputs.password, setup ? 'At least 8 characters.' : null),
  setup && state.setupCodeRequired && field('Setup code', inputs.setupCode, 'Shown in the terminal where the CRM server is running.'),
  submit);

  document.getElementById('app').replaceChildren(h('div', { class: 'auth-wrap' }, form));
  (setup ? inputs.name : inputs.email).focus();
}

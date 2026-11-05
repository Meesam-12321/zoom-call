// Fixing a lead's details in place: its name and email while on a call (when the person who picks up says who they are), and
// its usual details from the rows of a call list.
import { api, busy, field, fill, fmt, h, icon, openModal, toast } from './ui.js';

/**
 * A contact's first name, last name and email; a lead that is only a company has its name and email instead.
 * It saves only what changed, through the same endpoints as the record pages, so the change shows in History and in every
 * call log (a log shows the lead's current name). `onSaved` redraws whatever shows the lead; `onCancel` closes the form.
 */
function nameEmailForm({ contact, company }, { onSaved, onCancel }) {
  const record = contact || company;
  const endpoint = contact ? `/contacts/${contact.id}` : `/companies/${company.id}`;
  const fields = contact
    ? [['first_name', 'First name'], ['last_name', 'Last name'], ['email', 'Email']]
    : [['name', 'Company name'], ['email', 'Email']];
  const inputs = Object.fromEntries(fields.map(([key]) => [key, h('input', {
    type: key === 'email' ? 'email' : 'text',
    value: record[key] ?? '',
    autocomplete: 'off',
  })]));

  const save = h('button', { class: 'btn', type: 'submit' }, icon('check'), 'Save');
  return h('form', {
    onsubmit: (event) => {
      event.preventDefault();
      busy(save, async () => {
        const changes = Object.fromEntries(fields
          .filter(([key]) => inputs[key].value.trim() !== (record[key] ?? ''))
          .map(([key]) => [key, inputs[key].value]));
        if (!Object.keys(changes).length) {
          toast('Nothing changed.');
          return onCancel();
        }
        await api(endpoint, { method: 'PATCH', body: changes });
        toast('Saved.', { kind: 'ok' });
        return onSaved();
      });
    },
  },
  h('div', { class: 'form-grid' },
    fields.map(([key, label]) => h('div', { class: key === 'email' || !contact ? 'wide' : null }, field(label, inputs[key])))),
  h('div', { class: 'row end section-gap' }, h('button', { class: 'btn secondary', type: 'button', onclick: onCancel }, 'Cancel'), save));
}

/**
 * The "Edit name and email" button and the place its form opens, as two elements so a page can put them apart.
 * `detail` is the lead as the API returned it; after a save `onSaved` should fetch it again and draw both anew.
 */
export function nameEmailEdit(detail, onSaved) {
  const editor = h('div', {});
  const close = () => {
    fill(editor);
    button.hidden = false;
  };
  const button = h('button', {
    class: 'link-btn',
    type: 'button',
    onclick: () => {
      button.hidden = true;
      fill(editor, h('div', { class: 'block' }, h('h3', {}, 'Edit name and email'), nameEmailForm(detail, { onSaved, onCancel: close })));
      editor.querySelector('input')?.focus();
    },
  }, icon('note', 12), 'Edit name and email');
  return { button, editor };
}

// Who each field belongs to, its key, label and kind. The store's name and phone belong to the company, so they change for
// everyone who works there. (Phones are plain text boxes like everywhere else in the app, with the phone keypad on a phone.)
const LEAD_FIELDS = [
  ['contact', 'first_name', 'First name', 'text'],
  ['contact', 'last_name', 'Last name', 'text'],
  ['contact', 'job_title', 'Job title', 'text'],
  ['contact', 'email', 'Email', 'email'],
  ['contact', 'mobile', 'Mobile', 'tel'],
  ['contact', 'direct_line', 'Direct line', 'tel'],
  ['company', 'name', 'Company', 'text'],
  ['company', 'hq_phone', 'Store phone', 'tel'],
];
// The dialable form of each phone field. The server keeps what was typed even when it is not a number it can dial.
const DIALABLE = { mobile: 'mobile_e164', direct_line: 'direct_e164', hq_phone: 'hq_phone_e164' };

/**
 * A lead's usual details in one dialog, for the rows of a call list. Saves only what changed; `onSaved` redraws the list, also when
 * only part could be saved (the dialog then stays open for the rest).
 */
export async function editLeadDialog({ contactId, onSaved }) {
  let detail;
  try {
    detail = await api(`/contacts/${contactId}`);
  } catch (error) {
    toast(error.message, { kind: 'error' });
    return;
  }
  const records = { contact: detail.contact, company: detail.company };
  const controls = LEAD_FIELDS.map(([who, key, label, kind]) => ({
    who,
    key,
    label,
    input: h('input', { type: kind === 'email' ? 'email' : 'text', inputmode: kind === 'tel' ? 'tel' : null, value: records[who][key] ?? '', autocomplete: 'off' }),
  }));

  async function submit() {
    let saved = false;
    try {
      const phones = [];
      for (const who of ['contact', 'company']) {
        const changes = Object.fromEntries(controls
          .filter((c) => c.who === who && c.input.value.trim() !== (records[who][c.key] ?? ''))
          .map((c) => [c.key, c.input.value.trim()]));
        if (!Object.keys(changes).length) continue;
        await api(`/${who === 'contact' ? 'contacts' : 'companies'}/${records[who].id}`, { method: 'PATCH', body: changes });
        Object.assign(records[who], changes); // so a second try does not send these again
        saved = true;
        phones.push(...Object.entries(changes).filter(([key, value]) => DIALABLE[key] && value).map(([key, value]) => [who, key, value]));
      }
      if (!saved) {
        toast('Nothing changed.');
        modal.close();
        return;
      }
      // A number the server could not read is kept as typed, but the lead could not be called on it.
      if (phones.length) {
        const fresh = await api(`/contacts/${contactId}`);
        const unreadable = phones.filter(([who, key]) => !fresh[who][DIALABLE[key]]).map(([, , value]) => `"${value}"`);
        if (unreadable.length) toast(`${unreadable.join(' and ')} can't be dialed. Check the number and include the area code.`, { kind: 'warn', timeout: 10000 });
      }
      modal.close();
      toast('Saved.', { kind: 'ok' });
    } finally {
      if (saved) await onSaved?.();
    }
  }

  const formId = `edit-lead-${contactId}`;
  const save = h('button', { class: 'btn', type: 'submit', form: formId }, icon('check'), 'Save');
  const modal = openModal({
    title: `Edit lead · ${fmt.name(detail.contact)}`,
    body: h('form', {
      id: formId,
      class: 'form-grid',
      onsubmit: (event) => {
        event.preventDefault();
        busy(save, submit);
      },
    }, controls.map((c) => h('div', {}, field(c.label, c.input)))),
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), save],
  });
}

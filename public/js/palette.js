// Search everything (Ctrl+K or /): jump to a page, run an action, or find a lead by company, person, city, phone or email.
import { api, debounce, fmt, h, icon } from './ui.js';

const SEARCH_LIMIT = 6;

/** `items` is [{ label, hint, icon, run }]. Opening it again while open does nothing. */
export function openPalette(items) {
  if (document.querySelector('.palette-overlay')) return;
  let results = [];
  let visible = [];
  let selected = 0;
  let seq = 0;

  const list = h('div', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
  const input = h('input', {
    type: 'text',
    placeholder: 'Search leads, or type a page or action…',
    'aria-label': 'Search',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'palette-list',
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: () => {
      selected = 0;
      draw();
      search();
    },
    onkeydown: (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (visible.length) selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
        draw();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        choose(visible[selected]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    },
  });
  const overlay = h('div', { class: 'palette-overlay', onmousedown: (event) => event.target === overlay && close() },
    h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' },
      h('div', { class: 'palette-search' }, icon('search', 18), input, h('kbd', {}, 'Esc')),
      list));

  function close() {
    seq++;
    overlay.remove();
  }

  function choose(item) {
    if (!item) return;
    close();
    item.run();
  }

  const search = debounce(async () => {
    const q = input.value.trim();
    const mine = ++seq;
    results = [];
    if (q.length < 2) return draw();
    const params = `q=${encodeURIComponent(q)}`;
    const [companies, contacts] = await Promise.all([api(`/companies?${params}`), api(`/contacts?${params}`)]).catch(() => [{ rows: [] }, { rows: [] }]);
    if (mine !== seq) return;
    results = [
      ...companies.rows.slice(0, SEARCH_LIMIT).map((c) => ({
        label: c.name,
        hint: [[c.city, c.state].filter(Boolean).join(', '), fmt.phone(c.hq_phone_e164)].filter(Boolean).join(' · '),
        icon: 'leads',
        group: 'Companies',
        run: () => { location.hash = `#/company/${c.id}`; },
      })),
      ...contacts.rows.slice(0, SEARCH_LIMIT).map((c) => ({
        label: fmt.name(c),
        hint: c.company_name,
        icon: 'phone',
        group: 'Contacts',
        run: () => { location.hash = `#/contact/${c.id}`; },
      })),
    ];
    draw();
  }, 180);

  function draw() {
    const q = input.value.trim().toLowerCase();
    visible = [...items.filter((item) => item.label.toLowerCase().includes(q)), ...results];
    if (selected >= visible.length) selected = 0;
    let group = null;
    const rows = [];
    visible.forEach((item, i) => {
      const name = item.group || 'Go to';
      if (name !== group) rows.push(h('div', { class: 'palette-group eyebrow' }, name));
      group = name;
      rows.push(h('button', {
        class: `palette-item${i === selected ? ' on' : ''}`,
        type: 'button',
        role: 'option',
        'aria-selected': String(i === selected),
        onmousemove: () => {
          if (selected !== i) {
            selected = i;
            draw();
          }
        },
        onclick: () => choose(item),
      }, icon(item.icon, 16), h('span', {}, item.label), item.hint && h('small', {}, item.hint)));
    });
    list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'palette-empty' }, q.length < 2 ? 'Keep typing…' : 'Nothing found.')]));
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  draw();
  document.body.append(overlay);
  input.focus();
}

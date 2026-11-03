// Import wizard: upload → map columns (HV template / presets / automatic) → validation and duplicates → import.
import { api, fill, badge, busy, field, fmt, h, icon, pageHead, select, toast } from '../ui.js';

const STEPS = ['Upload', 'Map columns', 'Check', 'Done'];
const ISSUE_LABELS = {
  missing_phone: 'Missing phone number',
  invalid_email: 'Invalid email',
  unmatched_company: 'Company not found',
  missing_name: 'Missing name',
};

export async function render(root, params, ctx) {
  if (!ctx.isAdmin) {
    root.replaceChildren(h('div', { class: 'alert' }, 'Only admins can import leads.'));
    return;
  }
  let upload = null;
  let config = null;
  let report = null;
  const steps = h('div', { class: 'steps' });
  const body = h('div', { class: 'stack' });
  const setStep = (n) => steps.replaceChildren(...STEPS.map((label, i) =>
    h('span', { class: `step${i === n ? ' active' : i < n ? ' done' : ''}` }, i < n ? icon('check', 12) : null, `${i + 1}. ${label}`)));

  root.replaceChildren(pageHead('Import leads', 'Excel (.xlsx) or CSV. The HV template (Company Information + Contact Information sheets) maps itself.'), steps, body);
  showUpload();

  function showUpload() {
    setStep(0);
    const input = h('input', { type: 'file', accept: '.xlsx,.csv', hidden: true, onchange: () => input.files[0] && parse(input.files[0]) });
    const zone = h('div', {
      class: 'card dropzone',
      ondragover: (event) => {
        event.preventDefault();
        zone.classList.add('over');
      },
      ondragleave: () => zone.classList.remove('over'),
      ondrop: (event) => {
        event.preventDefault();
        zone.classList.remove('over');
        const file = event.dataTransfer.files[0];
        if (file) parse(file);
      },
    },
    icon('import', 32),
    h('h2', {}, 'Drop a spreadsheet here'),
    h('label', { class: 'btn' }, 'Choose a file', input),
    h('p', { class: 'muted small' }, '.xlsx or .csv, up to 25 MB. Nothing is saved until the last step.'));
    fill(body, zone);
  }

  async function parse(file) {
    fill(body, h('div', { class: 'loading-state' }, `Reading ${file.name}…`));
    try {
      upload = await api('/import/parse', {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      });
      config = upload.config;
      showMapping();
    } catch (error) {
      toast(error.message, { kind: 'error' });
      showUpload();
    }
  }

  const targetOptions = (type) => [
    ['extra', 'Keep as extra info'],
    ['', "Don't import"],
    ...(type === 'contacts' ? ctx.meta.contactFields.map(([key, label]) => [`contact.${key}`, `Contact · ${label}`]) : []),
    ...ctx.meta.companyFields.map(([key, label]) => [`company.${key}`, key === 'name' && type === 'contacts' ? 'Company · Company name (links the contact)' : `Company · ${label}`]),
  ];

  function sheetCard(sheet) {
    const sc = config.sheets[sheet.name];
    const type = select([['companies', 'Companies'], ['contacts', 'Contacts (with their company)'], ['skip', "Don't import"]], sc.type, {
      onchange: (event) => {
        sc.type = event.target.value;
        showMapping();
      },
    });
    const head = h('div', { class: 'panel-head' },
      h('div', {}, h('h2', {}, sheet.name), h('p', { class: 'muted small' }, `${fmt.num(sheet.rowCount)} rows · headers on row ${sheet.headerRow}`)),
      field('Import this sheet as', type));
    if (sc.type === 'skip') return h('section', { class: 'card panel' }, head);
    return h('section', { class: 'card panel' }, head, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Spreadsheet column'), h('th', {}, 'Example values'), h('th', {}, 'Import as'))),
      h('tbody', {}, sheet.headers.map((header) => h('tr', {},
        h('td', {}, header),
        h('td', { class: 'sample' }, sheet.samples.map((row) => row[header]).filter((v) => v && !/^n\/?a$/i.test(v)).slice(0, 2).join(' · ') || '—'),
        h('td', {}, select(targetOptions(sc.type), sc.columns[header] ?? 'extra', {
          'aria-label': `Import ${header} as`,
          onchange: (event) => {
            sc.columns[header] = event.target.value;
          },
        }))))))));
  }

  function showMapping() {
    setStep(1);
    const sheets = upload.sheets;
    const used = sheets.filter((s) => config.sheets[s.name].type !== 'skip');
    const skipped = sheets.filter((s) => config.sheets[s.name].type === 'skip');
    const preset = select([['auto', 'Automatic matching'], ...upload.presets.map((p) => [String(p.id), p.name])], upload.preset ? String(upload.preset.id) : 'auto', {
      onchange: (event) => busy(event.target, async () => {
        ({ config } = await api('/import/apply-preset', { method: 'POST', body: { token: upload.token, presetId: event.target.value } }));
        upload.preset = upload.presets.find((p) => String(p.id) === event.target.value) || null;
        showMapping();
      }),
    });
    const presetName = h('input', { type: 'text', placeholder: 'Preset name, e.g. HV template v2' });
    const savePreset = h('button', {
      class: 'btn small secondary',
      type: 'button',
      onclick: () => busy(savePreset, async () => {
        ({ presets: upload.presets } = await api('/import/presets', { method: 'POST', body: { token: upload.token, name: presetName.value, config } }));
        toast('Mapping saved. Files with the same sheet names will use it automatically.', { kind: 'ok' });
      }),
    }, 'Save mapping as a preset');
    const check = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => busy(check, async () => {
        report = await api('/import/check', { method: 'POST', body: { token: upload.token, config } });
        showCheck();
      }),
    }, 'Check the data', icon('next'));

    fill(body, 
      h('section', { class: 'card panel' },
        h('div', { class: 'panel-head' },
          h('div', {}, h('h2', {}, upload.filename), h('p', { class: 'muted small' }, upload.preset ? `Using the "${upload.preset.name}" preset.` : 'Columns were matched by their names. Check them below.')),
          h('div', { class: 'row' }, field('Preset', preset))),
        h('div', { class: 'row' }, presetName, savePreset)),
      used.map(sheetCard),
      skipped.length > 0 && h('details', { class: 'card panel extra' },
        h('summary', {}, `${skipped.length} other sheet${skipped.length === 1 ? '' : 's'} will not be imported`),
        h('div', { class: 'stack section-gap' }, skipped.map(sheetCard))),
      h('div', { class: 'row end' }, h('button', { class: 'btn secondary', type: 'button', onclick: showUpload }, 'Choose another file'), check),
    );
  }

  function showCheck() {
    setStep(2);
    const decisions = Object.fromEntries(report.duplicates.map((d) => [d.ref, d.suggested]));
    const actionSelect = (d) => select([['merge', 'Merge (fill empty fields)'], ['skip', 'Skip'], ['create', 'Create new']], decisions[d.ref], {
      'aria-label': `What to do with ${d.label}`,
      onchange: (event) => {
        decisions[d.ref] = event.target.value;
      },
    });
    const selects = report.duplicates.map((d) => [d, actionSelect(d)]);
    const setAll = select([['', 'Set all to…'], ['merge', 'Merge'], ['skip', 'Skip'], ['create', 'Create new']], '', {
      onchange: (event) => {
        if (!event.target.value) return;
        for (const [d, el] of selects) {
          el.value = event.target.value;
          decisions[d.ref] = event.target.value;
        }
      },
    });
    const callers = ctx.meta.users.filter((u) => u.active);
    const owner = select([['', 'Nobody yet'], ...callers.map((u) => [String(u.id), `${u.name}${u.role === 'caller' ? ' (caller)' : ''}`])], String(callers.find((u) => u.role === 'caller')?.id ?? ''));
    const listName = h('input', { type: 'text', value: `${upload.filename.replace(/\.[^.]+$/, '')} – ${new Date().toISOString().slice(0, 10)}` });
    // A file with only contact rows has no company sheet, so its companies have to come from those rows.
    const createMissing = h('input', { type: 'checkbox', checked: !Object.values(config.sheets).some((s) => s.type === 'companies') });
    const c = report.companies;
    const p = report.contacts;
    const go = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => busy(go, async () => {
        const result = await api('/import/commit', {
          method: 'POST',
          body: { token: upload.token, config, decisions, ownerId: owner.value, listName: listName.value, createMissingCompanies: createMissing.checked },
        });
        showDone(result);
      }),
    }, icon('check'), `Import ${fmt.num(c.total)} companies and ${fmt.num(p.total)} contacts`);

    const issueKinds = Object.entries(report.issueCounts).filter(([, n]) => n);
    fill(body, 
      h('section', { class: 'stats' },
        h('div', { class: 'card stat' }, h('div', { class: 'stat-label' }, 'Companies'), h('div', { class: 'stat-value' }, fmt.num(c.total)), h('div', { class: 'stat-sub' }, `${fmt.num(c.new)} new · ${fmt.num(c.duplicates)} already in the CRM`)),
        h('div', { class: 'card stat' }, h('div', { class: 'stat-label' }, 'Contacts'), h('div', { class: 'stat-value' }, fmt.num(p.total)), h('div', { class: 'stat-sub' }, `${fmt.num(p.new)} new · ${fmt.num(p.duplicates)} already in the CRM`)),
        h('div', { class: 'card stat' }, h('div', { class: 'stat-label' }, 'Problems found'), h('div', { class: 'stat-value' }, fmt.num(report.issues.length)), h('div', { class: 'stat-sub' }, issueKinds.length ? issueKinds.map(([k, n]) => `${n} ${ISSUE_LABELS[k].toLowerCase()}`).join(' · ') : 'None')),
        h('div', { class: 'card stat' }, h('div', { class: 'stat-label' }, 'Contacts without a company'), h('div', { class: 'stat-value' }, fmt.num(p.unmatched)), h('div', { class: 'stat-sub' }, p.unmatched ? 'Skipped unless you create the companies' : 'Every contact matched a company'))),
      report.mergedRows > 0 && h('div', { class: 'note' }, `${report.mergedRows} rows repeated a company or contact within the file and were combined.`),
      report.issues.length > 0 && h('section', { class: 'card panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Problems'), h('span', { class: 'muted' }, '"NA" and "Not Found" count as empty')),
        h('div', { class: 'table-wrap scroll' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Sheet'), h('th', { class: 'num' }, 'Row'), h('th', {}, 'Problem'), h('th', {}, 'Details'))),
          h('tbody', {}, report.issues.map((i) => h('tr', {},
            h('td', {}, i.sheet), h('td', { class: 'num' }, i.row), h('td', {}, badge(ISSUE_LABELS[i.kind] || i.kind, i.kind === 'unmatched_company' ? 'missed' : 'warn')), h('td', { class: 'wrap' }, i.text))))))),
      report.duplicates.length > 0 && h('section', { class: 'card panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, `Already in the CRM (${report.duplicates.length})`), setAll),
        h('p', { class: 'muted small' }, 'Merge only fills fields that are empty in the CRM; it never overwrites what callers entered.'),
        h('div', { class: 'table-wrap scroll' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'In the file'), h('th', {}, 'Matches'), h('th', {}, 'Matched by'), h('th', {}, 'What to do'))),
          h('tbody', {}, selects.map(([d, el]) => h('tr', {},
            h('td', {}, badge(d.kind === 'company' ? 'Company' : 'Contact', 'neutral'), ' ', d.label),
            h('td', {}, h('a', { href: d.kind === 'company' ? `#/company/${d.existing.id}` : `#/contact/${d.existing.id}`, target: '_blank' }, d.existing.label)),
            h('td', {}, d.existing.by),
            h('td', {}, el))))))),
      h('section', { class: 'card panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Import options')),
        h('div', { class: 'form-grid' },
          field('Assign new leads to', owner, 'Callers only see leads assigned to them.'),
          field('Add the contacts to a call list', listName, 'Leave empty to skip.'),
          p.unmatched > 0 && h('label', { class: 'check wide' }, createMissing, `Create the ${p.unmatched} missing compan${p.unmatched === 1 ? 'y' : 'ies'} instead of skipping those contacts`))),
      h('div', { class: 'row end' }, h('button', { class: 'btn secondary', type: 'button', onclick: showMapping }, icon('back'), 'Back to mapping'), go),
    );
  }

  function showDone(result) {
    setStep(3);
    const { companies, contacts, list } = result;
    fill(body, h('section', { class: 'card panel' },
      h('h2', {}, 'Import finished'),
      h('ul', {},
        h('li', {}, `Companies: ${companies.created} created, ${companies.merged} merged, ${companies.skipped} skipped.`),
        h('li', {}, `Contacts: ${contacts.created} created, ${contacts.merged} merged, ${contacts.skipped} skipped${contacts.unmatched ? `, ${contacts.unmatched} skipped because their company was not found` : ''}.`),
        list && h('li', {}, `Call list "${list.name}" is ready.`)),
      h('div', { class: 'row section-gap' },
        list && h('a', { class: 'btn call', href: `#/dial/${list.id}` }, icon('play'), 'Start dialing the list'),
        h('a', { class: 'btn secondary', href: '#/leads' }, 'Go to leads'),
        h('button', { class: 'btn ghost', type: 'button', onclick: showUpload }, 'Import another file'))));
  }
}

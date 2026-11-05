// Import & sync: drop a sheet, see what will change, sync. Re-syncing a remembered sheet takes one click.
// New leads are added. A row that matches a lead already in the CRM is flagged as a potential duplicate, with the fields that
// match and the file the lead came from. It is merged (only empty fields are filled, so nothing callers entered is lost) or
// skipped, and only created again if someone chooses "Create anyway".
import { canRemember, forgetSheet, hasChanged, listSheets, pickSheet, readSheet, saveSheet } from '../sheets.js';
import { api, badge, busy, exportButton, field, fill, fmt, h, icon, pageHead, select, stat, toast } from '../ui.js';

const STEPS = ['Choose a sheet', 'Review', 'Done'];
const ISSUE_LABELS = {
  missing_phone: 'Missing phone number',
  invalid_email: 'Invalid email',
  unmatched_company: 'Company not found',
  missing_name: 'Missing name',
};

const stem = (filename) => filename.replace(/\.[^.]+$/, '');
const today = () => new Date().toISOString().slice(0, 10);
const counted = (n, one, many) => `${fmt.num(n)} ${n === 1 ? one : many}`;

export async function render(root, params, ctx, isCurrent) {
  if (!ctx.isAdmin) {
    root.replaceChildren(h('div', { class: 'alert' }, 'Only admins can import leads.'));
    return;
  }
  // One sync in progress: the upload and its report, the mapping, and the choices made on the review page.
  let upload = null;
  let config = null;
  let report = null;
  let decisions = {};
  let source = null; // { handle, remembered } for a file the browser can read again
  const openFolds = new Set();

  const head = h('div', {});
  const steps = h('div', { class: 'steps' });
  const body = h('div', { class: 'stack' });
  const setStep = (n) => steps.replaceChildren(...STEPS.map((label, i) =>
    h('span', { class: `step${i === n ? ' active' : i < n ? ' done' : ''}` }, i < n ? icon('check', 12) : null, label)));
  const setHead = (title, subtitle) => head.replaceChildren(pageHead(title, subtitle));

  root.replaceChildren(head, steps, body);
  await showStart();

  // ---------- step 1: choose a sheet

  async function showStart() {
    setHead('Import & sync', 'Drop your sheet. New leads are added. Leads already in the CRM are flagged as duplicates instead of being added twice, and nothing your callers entered is overwritten.');
    setStep(0);
    upload = report = source = null;
    decisions = {};
    openFolds.clear();

    const input = h('input', { type: 'file', accept: '.xlsx,.csv', hidden: true, onchange: () => input.files[0] && start(input.files[0]) });
    const choose = h('button', {
      class: 'btn large',
      type: 'button',
      onclick: async () => {
        if (!canRemember) return input.click();
        try {
          const handle = await pickSheet();
          if (handle) await start(await handle.getFile(), { handle });
        } catch (error) {
          toast(error.message, { kind: 'error' });
        }
      },
    }, 'Choose a file', h('span', { class: 'arrow' }, icon('arrow')));
    const zone = h('div', {
      class: 'dropzone',
      ondragover: (event) => {
        event.preventDefault();
        zone.classList.add('over');
      },
      ondragleave: () => zone.classList.remove('over'),
      ondrop: async (event) => {
        event.preventDefault();
        zone.classList.remove('over');
        const file = event.dataTransfer.files[0];
        // The handle must be requested now; the drop's data is gone after the first await.
        const handleRequest = event.dataTransfer.items[0]?.getAsFileSystemHandle?.();
        if (!file) return;
        const handle = canRemember ? await handleRequest?.catch(() => null) : null;
        await start(file, handle?.kind === 'file' ? { handle } : {});
      },
    },
    h('span', { class: 'drop-icon' }, icon('sheet', 24)),
    h('h2', {}, 'Drop a spreadsheet'),
    h('p', {}, 'Excel (.xlsx) or CSV, up to 25 MB. The HV template maps itself. Nothing changes until you confirm.'),
    choose,
    input);

    const sheets = await listSheets();
    const statuses = await Promise.all(sheets.map(hasChanged));
    if (!isCurrent()) return;

    fill(body, h('div', { class: 'sync-layout' },
      zone,
      h('div', { class: 'stack' },
        canRemember && sheetsCard(sheets, statuses),
        connectionsCard())));
  }

  function sheetsCard(sheets, statuses) {
    return h('section', { class: 'card panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Your sheets')),
      sheets.length
        ? sheets.map((sheet, i) => {
          const sync = h('button', {
            class: 'btn small call',
            type: 'button',
            onclick: () => busy(sync, async () => start(await readSheet(sheet.handle), { handle: sheet.handle, remembered: sheet })),
          }, icon('refresh', 14), 'Sync now');
          return h('div', { class: 'sync-row' },
            h('span', { class: 'sync-icon on' }, icon('sheet')),
            h('div', {},
              h('strong', { title: sheet.name }, sheet.name),
              h('div', { class: 'muted small' }, statuses[i] ? 'Changed since the last sync' : [sheet.syncedAt ? `Synced ${fmt.ago(sheet.syncedAt).replace('Just now', 'just now')}` : 'Not synced yet', sheet.summary].filter(Boolean).join(' · '))),
            h('div', { class: 'row nowrap' },
              sync,
              h('button', {
                class: 'icon-btn',
                type: 'button',
                title: 'Forget this sheet',
                'aria-label': `Forget ${sheet.name}`,
                onclick: async () => {
                  await forgetSheet(sheet.name);
                  await showStart();
                },
              }, icon('x', 14))));
        })
        : h('p', { class: 'muted' }, 'Sheets you sync appear here. Next time, one click reads the latest version of the file.'));
  }

  function connectionsCard() {
    const zoomSync = h('button', {
      class: 'btn small secondary',
      type: 'button',
      onclick: () => busy(zoomSync, async () => {
        const { linked } = await api('/zoom/sync', { method: 'POST' });
        toast(linked ? `Zoom synced: ${counted(linked, 'call', 'calls')} matched to leads.` : 'Zoom is up to date.', { kind: 'ok' });
      }),
    }, icon('refresh', 14), 'Sync now');
    const row = (iconName, name, on, detail, action) => h('div', { class: 'sync-row' },
      h('span', { class: `sync-icon${on ? ' on' : ''}` }, icon(iconName)),
      h('div', {}, h('strong', {}, name), h('div', { class: 'muted small' }, detail)),
      action || h('span'));
    return h('section', { class: 'card panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Connections')),
      row('phone', 'Zoom Phone', ctx.meta.zoomConfigured, ctx.meta.zoomConfigured ? 'Connected. Calls sync every minute.' : 'Not set up. Add the Zoom keys to .env.', ctx.meta.zoomConfigured && zoomSync),
      row('mail', 'Gmail', Boolean(ctx.meta.mailAddress), ctx.meta.mailAddress ? `Connected as ${ctx.meta.mailAddress}` : 'Not set up. Add the Gmail keys to .env.'),
      h('div', { class: 'sync-row' },
        h('span', { class: 'sync-icon' }, icon('download')),
        h('div', {}, h('strong', {}, 'Download from the CRM'), h('div', { class: 'muted small' }, 'Everything, as Excel')),
        h('span')),
      h('div', { class: 'row' }, exportButton('/companies/export', 'Companies'), exportButton('/contacts/export', 'Contacts')));
  }

  /** Reads the file and goes straight to the review page: there is nothing to set up for a sheet that maps itself. */
  async function start(file, from = {}) {
    source = from;
    fill(body, h('div', { class: 'loading-state' }, `Reading ${file.name}…`));
    try {
      upload = await api('/import/parse', {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      });
      upload.lastModified = file.lastModified;
      // A re-sync keeps the column choices of the last sync, as long as the file still has the same sheets.
      const saved = from.remembered?.config;
      const sameSheets = saved && Object.keys(saved.sheets).sort().join() === Object.keys(upload.config.sheets).sort().join();
      config = sameSheets ? saved : upload.config;
      await recheck();
      // Duplicates of other uploads, or under a different name, need a look. Rows already synced from this same file do not.
      if (report.duplicates.some((d) => d.existing.weak || !d.existing.sameFile)) openFolds.add('duplicates');
      showReview();
    } catch (error) {
      toast(error.message, { kind: 'error' });
      await showStart();
    }
  }

  async function recheck() {
    report = await api('/import/check', { method: 'POST', body: { token: upload.token, config } });
    const known = decisions;
    decisions = Object.fromEntries(report.duplicates.map((d) => [d.ref, known[d.ref] ?? d.suggested]));
  }

  // ---------- step 2: review

  function plan() {
    const count = (kind, choice) => report.duplicates.filter((d) => d.kind === kind && decisions[d.ref] === choice).length;
    const creating = upload.options.values().createMissing;
    return {
      creating,
      newCompanies: report.companies.new + count('company', 'create') + (creating ? missingCompanies() : 0),
      newContacts: report.contacts.new + count('contact', 'create') - (creating ? 0 : report.contacts.unmatched),
      updates: count('company', 'merge') + count('contact', 'merge'),
      skips: count('company', 'skip') + count('contact', 'skip'),
      creates: count('company', 'create') + count('contact', 'create'),
    };
  }

  /** Companies named by contact rows that exist neither in the sheet nor in the CRM. */
  const missingCompanies = () => new Set(report.issues.filter((i) => i.kind === 'unmatched_company').map((i) => i.text)).size;

  const planLine = (p) => [
    p.newCompanies + p.newContacts ? `${fmt.num(p.newCompanies + p.newContacts)} new` : null,
    p.updates ? `${fmt.num(p.updates)} duplicates merged` : null,
    p.skips ? `${fmt.num(p.skips)} skipped` : null,
  ].filter(Boolean).join(' · ') || 'Nothing to change';

  /** What the review will do with the flagged rows, e.g. "9 merged · 3 skipped". */
  const duplicateLine = (p) => [
    `${fmt.num(p.updates)} merged`,
    `${fmt.num(p.skips)} skipped`,
    p.creates ? `${fmt.num(p.creates)} created anyway` : null,
  ].filter(Boolean).join(' · ');

  function fold(key, title, note, content) {
    return h('details', {
      class: 'card fold',
      open: openFolds.has(key),
      ontoggle: (event) => (event.target.open ? openFolds.add(key) : openFolds.delete(key)),
    },
    h('summary', {}, h('span', { class: 'fold-title' }, title, note && h('small', {}, note)), h('span', { class: 'chev' }, icon('chevron'))),
    h('div', { class: 'fold-body' }, content));
  }

  function showReview() {
    setHead(upload.filename, 'Here is what this sync will do. Nothing is saved until you confirm.');
    setStep(1);
    const c = report.companies;
    const p = report.contacts;
    const flagged = c.duplicates + p.duplicates;
    const statBox = h('section', { class: 'stats', 'aria-label': 'What will change' });
    const action = h('span', { class: 'muted' });
    const go = h('button', { class: 'btn large', type: 'button', onclick: () => busy(go, sync) });
    const drawPlan = () => {
      const now = plan();
      // A company that is about to be created is not a problem any more.
      const issueKinds = Object.entries(report.issueCounts).filter(([kind, n]) => n && !(now.creating && kind === 'unmatched_company'));
      fill(statBox,
        stat('New companies', fmt.num(now.newCompanies), c.total ? `of ${fmt.num(c.total)} in the sheet` : now.creating ? 'Created from the contact rows' : 'None in this sheet'),
        stat('New contacts', fmt.num(now.newContacts), `of ${fmt.num(p.total)} in the sheet`),
        stat('Potential duplicates', fmt.num(flagged), flagged ? duplicateLine(now) : 'None found'),
        stat('Problems', fmt.num(issueKinds.reduce((sum, [, n]) => sum + n, 0)), issueKinds.length ? issueKinds.map(([k, n]) => `${n} ${(ISSUE_LABELS[k] || k).toLowerCase()}`).join(' · ') : 'None found'));
      action.textContent = planLine(now);
      go.replaceChildren('Sync to CRM', h('span', { class: 'arrow' }, icon('arrow')));
    };

    upload.options ??= optionsCard();
    const options = upload.options;
    options.refresh(missingCompanies(), drawPlan);
    fill(body,
      statBox,
      report.mergedRows > 0 && h('div', { class: 'note' }, `${counted(report.mergedRows, 'row', 'rows')} repeated a company or contact in the file and were combined.`),
      options.card,
      fold('columns', 'Columns', upload.preset ? `Using the "${upload.preset.name}" mapping` : 'Matched by their names', columnsContent()),
      report.duplicates.length > 0 && fold('duplicates', `Potential duplicates (${fmt.num(flagged)})`, 'Nothing is added twice unless you choose Create anyway', duplicatesContent(drawPlan, flagged)),
      report.issues.length > 0 && fold('problems', `Problems (${fmt.num(report.issues.length)})`, '"NA" and "Not Found" count as empty', issuesContent()),
      h('div', { class: 'action-bar' },
        action,
        h('div', { class: 'row nowrap' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => showStart() }, 'Cancel'), go)));
    drawPlan();

    async function sync() {
      const choice = options.values();
      // The server starts a new list on every import. To keep adding to an existing list, the import fills a new list
      // that is then moved across and deleted. Everyone in the sheet ends up on the list, whether new or already known.
      const intoExisting = /^\d+$/.test(choice.list);
      const listName = intoExisting ? `${stem(upload.filename)} – ${today()}` : choice.list === 'new' ? choice.listName : '';
      const result = await api('/import/commit', {
        method: 'POST',
        body: { token: upload.token, config, decisions, ownerId: choice.owner, listName, createMissingCompanies: choice.createMissing },
      });
      if (intoExisting && result.list) {
        try {
          const { contacts } = await api(`/lists/${result.list.id}`);
          const target = Number(choice.list);
          const { added } = await api(`/lists/${target}/add`, { method: 'POST', body: { contactIds: contacts.map((contact) => contact.id) } });
          await api(`/lists/${result.list.id}`, { method: 'DELETE' });
          result.list = { id: target, name: options.listLabel(), added };
        } catch {
          toast(`The leads are synced, but could not be added to that list. They are in "${result.list.name}" instead.`, { kind: 'warn', timeout: 0 });
        }
      }
      await ctx.refreshMeta().catch(() => {});
      const summary = [`${fmt.num(result.companies.created + result.contacts.created)} new`, `${fmt.num(result.companies.merged + result.contacts.merged)} merged`].join(', ');
      if (source?.handle) {
        await saveSheet({
          name: upload.filename,
          handle: source.handle,
          syncedAt: new Date().toISOString(),
          lastModified: upload.lastModified,
          summary,
          config,
          listId: result.list?.id ?? source.remembered?.listId ?? null,
        }).catch(() => {});
      }
      showDone(result);
    }
  }

  function optionsCard() {
    const callers = ctx.meta.users.filter((u) => u.active);
    const owner = select([['', 'Nobody yet'], ...callers.map((u) => [String(u.id), `${u.name}${u.role === 'caller' ? ' (caller)' : ''}`])], String(callers.find((u) => u.role === 'caller')?.id ?? ''));
    const listName = h('input', { type: 'text', value: `${stem(upload.filename)} – ${today()}`, 'aria-label': 'New call list name' });
    const listChoice = select([['new', 'A new call list'], ['', "Don't add to a list"]], 'new');
    const nameField = field('New list name', listName);
    const toggle = () => {
      nameField.hidden = listChoice.value !== 'new';
    };
    listChoice.addEventListener('change', toggle);
    // Offer the existing lists too, starting on the one this sheet synced into last time.
    api('/lists').then(({ lists }) => {
      listChoice.append(...lists.map((l) => h('option', { value: String(l.id) }, `Add to: ${l.name}`)));
      const last = source?.remembered?.listId;
      if (last && lists.some((l) => l.id === last)) {
        listChoice.value = String(last);
        toggle();
      }
    }).catch(() => {});
    // A file with only contact rows has no company sheet, so its companies have to come from those rows.
    const createMissing = h('input', { type: 'checkbox', checked: !Object.values(config.sheets).some((s) => s.type === 'companies') });
    const missingLabel = h('span');
    const missingRow = h('label', { class: 'check wide', hidden: true }, createMissing, missingLabel);
    return {
      card: h('section', { class: 'card panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Where the leads go')),
        h('div', { class: 'form-grid' },
          field('Give new leads to', owner, 'Callers only see the leads assigned to them.'),
          field('Call list', listChoice, 'So they are ready to dial straight away.'),
          nameField,
          missingRow)),
      refresh: (missing, onToggle) => {
        missingRow.hidden = !missing;
        missingLabel.textContent = `Create the ${counted(missing, 'missing company', 'missing companies')} instead of skipping those contacts`;
        createMissing.onchange = onToggle;
      },
      values: () => ({ owner: owner.value, list: listChoice.value, listName: listName.value, createMissing: createMissing.checked }),
      listLabel: () => listChoice.selectedOptions[0]?.textContent.replace(/^Add to: /, '') || '',
    };
  }

  function columnsContent() {
    const presetSelect = select([['auto', 'Automatic matching'], ...upload.presets.map((preset) => [String(preset.id), preset.name])], upload.preset ? String(upload.preset.id) : 'auto', {
      onchange: (event) => busy(event.target, async () => {
        ({ config } = await api('/import/apply-preset', { method: 'POST', body: { token: upload.token, presetId: event.target.value } }));
        upload.preset = upload.presets.find((preset) => String(preset.id) === event.target.value) || null;
        await redraw();
      }),
    });
    const presetName = h('input', { type: 'text', placeholder: 'Mapping name, e.g. HV template v2', 'aria-label': 'Mapping name' });
    const savePreset = h('button', {
      class: 'btn secondary',
      type: 'button',
      onclick: () => busy(savePreset, async () => {
        ({ presets: upload.presets } = await api('/import/presets', { method: 'POST', body: { token: upload.token, name: presetName.value, config } }));
        toast('Mapping saved. Files with the same sheet names will use it automatically.', { kind: 'ok' });
      }),
    }, 'Save this mapping');
    const used = upload.sheets.filter((s) => config.sheets[s.name].type !== 'skip');
    const skipped = upload.sheets.filter((s) => config.sheets[s.name].type === 'skip');
    return h('div', { class: 'stack' },
      h('div', { class: 'form-grid' }, field('Mapping', presetSelect), h('div', { class: 'inline-form' }, presetName, savePreset)),
      used.map(sheetMapping),
      skipped.length > 0 && h('details', { class: 'extra' },
        h('summary', {}, `${counted(skipped.length, 'other sheet', 'other sheets')} will not be imported`),
        h('div', { class: 'stack section-gap' }, skipped.map(sheetMapping))));
  }

  const targetOptions = (type) => [
    ['extra', 'Keep as extra info'],
    ['', "Don't import"],
    ...(type === 'contacts' ? ctx.meta.contactFields.map(([key, label]) => [`contact.${key}`, `Contact · ${label}`]) : []),
    ...ctx.meta.companyFields.map(([key, label]) => [`company.${key}`, key === 'name' && type === 'contacts' ? 'Company · Company name (links the contact)' : `Company · ${label}`]),
  ];

  function sheetMapping(sheet) {
    const sc = config.sheets[sheet.name];
    const type = select([['companies', 'Companies'], ['contacts', 'Contacts (with their company)'], ['skip', "Don't import"]], sc.type, {
      onchange: (event) => busy(event.target, async () => {
        sc.type = event.target.value;
        await redraw();
      }),
    });
    const heading = h('div', { class: 'panel-head' },
      h('div', {}, h('h3', {}, sheet.name), h('p', { class: 'muted small' }, `${fmt.num(sheet.rowCount)} rows · headers on row ${sheet.headerRow}`)),
      field('Import this sheet as', type));
    if (sc.type === 'skip') return h('div', {}, heading);
    return h('div', {}, heading, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Spreadsheet column'), h('th', {}, 'Example values'), h('th', {}, 'Import as'))),
      h('tbody', {}, sheet.headers.map((header) => h('tr', {},
        h('td', {}, header),
        h('td', { class: 'sample' }, sheet.samples.map((row) => row[header]).filter((v) => v && !/^n\/?a$/i.test(v)).slice(0, 2).join(' · ') || '—'),
        h('td', {}, select(targetOptions(sc.type), sc.columns[header] ?? 'extra', {
          'aria-label': `Import ${header} as`,
          onchange: (event) => busy(event.target, async () => {
            sc.columns[header] = event.target.value;
            await redraw();
          }),
        }))))))));
  }

  /** After a mapping change: count again and redraw the review page, keeping the open sections open. */
  async function redraw() {
    openFolds.add('columns');
    await recheck();
    const y = window.scrollY;
    showReview();
    window.scrollTo(0, y);
  }

  /** "From week1.xlsx · Tue, Nov 3 · List: Week 1", or "Added by hand · Tue, Nov 3". */
  const sourceLine = (e) => [
    e.file ? `From ${e.file}${e.sameFile ? ' (this file)' : ''}` : 'Added by hand',
    fmt.date(e.at),
    e.lists.length ? `${e.lists.length === 1 ? 'List' : 'Lists'}: ${e.lists.join(', ')}` : null,
  ].filter(Boolean).join(' · ');

  function duplicatesContent(onChange, flagged) {
    const choices = [['merge', 'Merge (fill empty fields)'], ['skip', 'Skip'], ['create', 'Create anyway']];
    const rows = report.duplicates.map((d) => [d, select(choices, decisions[d.ref], {
      'aria-label': `What to do with ${d.label}`,
      onchange: (event) => {
        decisions[d.ref] = event.target.value;
        onChange();
      },
    })]);
    const setAll = select([['', 'Set all to…'], ...choices], '', {
      'aria-label': 'Set all',
      onchange: (event) => {
        if (!event.target.value) return;
        for (const [d, el] of rows) {
          el.value = event.target.value;
          decisions[d.ref] = event.target.value;
        }
        onChange();
      },
    });
    // Rows matching leads from other uploads (or typed in) are what the person usually wants to see; rows from an earlier sync of this file are expected.
    const sameFile = report.duplicates.filter((d) => d.existing.sameFile).length;
    const weak = report.duplicates.filter((d) => d.existing.weak).length;
    const summary = [
      sameFile < report.duplicates.length && `Other uploads or added by hand: ${fmt.num(report.duplicates.length - sameFile)}`,
      sameFile > 0 && `This same file, synced before: ${fmt.num(sameFile)}`,
    ].filter(Boolean).join(' · ');
    return h('div', { class: 'stack' },
      h('div', { class: 'panel-head' }, h('span', { class: 'muted' }, summary), setAll),
      weak > 0 && h('div', { class: 'note' },
        `${counted(weak, 'row shares', 'rows share')} an email or phone number with a lead under a different name. ${weak === 1 ? 'It is' : 'They are'} skipped unless you choose otherwise.`),
      flagged > report.duplicates.length && h('p', { class: 'muted' }, `Showing the first ${fmt.num(report.duplicates.length)}. The rest follow the suggestion.`),
      h('div', { class: 'table-wrap scroll' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'In the sheet'), h('th', {}, 'Already in the CRM'), h('th', {}, 'Matching fields'), h('th', {}, 'What to do'))),
        h('tbody', {}, rows.map(([d, el]) => h('tr', {},
          h('td', { class: 'title-cell' },
            badge(d.kind === 'company' ? 'Company' : 'Contact', 'neutral'), ' ', d.label,
            h('div', { class: 'sub' }, `${d.sheet} · row ${d.row}`)),
          h('td', { class: 'title-cell' },
            h('a', { href: d.kind === 'company' ? `#/company/${d.existing.id}` : `#/contact/${d.existing.id}`, target: '_blank' }, d.existing.label),
            h('div', { class: 'sub' }, sourceLine(d.existing))),
          h('td', { class: 'title-cell' },
            d.existing.matched.map((m) => h('div', {}, h('span', { class: 'muted' }, `${m.label}: `), m.value)),
            d.existing.weak && h('div', {}, badge('Different name', 'warn'))),
          h('td', {}, el)))))));
  }

  function issuesContent() {
    return h('div', { class: 'table-wrap scroll' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Sheet'), h('th', { class: 'num' }, 'Row'), h('th', {}, 'Problem'), h('th', {}, 'Details'))),
      h('tbody', {}, report.issues.map((i) => h('tr', {},
        h('td', {}, i.sheet), h('td', { class: 'num' }, i.row), h('td', {}, badge(ISSUE_LABELS[i.kind] || i.kind, i.kind === 'unmatched_company' ? 'missed' : 'warn')), h('td', { class: 'wrap' }, i.text))))));
  }

  // ---------- step 3: done

  function showDone({ companies, contacts, list }) {
    setHead('Sync finished', upload.filename);
    setStep(2);
    const number = (value, label) => h('div', {}, h('strong', {}, fmt.num(value)), h('span', { class: 'muted small' }, label));
    const skipped = companies.skipped + contacts.skipped + contacts.unmatched;
    fill(body, h('section', { class: 'card done-card' },
      h('span', { class: 'drop-icon' }, icon('check', 24)),
      h('h2', { class: 'hero-title' }, 'Your CRM is ', h('em', {}, 'in sync.')),
      h('div', { class: 'done-numbers' },
        number(companies.created, 'new companies'),
        number(contacts.created, 'new contacts'),
        number(companies.merged + contacts.merged, 'duplicates merged'),
        skipped > 0 && number(skipped, 'skipped')),
      contacts.unmatched > 0 && h('p', { class: 'muted' }, `${counted(contacts.unmatched, 'contact', 'contacts')} skipped because their company was not found.`),
      list && h('p', { class: 'muted' }, list.added !== undefined ? `${counted(list.added, 'new lead', 'new leads')} added to "${list.name}".` : `Call list "${list.name}" is ready.`),
      h('div', { class: 'row' },
        list && h('a', { class: 'btn call large', href: `#/dial/${list.id}` }, icon('play'), 'Start dialing'),
        h('a', { class: 'btn secondary large', href: '#/leads' }, 'See the leads'),
        h('button', { class: 'btn ghost large', type: 'button', onclick: () => showStart() }, 'Sync another sheet'))));
  }
}

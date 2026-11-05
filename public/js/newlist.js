// A new call list made from an Excel or CSV sheet, in one dialog: choose the file, see what it holds, name the list, create it.
// It runs the same upload, check and commit steps as Import & sync and takes their suggestion for every duplicate: a lead that is
// already in the CRM goes onto the list with only its empty fields filled in, and nobody is created twice. The list opens when it
// is made. Only admins can import, so only admins are offered this.
import { api, busy, field, fill, fmt, h, icon, openModal, select, toast } from './ui.js';

const PROBLEMS = {
  missing_phone: 'no phone number',
  invalid_email: 'an invalid email',
  unmatched_company: 'a company that was not found',
  missing_name: 'no name',
};

const stem = (filename) => filename.replace(/\.[^.]+$/, '');
const today = () => new Date().toISOString().slice(0, 10);
const counted = (n, one, many) => `${fmt.num(n)} ${n === 1 ? one : many}`;

export function sheetListDialog(ctx) {
  let upload = null; // what the server holds for the chosen file: { token, filename, config, sheets, report }
  let choices = null; // the inputs of the last step, read when the list is created
  const body = h('div', { class: 'stack' });
  const create = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => busy(create, makeList) }, icon('check'), 'Create list');
  const modal = openModal({
    title: 'New call list from a sheet',
    body,
    footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => modal.close() }, 'Cancel'), create],
  });
  showChoose();

  function showChoose() {
    upload = choices = null;
    create.hidden = true;
    const input = h('input', { type: 'file', accept: '.xlsx,.csv', hidden: true, onchange: () => input.files[0] && load(input.files[0]) });
    const zone = h('div', {
      class: 'dropzone compact',
      ondragover: (event) => {
        event.preventDefault();
        zone.classList.add('over');
      },
      ondragleave: () => zone.classList.remove('over'),
      ondrop: (event) => {
        event.preventDefault();
        zone.classList.remove('over');
        if (event.dataTransfer.files[0]) load(event.dataTransfer.files[0]);
      },
    },
    h('span', { class: 'drop-icon' }, icon('sheet', 24)),
    h('h2', {}, 'Drop a spreadsheet'),
    h('p', {}, 'Excel (.xlsx) or CSV, up to 25 MB. The HV template maps itself. Leads already in the CRM are not added twice.'),
    h('button', { class: 'btn', type: 'button', onclick: () => input.click() }, icon('import'), 'Choose a file'),
    input);
    fill(body, zone);
  }

  async function load(file) {
    fill(body, h('div', { class: 'loading-state' }, `Reading ${file.name}…`));
    try {
      const parsed = await api('/import/parse', {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      });
      const report = await api('/import/check', { method: 'POST', body: { token: parsed.token, config: parsed.config } });
      upload = { token: parsed.token, filename: parsed.filename, config: parsed.config, sheets: parsed.sheets, report };
      showReady();
    } catch (error) {
      toast(error.message, { kind: 'error' });
      showChoose();
    }
  }

  function showReady() {
    const { report, config, filename, sheets } = upload;
    // A file with only contact rows has no company sheet, so its companies are made from those rows (as on Import & sync).
    const makeCompanies = !Object.values(config.sheets).some((sheet) => sheet.type === 'companies');
    // Rows that match a lead already in the CRM are merged into it, or left off when the match is weak (a different name).
    const left = report.duplicates.filter((d) => d.kind === 'contact' && d.suggested === 'skip').length;
    const known = report.contacts.duplicates - left;
    const added = report.contacts.new - (makeCompanies ? 0 : report.contacts.unmatched);
    const onList = added + known;
    const problems = Object.entries(report.issueCounts).filter(([kind, n]) => n && !(makeCompanies && kind === 'unmatched_company'));
    const used = sheets.filter((sheet) => config.sheets[sheet.name]?.type !== 'skip');

    const name = h('input', { type: 'text', value: `${stem(filename)} – ${today()}`, 'aria-label': 'List name' });
    const callers = ctx.meta.users.filter((u) => u.active);
    const owner = select(
      [['', 'Nobody yet'], ...callers.map((u) => [String(u.id), `${u.name}${u.role === 'caller' ? ' (caller)' : ''}`])],
      String(callers.find((u) => u.role === 'caller')?.id ?? ''),
    );
    choices = { name, owner, makeCompanies };

    fill(body,
      h('div', { class: 'sync-row' },
        h('span', { class: 'sync-icon on' }, icon('sheet')),
        h('div', {},
          h('strong', { title: filename }, filename),
          h('div', { class: 'muted small' }, used.map((sheet) => `${sheet.name} (${counted(sheet.rowCount, 'row', 'rows')})`).join(' · '))),
        h('button', { class: 'link-btn', type: 'button', onclick: showChoose }, 'Choose another file')),
      onList > 0
        ? h('div', { class: 'list-stats' }, [['On the list', onList], ['New leads', added], ['Already in the CRM', known]]
          .map(([label, value]) => h('div', {}, h('strong', {}, fmt.num(value)), h('span', { class: 'muted small' }, label))))
        : h('div', { class: 'alert' }, report.contacts.total
          ? 'Nobody in this sheet can go on a call list: every row is left off or has no company. Import & sync shows why, row by row.'
          : 'This sheet has no contact rows, so there is nothing to put on a call list. Import & sync can still add its companies.'),
      known > 0 && h('p', { class: 'muted small' }, known === 1
        ? '1 lead is already in the CRM. It goes on the list and only gets its empty fields filled in.'
        : `${fmt.num(known)} leads are already in the CRM. They go on the list and only get their empty fields filled in.`),
      left > 0 && h('div', { class: 'note' }, `${counted(left, 'row shares', 'rows share')} an email or phone number with a lead under a different name, so ${left === 1 ? 'it is' : 'they are'} left off the list. Import & sync lets you decide these one by one.`),
      problems.length > 0 && h('div', { class: 'note' }, `${problems.map(([kind, n]) => `${counted(n, 'row has', 'rows have')} ${PROBLEMS[kind] || kind}`).join(' · ')}. You can fix ${problems.reduce((sum, [, n]) => sum + n, 0) === 1 ? 'it' : 'them'} from the list once it is made.`),
      onList > 0 && [field('List name', name), field('Give new leads to', owner, 'Callers only see the leads assigned to them.')]);
    create.hidden = onList === 0;
    if (onList > 0) {
      name.focus();
      name.select();
    }
  }

  async function makeList() {
    const listName = choices.name.value.trim();
    if (!listName) throw new Error('Name the list.');
    let result;
    try {
      result = await api('/import/commit', {
        method: 'POST',
        body: { token: upload.token, config: upload.config, decisions: {}, ownerId: choices.owner.value, listName, createMissingCompanies: choices.makeCompanies },
      });
    } catch (error) {
      if (error.status === 410) showChoose(); // the server forgot the upload (it keeps it for a while): choose the file again
      throw error;
    }
    await ctx.refreshMeta().catch(() => {});
    modal.close();
    if (!result.list) {
      toast('Nobody was added, so no list was made.', { kind: 'warn' });
      return;
    }
    const { contacts } = result;
    const left = contacts.skipped + contacts.unmatched;
    toast(`"${result.list.name}" is ready with ${counted(contacts.created + contacts.merged, 'lead', 'leads')}: ${fmt.num(contacts.created)} new, ${fmt.num(contacts.merged)} already in the CRM${left ? `. ${counted(left, 'row was', 'rows were')} left off` : ''}.`, { kind: 'ok' });
    ctx.navigate(`#/list/${result.list.id}`);
  }
}

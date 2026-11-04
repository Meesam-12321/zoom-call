// Sheets this browser remembers, so "Sync now" can read the newest version from disk without choosing the file again.
// Uses the File System Access API (Chrome, Edge, Opera, on localhost or HTTPS). Elsewhere files are simply uploaded each time.
const DB_NAME = 'veloq-crm';
const STORE = 'sheets';

export const canRemember = typeof window.showOpenFilePicker === 'function' && typeof indexedDB !== 'undefined';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'name' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Remembered sheets, most recently synced first. Empty when the browser can't remember files. */
export async function listSheets() {
  if (!canRemember) return [];
  const sheets = await run('readonly', (store) => store.getAll()).catch(() => []);
  return sheets.sort((a, b) => (b.syncedAt || '').localeCompare(a.syncedAt || ''));
}

export const saveSheet = (sheet) => run('readwrite', (store) => store.put(sheet));
export const forgetSheet = (name) => run('readwrite', (store) => store.delete(name));

/** Opens the file chooser. Returns the file's handle, or null if the person cancelled. */
export async function pickSheet() {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{
        description: 'Spreadsheets',
        accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'], 'text/csv': ['.csv'] },
      }],
    });
    return handle;
  } catch (error) {
    if (error.name === 'AbortError') return null;
    throw error;
  }
}

/** Reads the current file behind a handle, asking for permission if the browser needs it (only works from a click). */
export async function readSheet(handle) {
  const allowed = (await handle.queryPermission({ mode: 'read' })) === 'granted' || (await handle.requestPermission({ mode: 'read' })) === 'granted';
  if (!allowed) throw new Error('Allow access to the file to sync it.');
  try {
    return await handle.getFile();
  } catch {
    throw new Error(`Can't find ${handle.name} any more. It may have been moved or renamed: choose it again.`);
  }
}

/** True or false when the file can be checked without asking the person; null when the browser would have to ask. */
export async function hasChanged(sheet) {
  try {
    if ((await sheet.handle.queryPermission({ mode: 'read' })) !== 'granted') return null;
    return (await sheet.handle.getFile()).lastModified !== sheet.lastModified;
  } catch {
    return null;
  }
}

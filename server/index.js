import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { Store } from './db.js';
import { startZoomSync } from './sync.js';

const root = path.resolve(import.meta.dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env.PORT) || 4000;
// CRM data is private: only listen on this computer unless HOST is set explicitly (e.g. HOST=0.0.0.0 for the office network).
const HOST = process.env.HOST || '127.0.0.1';

const store = new Store(process.env.DB_FILE || path.join(root, 'data', 'crm.db'));
const app = createApp(store);

// Express 5 hands startup errors (e.g. port already in use) to this callback instead of throwing.
app.listen(PORT, HOST, (error) => {
  if (error) throw error;
  console.log(`Cold-calling CRM → http://localhost:${PORT}`);
  if (!store.get('SELECT 1 FROM users LIMIT 1')) {
    console.log('First run: open the page to create the admin account. Until you do, anyone who can reach this server can create it.');
  }
  startZoomSync(store);
});

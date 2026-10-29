import { createApplication } from './app.js';

const application = createApplication({ databasePath: process.env.DATABASE_PATH });
const port = Number(process.env.PORT) || 3001;
application.http.listen(port, '127.0.0.1', () => {
  console.log(`Respondr API ready at http://127.0.0.1:${port}`);
  console.log('SQLite: local persistence enabled. Reader: disconnected until explicitly connected.');
});
application.http.on('error', error => {
  console.error(`Could not start API: ${error.message}`);
  process.exitCode = 1;
  application.close();
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { await application.close(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

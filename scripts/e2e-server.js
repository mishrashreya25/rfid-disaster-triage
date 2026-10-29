import { createApplication } from '../server/app.js';
const app = createApplication({ databasePath: ':memory:' });
app.http.listen(3002, '127.0.0.1', () => console.log('Isolated browser-test API ready on 3002'));
process.on('SIGINT', () => app.close());
process.on('SIGTERM', () => app.close());

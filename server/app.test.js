import test from 'node:test';
import assert from 'node:assert/strict';
import { io as client } from 'socket.io-client';
import { once } from 'node:events';
import { createApplication } from './app.js';

class FakeSerial {
  constructor(callbacks) { this.callbacks = callbacks; this.status = { phase: 'disconnected', path: null, baudRate: 115200, error: null }; this.port = null; }
  async list() { return [{ path: 'COM25', manufacturer: 'Test device' }]; }
  async connect(path) { this.port = {}; this.status = { ...this.status, phase: 'connected', path }; this.callbacks.onStatus(this.status); }
  async disconnect() { this.port = null; this.status = { ...this.status, phase: 'disconnected' }; this.callbacks.onStatus(this.status); }
}
test('HTTP → simulated/real serial → SQLite → Socket.IO end-to-end, reset confirmation and isolation', async () => {
  const service = createApplication({ databasePath: ':memory:', SerialClass: FakeSerial, tickMs: 20 });
  service.http.listen(0, '127.0.0.1'); await once(service.http, 'listening');
  const url = `http://127.0.0.1:${service.http.address().port}`;
  const socket = client(url, { transports: ['websocket'], autoConnect: false });
  const initial = once(socket, 'state'); socket.connect();
  const post = async (path, body, method = 'POST') => {
    const response = await fetch(`${url}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const initialState = (await initial)[0];
    assert.equal(initialState.patients.length, 0);
    assert.equal(initialState.datasetSize, 15);
    assert.equal((await post('/demo/scan', {})).status, 400);
    assert.equal((await post('/reset', {})).status, 400);
    assert.equal((await post('/settings', { absenceMs: 100 })).status, 400);
    assert.equal((await post('/settings', { absenceMs: 500 })).status, 200);
    assert.equal((await post('/mode', { mode: 'demo' })).status, 200);
    assert.equal((await post('/connect', { path: 'COM25' })).status, 400);
    const arrival = once(socket, 'arrival');
    const scan = await post('/demo/scan', { hold: true });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.demoPresent, true);
    const patient = (await arrival)[0];
    assert.equal(patient.source, 'demo');
    assert.match(patient.id, /^PAT-\d{3}$/);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(service.store.patients().length, 1);
    assert.ok(service.store.patients()[0].rawScans >= 5);
    assert.equal((await post('/demo/scan', {})).status, 400);
    assert.equal((await post('/settings', { absenceMs: 1000 })).status, 400);
    const updated = await post(`/patients/${patient.id}`, { status: 'In treatment' }, 'PATCH');
    assert.equal(updated.data.patients[0].status, 'In treatment');
    await post('/demo/remove', {});
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(service.session.state.phase, 'armed');
    await post('/mode', { mode: 'hardware' });
    await post('/connect', { path: 'COM25' });
    assert.equal((await post('/mode', { mode: 'demo' })).status, 400);
    service.serial.callbacks.onLine('Card UID: 93:4E:7A:B7');
    assert.equal(service.store.patients().length, 2);
    assert.equal(service.store.patients().find(p => p.id !== patient.id).source, 'hardware');
    service.serial.callbacks.onLine('Card UID: 93:4E:7A:B7');
    assert.equal(service.store.patients().length, 2);
    const crossOrigin = await fetch(`${url}/api/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: JSON.stringify({ confirm: 'RESET PATIENT DATA' }) });
    assert.equal(crossOrigin.status, 403);
    await post('/reset', { confirm: 'RESET PATIENT DATA' });
    assert.equal(service.store.patients().length, 0);
    service.serial.callbacks.onLine('Card UID: 93:4E:7A:B7');
    assert.equal(service.store.patients().length, 0);
    assert.equal((await (await fetch(`${url}/api/events`)).json()).events.some(e => e.type === 'patient_reset'), true);
    await post('/disconnect', {});
  } finally { socket.disconnect(); await service.close(); }
});

test('switching sources cannot attach simulated repeats to a hardware patient', async () => {
  const service = createApplication({ databasePath: ':memory:', SerialClass: FakeSerial });
  service.http.listen(0, '127.0.0.1'); await once(service.http, 'listening');
  const url = `http://127.0.0.1:${service.http.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(`${url}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    return res.json();
  };
  try {
    await post('/connect', { path: 'COM25' });
    service.serial.callbacks.onLine('Card UID: 93:4E:7A:B7');
    const hardwarePatient = service.store.patients()[0];
    await post('/disconnect', {});
    await post('/mode', { mode: 'demo' });
    await post('/demo/scan', { hold: true });
    assert.equal(service.store.patients().length, 2);
    assert.equal(service.store.patients().find(p => p.id === hardwarePatient.id).rawScans, 1);
    assert.equal(service.store.patients().find(p => p.id !== hardwarePatient.id).source, 'demo');
    await post('/demo/remove', {});
    await post('/mode', { mode: 'hardware' });
    await post('/connect', { path: 'COM25' });
    service.serial.callbacks.onLine('Card UID: 93:4E:7A:B7');
    assert.equal(service.store.patients().length, 2);
    assert.equal(service.store.patients().find(p => p.id === hardwarePatient.id).rawScans, 2);
  } finally { await service.close(); }
});

test('5000 hardware reads persist exactly once each, create one arrival, and coalesce UI updates', async () => {
  const service = createApplication({ databasePath: ':memory:', SerialClass: FakeSerial });
  service.http.listen(0, '127.0.0.1'); await once(service.http, 'listening');
  const url = `http://127.0.0.1:${service.http.address().port}`;
  const socket = client(url, { transports: ['websocket'], autoConnect: false });
  let updates = 0;
  socket.on('state', () => updates++);
  const initial = once(socket, 'state'); socket.connect(); await initial;
  try {
    await service.serial.connect('COM25');
    const arrival = once(socket, 'arrival');
    service.serial.callbacks.onLines(Array(5000).fill('Card UID: 93:4E:7A:B7'));
    await arrival;
    assert.equal(service.store.patients().length, 1);
    assert.equal(service.store.patients()[0].rawScans, 5000);
    assert.equal(service.store.events(10000).filter(event => event.type === 'repeat_read').length, 4999);
    assert.equal(service.store.events(10000).filter(event => event.type === 'arrival').length, 1);
    assert.equal(updates, 2); // initial state plus one coalesced update
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
  } finally { socket.disconnect(); await service.close(); }
});

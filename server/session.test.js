import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScanSession, parseUid } from './session.js';
import { createStore, migrateLegacyPatientIds } from './store.js';
import { samplePatients } from './patients.js';

const line = 'Card UID: 93:4E:7A:B7';
function fixture(options = {}) {
  let clock = 1000000;
  const store = createStore(':memory:');
  const session = new ScanSession({ store, now: () => clock, choose: () => 0, ...options });
  return { store, session, advance: ms => { clock += ms; }, close: () => store.close() };
}
test('parser accepts only complete, valid 4, 7 or 10 byte UID lines', () => {
  assert.equal(parseUid('Card UID: 93:4e:7a:b7\r'), '93:4E:7A:B7');
  assert.equal(parseUid('Card UID: 01:02:03:04:05:06:07'), '01:02:03:04:05:06:07');
  assert.equal(parseUid('Card UID: 01:02:03:04:05:06:07:08:09:10'), '01:02:03:04:05:06:07:08:09:10');
  for (const invalid of ['ESP8266 + RC522 Starting...', 'RC522 Version: 0x92', 'prefix Card UID: 93:4E:7A:B7',
    'Card UID: 93:4E:7A:ZZ', 'Card UID: 93:4E:7A:B7 trailing', 'Card UID: 01:02:03:04:05', '93:4E:7A:B7']) assert.equal(parseUid(invalid), null);
});
test('continuous held tag for 30 seconds makes one arrival, updates counts and preserves first arrival', () => {
  const f = fixture();
  try {
    assert.equal(f.store.patients().length, 0);
    assert.equal(f.session.read(line, 'hardware').kind, 'arrival');
    const first = f.store.patients()[0];
    for (let i = 0; i < 150; i++) { f.advance(200); f.session.read(line, 'hardware'); f.session.tick(); }
    const patients = f.store.patients();
    assert.equal(patients.length, 1);
    assert.equal(patients[0].arrivedAt, first.arrivedAt);
    assert.equal(patients[0].rawScans, 151);
    assert.notEqual(patients[0].lastSeenAt, first.arrivedAt);
    assert.equal(f.store.events(1000).filter(e => e.type === 'arrival').length, 1);
    f.advance(1999); assert.equal(f.session.tick(), false);
    f.advance(1); assert.equal(f.session.tick(), true);
    assert.equal(f.session.read(line, 'hardware').kind, 'arrival');
    assert.equal(f.store.patients().length, 2);
  } finally { f.close(); }
});
test('all fifteen random selections are unique and exhausted sessions do not create arrivals', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 15; i++) {
      assert.equal(f.session.read(line, 'demo').kind, 'arrival');
      f.advance(2000); f.session.tick();
    }
    assert.equal(new Set(f.store.patients().map(p => p.id)).size, 15);
    assert.equal(f.session.read(line, 'demo').kind, 'exhausted');
    assert.equal(f.session.read(line, 'demo').kind, 'repeat');
    assert.equal(f.store.patients().length, 15);
    assert.equal(f.store.events().filter(e => e.type === 'dataset_exhausted').length, 1);
  } finally { f.close(); }
});
test('startup chatter and unknown tags never register patients', () => {
  const f = fixture();
  try {
    assert.equal(f.session.read('RC522 detected successfully!', 'hardware').kind, 'ignored');
    assert.equal(f.session.read('Card UID: 00:00:00:00', 'hardware').kind, 'unknown');
    assert.equal(f.store.patients().length, 0);
    assert.equal(f.session.state.phase, 'armed');
  } finally { f.close(); }
});
test('reset while a tag is present cannot create a new arrival until absence is observed', () => {
  const f = fixture();
  try {
    f.store.event({ type: 'connected', message: 'COM25 connected.', source: 'hardware' });
    f.session.read(line, 'demo');
    f.store.reset(); f.session.resetPatients();
    assert.equal(f.store.patients().length, 0);
    assert.ok(f.store.events().some(e => e.type === 'connected'));
    assert.ok(!f.store.events().some(e => e.type === 'arrival'));
    f.advance(100); assert.equal(f.session.read(line, 'demo').kind, 'repeat');
    assert.equal(f.store.patients().length, 0);
    f.advance(2000); f.session.tick();
    assert.equal(f.session.read(line, 'demo').kind, 'arrival');
  } finally { f.close(); }
});
test('disk SQLite retains records, settings, events and held session across backend restart', () => {
  const folder = mkdtempSync(join(tmpdir(), 'respondr-test-'));
  const filename = join(folder, 'test.sqlite');
  let store = createStore(filename);
  try {
    const first = new ScanSession({ store, now: () => 1000000, choose: () => 0 });
    first.read(line, 'hardware'); first.read(line, 'hardware');
    store.setSetting('absenceMs', '3000');
    store.close();
    store = createStore(filename);
    assert.equal(store.patients().length, 1);
    assert.equal(store.patients()[0].rawScans, 2);
    assert.equal(store.getSetting('absenceMs'), '3000');
    assert.equal(store.events().filter(e => e.type === 'arrival').length, 1);
    const resumed = new ScanSession({ store, now: () => 1050000, choose: () => 0 });
    resumed.setMonitoring(false);
    assert.equal(resumed.tick(), false);
    resumed.setMonitoring(true);
    assert.equal(resumed.read(line, 'hardware').kind, 'repeat');
    assert.equal(store.patients().length, 1);
    assert.equal(store.patients()[0].rawScans, 3);
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});
test('transport disconnect does not count as tag absence; reconnect suppresses a held tag', () => {
  const f = fixture();
  try {
    f.session.read(line, 'hardware');
    f.session.setMonitoring(false); f.advance(30000);
    assert.equal(f.session.tick(), false);
    f.session.setMonitoring(true);
    assert.equal(f.session.read(line, 'hardware').kind, 'repeat');
    assert.equal(f.store.patients().length, 1);
    f.advance(2000); assert.equal(f.session.tick(), true);
  } finally { f.close(); }
});

test('legacy ID migration preserves saved arrivals, linked events, and active session suppression', () => {
  const f = fixture();
  try {
    const timestamp = new Date(1000000).toISOString();
    f.store.register({ ...samplePatients[0], id: 'DEMO-001' }, '93:4E:7A:B7', timestamp, 'hardware');
    f.store.seen('DEMO-001', timestamp);
    f.store.event({ type: 'arrival', source: 'hardware', patientId: 'DEMO-001', message: 'DEMO-001 registered.' });
    f.store.setSetting('activeSession', JSON.stringify({ uid: '93:4E:7A:B7', patientId: 'DEMO-001', lastRead: 1000000, source: 'hardware', reads: 2 }));
    migrateLegacyPatientIds(f.store.db);
    migrateLegacyPatientIds(f.store.db); // repeat startup migration is safe
    const patient = f.store.patients()[0];
    assert.equal(patient.id, 'PAT-001');
    assert.equal(patient.arrivedAt, timestamp);
    assert.equal(patient.rawScans, 2);
    assert.equal(f.store.events()[0].patientId, 'PAT-001');
    assert.equal(f.store.events()[0].message, 'PAT-001 registered.');
    const resumed = new ScanSession({ store: f.store, now: () => 1000100 });
    assert.equal(resumed.state.patientId, 'PAT-001');
    assert.equal(resumed.read(line, 'hardware').kind, 'repeat');
    assert.equal(f.store.patients().length, 1);
    assert.equal(f.store.patients()[0].rawScans, 3);
  } finally { f.close(); }
});

test('startup updates placeholder names and event history while preserving patient data and custom names', () => {
  const folder = mkdtempSync(join(tmpdir(), 'respondr-names-'));
  const filename = join(folder, 'test.sqlite');
  let store = createStore(filename);
  try {
    const timestamp = new Date(1000000).toISOString();
    store.register({ ...samplePatients[0], id: 'DEMO-001', name: 'Patient Alpha' }, '93:4E:7A:B7', timestamp, 'hardware');
    store.seen('DEMO-001', timestamp);
    store.register({ ...samplePatients[1], name: 'Kiran Shah' }, '93:4E:7A:B7', timestamp, 'hardware');
    store.event({ type: 'arrival', source: 'hardware', patientId: 'DEMO-001', message: 'Patient Alpha registered.' });
    const before = store.patients().find(patient => patient.id === 'DEMO-001');
    store.close();
    store = createStore(filename);
    const expected = { ...before, id: 'PAT-001', name: samplePatients[0].name };
    assert.deepEqual(store.patients().find(patient => patient.id === 'PAT-001'), expected);
    assert.equal(store.patients().find(patient => patient.id === 'PAT-002').name, 'Kiran Shah');
    assert.equal(store.events()[0].message, `${samplePatients[0].name} registered.`);
    assert.equal(store.events()[0].patientId, 'PAT-001');
    store.close();
    store = createStore(filename);
    assert.deepEqual(store.patients().find(patient => patient.id === 'PAT-001'), expected);
    assert.equal(store.patients().find(patient => patient.id === 'PAT-002').name, 'Kiran Shah');
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('hardware pool has fifteen neutral IDs and a neutral exhaustion message', () => {
  const f = fixture();
  try {
    assert.equal(samplePatients.length, 15);
    assert.equal(new Set(samplePatients.map(patient => patient.id)).size, 15);
    assert.ok(samplePatients.every(patient => /^PAT-\d{3}$/.test(patient.id)));
    for (let i = 0; i < 15; i++) {
      assert.equal(f.session.read(line, 'hardware').kind, 'arrival');
      f.advance(2000); f.session.tick();
    }
    assert.equal(f.session.read(line, 'hardware').kind, 'exhausted');
    const event = f.store.events().find(event => event.type === 'dataset_exhausted');
    assert.match(event.message, /All 15 patient profiles/);
    assert.doesNotMatch(event.message, /demo/i);
    assert.equal(f.store.patients().length, 15);
  } finally { f.close(); }
});

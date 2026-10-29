import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { SerialManager, serialError } from './serial.js';

class MockPort extends Duplex {
  static ports = [{ path: 'COM25', manufacturer: 'Test CP210x' }];
  static openError = null;
  static signalError = null;
  static list = async () => MockPort.ports;
  constructor(options) { super(); this.options = options; this.isOpen = false; this.signalChanges = []; }
  _read() {}
  _write(_data, _encoding, callback) { callback(); }
  open(callback) { queueMicrotask(() => { this.isOpen = !MockPort.openError; callback(MockPort.openError); }); }
  set(flags, callback) { this.signalChanges.push(flags); callback(MockPort.signalError); }
  close(callback) { this.isOpen = false; this.emit('close'); callback(); }
}
function fixture() {
  const lines = [], statuses = [], events = [];
  const serial = new SerialManager({ Port: MockPort, resetDelayMs: 0, onLine: line => lines.push(line), onStatus: state => statuses.push({ ...state }), onEvent: (...args) => events.push(args) });
  return { serial, lines, statuses, events };
}
test('serial reader parses fragmented USB chunks into newline-delimited messages', async () => {
  const { serial, lines, statuses, events } = fixture();
  await serial.connect('COM25');
  assert.equal(serial.port.options.baudRate, 115200);
  assert.equal(serial.port.options.rtscts, false);
  assert.deepEqual(serial.port.signalChanges, [{ dtr: false, rts: false }, { dtr: false, rts: true }, { dtr: false, rts: false }]);
  assert.equal(serial.status.phase, 'connected');
  serial.port.push('ESP8266 Starting...\r\nCard UID: 93:4E:');
  serial.port.push('7A:B7\r\nCard UID: 93:4E:7A:B7\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lines, ['ESP8266 Starting...\r', 'Card UID: 93:4E:7A:B7\r', 'Card UID: 93:4E:7A:B7']);
  assert.equal(serial.status.receivedLines, 3);
  assert.ok(serial.status.receivedBytes > 0);
  assert.ok(serial.status.lastReceivedAt);
  await serial.disconnect();
  assert.equal(serial.status.phase, 'disconnected');
  assert.ok(statuses.some(s => s.phase === 'connecting'));
  assert.ok(events.some(e => e[0] === 'connected'));
  assert.ok(events.some(e => e[0] === 'disconnected'));
});
test('a failed ESP8266 control-line setup closes the port and never reports connected', async () => {
  const { serial, statuses } = fixture();
  MockPort.signalError = new Error('USB device unavailable');
  try {
    await assert.rejects(serial.connect('COM25'), /USB device unavailable/);
    assert.equal(serial.port, null);
    assert.equal(serial.status.phase, 'error');
    assert.ok(!statuses.some(status => status.phase === 'connected'));
  } finally { MockPort.signalError = null; }
});
test('unavailable and occupied ports report truthful status and actionable errors', async () => {
  const { serial } = fixture();
  await assert.rejects(serial.connect('COM99'), /unavailable/);
  assert.equal(serial.status.phase, 'disconnected');
  MockPort.openError = new Error('Access denied');
  try {
    await assert.rejects(serial.connect('COM25'), /Close Arduino Serial Monitor/);
    assert.equal(serial.status.phase, 'error');
    assert.equal(serial.port, null);
  } finally { MockPort.openError = null; }
  await serial.connect('COM25');
  await assert.rejects(serial.connect('COM25'), /Disconnect/);
  serial.port.emit('close');
  assert.equal(serial.status.phase, 'disconnected');
});
test('serial errors distinguish port contention from missing devices', () => {
  assert.match(serialError(new Error('Port is busy'), 'COM25'), /Arduino Serial Monitor/);
  assert.match(serialError(new Error('File not found'), 'COM25'), /Check the USB connection/);
});

test('rapid serial input is delivered in bounded batches without losing reads', async () => {
  const batches = [];
  const serial = new SerialManager({ Port: MockPort, resetDelayMs: 0,
    onLines: lines => batches.push(lines), onStatus: () => {}, onEvent: () => {} });
  await serial.connect('COM25');
  try {
    const line = 'Card UID: 93:4E:7A:B7\r\n';
    serial.port.push(line.repeat(5001));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(batches.flat().length, 5001);
    assert.ok(batches.every(batch => batch.length <= 500));
    assert.equal(serial.status.receivedLines, 5001);
    assert.equal(serial.status.receivedBytes, Buffer.byteLength(line) * 5001);
  } finally { await serial.disconnect(); }
});

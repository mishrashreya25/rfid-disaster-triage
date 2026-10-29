import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

export function serialError(error, path) {
  const message = error.message || String(error);
  if (/access denied|busy|in use|cannot lock|permission/i.test(message)) {
    return `${path} is busy or access was denied. Close Arduino Serial Monitor, Serial Plotter, or any other program using this port, then reconnect.`;
  }
  return `Could not use ${path}: ${message}. Check the USB connection and refresh available ports.`;
}

export class SerialManager {
  constructor({ onLine, onLines, onStatus, onEvent, Port = SerialPort, Parser = ReadlineParser, resetOnConnect = true, resetDelayMs = 100 }) {
    Object.assign(this, { onLine, onLines, onStatus, onEvent, Port, Parser, resetOnConnect, resetDelayMs });
    this.port = null;
    this.status = { phase: 'disconnected', path: null, baudRate: 115200, error: null, open: false,
      receivedBytes: 0, receivedLines: 0, connectedAt: null, lastReceivedAt: null };
  }
  update(value) { this.status = { ...this.status, ...value, open: Boolean(this.port?.isOpen) }; this.onStatus(this.status); }
  async list() {
    const ports = await this.Port.list();
    return ports.map(p => ({ path: p.path, manufacturer: p.manufacturer || 'Serial device', serialNumber: p.serialNumber || null }));
  }
  async connect(path) {
    if (this.status.phase === 'connecting' || this.port) throw new Error('Disconnect the current reader before opening another port.');
    const ports = await this.list();
    if (!ports.some(p => p.path === path)) throw new Error(`${path} is unavailable. Plug in the reader and refresh the port list.`);
    if (this.status.phase === 'connecting' || this.port) throw new Error('Disconnect the current reader before opening another port.');
    this.update({ phase: 'connecting', path, error: null, receivedBytes: 0, receivedLines: 0, connectedAt: null, lastReceivedAt: null });
    const port = new this.Port({ path, baudRate: 115200, autoOpen: false, rtscts: false });
    this.port = port;
    const parser = port.pipe(new this.Parser({ delimiter: '\n' }));
    let pendingLines = [];
    let pendingFlush = null;
    const flush = () => {
      if (pendingFlush) clearImmediate(pendingFlush);
      pendingFlush = null;
      const lines = pendingLines;
      pendingLines = [];
      if (lines.length && this.port === port) this.onLines(lines);
    };
    parser.on('data', line => {
      if (this.port !== port || !port.isOpen) return;
      this.status.receivedLines++;
      if (!this.onLines) return this.onLine(String(line));
      pendingLines.push(String(line));
      if (pendingLines.length >= 500) flush();
      else if (!pendingFlush) pendingFlush = setImmediate(flush);
    });
    port.on('data', chunk => {
      if (this.port === port) this.update({ receivedBytes: this.status.receivedBytes + chunk.length, lastReceivedAt: new Date().toISOString() });
    });
    parser.on('error', error => this.onEvent('serial_error', `Serial parser: ${error.message}`));
    port.on('error', error => {
      if (this.port !== port) return;
      const message = serialError(error, path);
      this.update({ phase: 'error', error: message });
      this.onEvent('serial_error', message);
    });
    port.on('close', () => {
      flush();
      port.unpipe(parser);
      parser.destroy();
      if (this.port !== port) return;
      this.port = null;
      this.update({ phase: 'disconnected', error: null });
      this.onEvent('disconnected', `${path} disconnected.`);
    });
    await new Promise((resolve, reject) => port.open(error => {
      if (error) {
        this.port = null;
        port.unpipe(parser);
        parser.destroy();
        const message = serialError(error, path);
        this.update({ phase: 'error', error: message });
        this.onEvent('serial_error', message);
        reject(new Error(message));
      } else {
        resolve();
      }
    }));
    try {
      const setSignals = flags => new Promise((resolve, reject) => port.set(flags, error => error ? reject(error) : resolve()));
      // DTR drives GPIO0 and RTS drives reset on NodeMCU boards. Release both,
      // then reset with GPIO0 high so the existing sketch boots normally.
      await setSignals({ dtr: false, rts: false });
      if (this.resetOnConnect) {
        try {
          await setSignals({ dtr: false, rts: true });
          await new Promise(resolve => setTimeout(resolve, this.resetDelayMs));
        } finally {
          if (port.isOpen) await setSignals({ dtr: false, rts: false });
        }
      }
      if (this.port !== port || !port.isOpen) throw new Error('Device disconnected during reader initialization');
      this.update({ phase: 'connected', error: null, connectedAt: new Date().toISOString() });
      this.onEvent('connected', `${path} connected at 115200 baud.${this.resetOnConnect ? ' ESP8266 reset into normal firmware mode.' : ''}`);
    } catch (error) {
      if (port.isOpen) await new Promise(resolve => port.close(resolve));
      if (this.port === port) this.port = null;
      const message = serialError(error, path);
      this.update({ phase: 'error', error: message });
      this.onEvent('serial_error', message);
      throw new Error(message);
    }
  }
  async disconnect() {
    const port = this.port;
    if (this.status.phase === 'connecting') throw new Error('Wait for the connection attempt to finish.');
    if (!port?.isOpen) {
      this.port = null;
      this.update({ phase: 'disconnected', error: null });
      return;
    }
    await new Promise((resolve, reject) => port.close(error => error ? reject(error) : resolve()));
  }
}

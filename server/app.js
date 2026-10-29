import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createStore } from './store.js';
import { ScanSession } from './session.js';
import { SerialManager } from './serial.js';
import { KNOWN_UID, samplePatients } from './patients.js';

export function createApplication({ databasePath = resolve('data/triage.sqlite'), SerialClass = SerialManager, tickMs = 100 } = {}) {
  const app = express();
  const http = createServer(app);
  const io = new Server(http, { maxHttpBufferSize: 16_384 });
  const store = createStore(databasePath);
  let mode = 'hardware';
  let demoTimer = null;
  let presentationTimer = null;
  let lastLine = null;
  let closed = false;
  let broadcastTimer = null;
  let arrivalsToNotify = [];
  const snapshot = () => ({ patients: store.patients(), events: store.events(200, false), mode,
    serial: serial.status, scanner: session.state, demoPresent: demoTimer !== null,
    lastLine, datasetSize: samplePatients.length, knownUid: KNOWN_UID });
  // A held tag can generate hundreds of reads each second. Keep every database
  // update, but publish one fresh UI snapshot per 100 ms instead of per read.
  const broadcast = () => {
    if (closed || broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      if (closed) return;
      io.emit('state', snapshot());
      const arrivals = arrivalsToNotify;
      arrivalsToNotify = [];
      for (const patient of arrivals) io.emit('arrival', patient);
    }, 100);
  };
  const sessionOptions = { store,
    absenceMs: Number(store.getSetting('absenceMs')) || 2000,
    onChange: broadcast, onArrival: patient => { arrivalsToNotify.push(patient); broadcast(); } };
  const hardwareSession = new ScanSession({ ...sessionOptions, persistenceKey: 'activeSession:hardware' });
  const demoSession = new ScanSession({ ...sessionOptions, persistenceKey: 'activeSession:demo' });
  let session = hardwareSession;
  const processHardwareLines = lines => {
    if (mode !== 'hardware' || closed) return;
    store.db.transaction(() => {
      for (const line of lines) {
        lastLine = { text: line.slice(0, 200), source: 'hardware', timestamp: new Date().toISOString() };
        hardwareSession.read(line, 'hardware');
      }
    })();
    broadcast();
  };
  const serial = new SerialClass({
    onLine: line => processHardwareLines([line]),
    onLines: processHardwareLines,
    onStatus: status => {
      hardwareSession.setMonitoring(status.phase === 'connected');
      broadcast();
    },
    onEvent: (type, message) => {
      store.event({ type, message, source: 'hardware' });
      broadcast();
    },
  });
  session.setMonitoring(false);
  store.event({ type: 'server_started', message: 'Local intake service started. SQLite persistence ready.', source: 'system' });
  const ticker = setInterval(() => { hardwareSession.tick(); demoSession.tick(); }, tickMs);
  const stopDemo = () => {
    clearInterval(demoTimer);
    clearTimeout(presentationTimer);
    demoTimer = null;
    presentationTimer = null;
    broadcast();
  };
  const demoRead = () => {
    lastLine = { text: `Card UID: ${KNOWN_UID}`, source: 'demo', timestamp: new Date().toISOString() };
    demoSession.read(lastLine.text, 'demo');
  };
  const startDemo = (hold) => {
    if (mode !== 'demo') throw new Error('Enable Demo Mode before simulating a scan.');
    if (demoTimer || session.active) throw new Error('Remove the tag and wait for the scanner to rearm before presenting it again.');
    // Set present before first read so emitted snapshots accurately reflect the source.
    demoTimer = setInterval(demoRead, 200);
    demoRead();
    if (!hold) presentationTimer = setTimeout(stopDemo, 850);
    broadcast();
  };

  app.disable('x-powered-by');
  app.use(express.json({ limit: '8kb' }));
  // Local-only backend. Block cross-origin browser mutations, including DNS-rebinding
  // requests, while allowing Vite's same-machine proxy and native test clients.
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    const host = req.get('host')?.split(':')[0];
    if (host && !['localhost', '127.0.0.1', '['].includes(host)) return res.status(403).json({ error: 'Local connections only.' });
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
          return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
      } catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
    }
    next();
  });
  const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/state', (_req, res) => res.json(snapshot()));
  app.get('/api/ports', route(async (_req, res) => res.json({ ports: await serial.list() })));
  app.get('/api/events', (req, res) => {
    const requested = Number(req.query.limit) || 1000;
    res.json({ events: store.events(Math.min(10000, Math.max(1, Math.floor(requested)))) });
  });
  app.post('/api/connect', route(async (req, res) => {
    if (mode !== 'hardware') throw new Error('Disable Demo Mode before connecting a physical reader.');
    if (typeof req.body.path !== 'string' || !req.body.path.trim()) throw new Error('Select an available COM port first.');
    await serial.connect(req.body.path);
    res.json(snapshot());
  }));
  app.post('/api/disconnect', route(async (_req, res) => { await serial.disconnect(); res.json(snapshot()); }));
  app.post('/api/mode', route(async (req, res) => {
    if (!['hardware', 'demo'].includes(req.body.mode)) throw new Error('Choose hardware or demo mode.');
    if (serial.status.phase === 'connecting' || serial.port) throw new Error('Disconnect the physical reader before changing modes.');
    if (req.body.mode !== mode) {
      stopDemo();
      mode = req.body.mode;
      session = mode === 'demo' ? demoSession : hardwareSession;
      lastLine = null;
      store.event({ type: 'mode_changed', message: mode === 'demo' ? 'Demo Mode enabled. All simulated reads are labelled DEMO.' : 'Hardware mode enabled. Waiting for a physical reader.', source: 'system' });
      broadcast();
    }
    res.json(snapshot());
  }));
  app.post('/api/demo/scan', route(async (req, res) => { startDemo(req.body.hold === true); res.json(snapshot()); }));
  app.post('/api/demo/remove', (_req, res) => { stopDemo(); res.json(snapshot()); });
  app.post('/api/reset', route(async (req, res) => {
    if (req.body.confirm !== 'RESET PATIENT DATA') throw new Error('Confirm Reset Patient Data before clearing registrations.');
    stopDemo();
    store.reset();
    arrivalsToNotify = [];
    hardwareSession.resetPatients();
    demoSession.resetPatients();
    store.event({ type: 'patient_reset', message: 'Patient registrations and related scan events cleared by operator.', source: 'system' });
    broadcast();
    res.json(snapshot());
  }));
  app.post('/api/settings', route(async (req, res) => {
    const value = Number(req.body.absenceMs);
    if (!Number.isInteger(value) || value < 500 || value > 10000) throw new Error('Tag absence must be between 500 and 10000 milliseconds.');
    if (hardwareSession.active || demoSession.active) throw new Error('Remove the tag and wait for the scanner to rearm before changing this setting.');
    store.setSetting('absenceMs', value);
    hardwareSession.absenceMs = value;
    demoSession.absenceMs = value;
    store.event({ type: 'settings_changed', message: `Tag absence threshold set to ${value / 1000} seconds.`, source: 'system' });
    broadcast();
    res.json(snapshot());
  }));
  app.patch('/api/patients/:id', route(async (req, res) => {
    if (!['Awaiting triage', 'In treatment', 'Discharged'].includes(req.body.status)) throw new Error('Invalid intake status.');
    const result = store.db.prepare('UPDATE registrations SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Patient not found.' });
    store.event({ type: 'status_changed', message: `${req.params.id} moved to ${req.body.status.toLowerCase()}.`,
      source: 'system', patientId: req.params.id, demoRelated: 1 });
    broadcast();
    res.json(snapshot());
  }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  const dist = resolve('dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  app.use((error, _req, res, _next) => {
    console.error(error.message);
    res.status(400).json({ error: error.message || 'Request could not be completed.' });
  });
  io.on('connection', socket => socket.emit('state', snapshot()));
  return { app, http, io, store, get session() { return session; }, serial, snapshot,
    async close() {
      closed = true;
      clearInterval(ticker);
      clearTimeout(broadcastTimer);
      stopDemo();
      await serial.disconnect();
      await new Promise(resolve => io.close(resolve));
      store.close();
    },
  };
}

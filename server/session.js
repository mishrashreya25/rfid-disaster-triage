import { randomInt } from 'node:crypto';
import { samplePatients, KNOWN_UID } from './patients.js';

export function parseUid(line) {
  const match = /^Card UID:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){3}(?:(?::[0-9a-f]{2}){3})?(?:(?::[0-9a-f]{2}){3})?)\s*$/i.exec(line.trim());
  return match ? match[1].toUpperCase() : null;
}

// A session stays active for as long as reads continue, regardless of elapsed time.
// A generation guard in the transport prevents old/closed streams creating sessions.
export class ScanSession {
  constructor({ store, absenceMs = 2000, now = Date.now, choose = randomInt, onChange = () => {}, onArrival = () => {}, persistenceKey = 'activeSession' }) {
    Object.assign(this, { store, absenceMs, now, choose, onChange, onArrival, persistenceKey });
    this.active = null;
    this.monitoring = true;
    this.resumeAt = 0;
    try { this.active = JSON.parse(store.getSetting(persistenceKey) || 'null'); } catch { /* no valid prior session */ }
    this.ready = !this.active;
    if (this.active) this.resumeAt = this.now();
  }
  saveSession() { this.store.setSetting(this.persistenceKey, JSON.stringify(this.active)); }
  setMonitoring(value) {
    if (value && !this.monitoring) this.resumeAt = this.now();
    this.monitoring = value;
  }
  get state() {
    return { phase: this.active ? 'present' : this.ready ? 'armed' : 'waiting',
      lastSeenAt: this.active ? new Date(this.active.lastRead).toISOString() : null,
      patientId: this.active?.patientId ?? null, rawScans: this.active?.reads ?? 0, absenceMs: this.absenceMs };
  }
  read(line, source) {
    const uid = parseUid(line);
    if (!uid) return { kind: 'ignored' };
    const timestamp = new Date(this.now()).toISOString();
    if (uid !== KNOWN_UID) {
      this.store.event({ type: 'unknown_uid', message: `Unrecognized tag ${uid}; no patient registered.`, source, uid, timestamp, demoRelated: 1 });
      this.onChange();
      return { kind: 'unknown' };
    }
    // If a timer was delayed by the event loop, honor the actual interval between reads.
    this.tick();
    if (this.active) {
      this.active.lastRead = this.now();
      this.active.reads++;
      this.saveSession();
      if (this.active.patientId) this.store.seen(this.active.patientId, timestamp);
      this.store.event({ type: 'repeat_read', message: 'Tag still present · repeat read suppressed.', source, uid, timestamp,
        patientId: this.active.patientId, demoRelated: 1 });
      this.onChange();
      return { kind: 'repeat' };
    }
    const used = new Set(this.store.patients().map(p => p.id));
    const available = samplePatients.filter(p => !used.has(p.id));
    const patient = available.length ? available[this.choose(available.length)] : null;
    this.active = { uid, lastRead: this.now(), patientId: patient?.id ?? null, source, reads: 1 };
    this.ready = false;
    this.saveSession();
    if (!patient) {
      this.store.event({ type: 'dataset_exhausted', message: `All ${samplePatients.length} patient profiles are registered. Reset patient data to start a new intake.`, source, uid, timestamp, demoRelated: 1 });
      this.onChange();
      return { kind: 'exhausted' };
    }
    this.store.db.transaction(() => {
      this.store.register(patient, uid, timestamp, source);
      this.store.event({ type: 'arrival', message: `${patient.name} registered · ${patient.triage} priority.`,
        source, uid, timestamp, patientId: patient.id, demoRelated: 1 });
    })();
    this.onChange();
    this.onArrival({ ...patient, uid, arrivedAt: timestamp, lastSeenAt: timestamp, rawScans: 1, source, status: 'Awaiting triage' });
    return { kind: 'arrival', patient };
  }
  tick() {
    if (this.monitoring && this.active && this.now() - Math.max(this.active.lastRead, this.resumeAt) >= this.absenceMs) {
      const { source, patientId, uid } = this.active;
      this.active = null;
      this.ready = true;
      this.saveSession();
      this.store.event({ type: 'rearmed', message: 'Tag absent · scanner rearmed for the next arrival.', source, patientId, uid, demoRelated: 1,
        timestamp: new Date(this.now()).toISOString() });
      this.onChange();
      return true;
    }
    return false;
  }
  // Preserve the active session over transport reconnects and resets. Clearing it here
  // could turn a held tag into a second arrival without a verified absence interval.
  resetPatients() {
    if (this.active) this.active.patientId = null;
    this.saveSession();
    this.onChange();
  }
}

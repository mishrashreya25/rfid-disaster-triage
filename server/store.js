import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { samplePatients } from './patients.js';

// Preserve existing arrivals and scan history while giving every record a neutral ID.
export function migrateLegacyPatientIds(db) {
  db.transaction(() => {
    for (let i = 1; i <= 15; i++) {
      const suffix = String(i).padStart(3, '0');
      const before = `DEMO-${suffix}`, after = `PAT-${suffix}`;
      db.prepare('UPDATE registrations SET id = ? WHERE id = ?').run(after, before);
      db.prepare('UPDATE events SET patientId = ? WHERE patientId = ?').run(after, before);
      db.prepare('UPDATE events SET message = replace(message, ?, ?) WHERE instr(message, ?) > 0').run(before, after, before);
    }
    for (const setting of db.prepare("SELECT key,value FROM settings WHERE key LIKE 'activeSession%'").all()) {
      try {
        const session = JSON.parse(setting.value);
        if (session?.patientId?.startsWith('DEMO-')) {
          session.patientId = session.patientId.replace('DEMO-', 'PAT-');
          db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(session), setting.key);
        }
      } catch { /* Invalid legacy session values are ignored by session restoration. */ }
    }
    db.prepare("UPDATE events SET type = 'patient_reset', message = 'Patient registrations and related scan events cleared by operator.' WHERE type = 'demo_reset'").run();
    db.prepare("UPDATE events SET message = 'All available patient profiles were registered. Reset patient data to start a new intake.' WHERE type = 'dataset_exhausted' AND source = 'hardware' AND message LIKE '%demo%'").run();
  })();
}

function migrateLegacyPatientNames(db) {
  const oldLabels = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar'];
  db.transaction(() => {
    const rename = db.prepare('UPDATE registrations SET name = ? WHERE id = ? AND name = ?');
    const renameEvents = db.prepare('UPDATE events SET message = replace(message, ?, ?) WHERE patientId = ? AND instr(message, ?) > 0');
    for (const [index, label] of oldLabels.entries()) {
      const id = `PAT-${String(index + 1).padStart(3, '0')}`;
      const profile = samplePatients.find(patient => patient.id === id);
      if (!profile) continue;
      const oldName = `Patient ${label}`;
      rename.run(profile.name, id, oldName);
      renameEvents.run(oldName, profile.name, id, oldName);
    }
  })();
}

export function createStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS registrations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL,
      injury TEXT NOT NULL, triage TEXT NOT NULL CHECK(triage IN ('RED','YELLOW','GREEN','BLACK')),
      uid TEXT NOT NULL, arrivedAt TEXT NOT NULL, lastSeenAt TEXT NOT NULL,
      rawScans INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL CHECK(source IN ('hardware','demo')),
      status TEXT NOT NULL DEFAULT 'Awaiting triage'
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
      message TEXT NOT NULL, source TEXT NOT NULL,
      timestamp TEXT NOT NULL, patientId TEXT, uid TEXT,
      demoRelated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_timestamp ON events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS events_meaningful ON events(id DESC) WHERE type != 'repeat_read';
  `);
  migrateLegacyPatientIds(db);
  migrateLegacyPatientNames(db);
  const insertEvent = db.prepare(`INSERT INTO events
    (type,message,source,timestamp,patientId,uid,demoRelated)
    VALUES (@type,@message,@source,@timestamp,@patientId,@uid,@demoRelated)`);
  return {
    db,
    patients: () => db.prepare('SELECT * FROM registrations ORDER BY arrivedAt DESC, id').all(),
    events: (limit = 200, includeRepeats = true) => db.prepare(`SELECT * FROM events ${includeRepeats ? '' : "WHERE type != 'repeat_read'"} ORDER BY id DESC LIMIT ?`).all(limit),
    event(event) {
      const item = { timestamp: new Date().toISOString(), patientId: null, uid: null, demoRelated: 0, ...event };
      return { ...item, id: Number(insertEvent.run(item).lastInsertRowid) };
    },
    register(patient, uid, timestamp, source) {
      db.prepare(`INSERT INTO registrations (id,name,age,injury,triage,uid,arrivedAt,lastSeenAt,source)
        VALUES (@id,@name,@age,@injury,@triage,@uid,@timestamp,@timestamp,@source)`)
        .run({ ...patient, uid, timestamp, source });
    },
    seen(id, timestamp) {
      db.prepare('UPDATE registrations SET lastSeenAt = ?, rawScans = rawScans + 1 WHERE id = ?').run(timestamp, id);
    },
    reset() {
      db.transaction(() => {
        db.prepare('DELETE FROM registrations').run();
        db.prepare('DELETE FROM events WHERE demoRelated = 1').run();
      })();
    },
    getSetting: (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value,
    setSetting(key, value) {
      db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key, String(value));
    },
    close: () => db.close(),
  };
}

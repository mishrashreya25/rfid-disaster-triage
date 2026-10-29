# Respondr — Automated RFID Patient Intake System

A working local dashboard for the **Automated RFID Patient Intake System for Disaster Triage** B.Tech project. React, Vite, TypeScript and Tailwind frontend; Express, Socket.IO, SerialPort and SQLite backend. No paid API, cloud database, browser COM access, or external font requests.

## Run on Windows

Install **Node.js 20.15 or newer** with npm. The project was verified with Node 20.15. Open PowerShell in this folder:

```powershell
cd D:\RFID
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. The API runs on **http://127.0.0.1:3001**. Keep the terminal running. Stop both processes with Ctrl+C.

For a production build, stop the development processes first, then:

```powershell
npm run build
npm start
```

Open **http://127.0.0.1:3001**; Express serves the compiled frontend and API together. Both servers bind to the local computer only. `npm install` requires internet access; normal operation after installation/build works offline.

If native dependency installation fails, use a supported Node LTS release and reinstall with `npm ci`. SerialPort and better-sqlite3 normally download prebuilt Windows binaries; building from source additionally requires Python and Visual Studio Build Tools with C++ support.

## Physical reader workflow

1. Plug the NodeMCU ESP-12E / ESP8266 and RC522 reader into USB. Keep the existing firmware that prints newline-delimited `Card UID:` messages at **115200 baud**.
2. **Close Arduino Serial Monitor, Serial Plotter, and other programs using the port.** A serial port can only have one owner. The dashboard does not close other applications for you.
3. Leave **Demo mode off**. Refresh serial ports. Actual available devices are detected on the backend; **COM25** is preferred when available, otherwise the first available port is selected. Select the correct device and click **Connect**.
4. Connecting releases DTR/RTS and performs a normal ESP8266 reset so the existing sketch starts reliably. A successful connection produces the actual **Connected** indicator. Startup messages do not register patients. View the latest raw message and received byte/line counts under **Reader settings**.
5. Present tag **`93:4E:7A:B7`**. One randomly chosen, unused fictional patient appears immediately in the table. A notification shows the ID, first-arrival time, category, and source. The registration and scan event are committed to SQLite.
6. Keep the tag near the reader. Repeated UID messages only update that session’s last-seen timestamp and raw-read count. They do not create additional arrivals, even after five seconds or much longer.
7. Remove the tag. After **two seconds without known UID reads**, the scanner rearms. Present it again to add another unused patient.
8. After all 15 patients are registered, choose **Reset patient data**, review the confirmation, and reset. Remove a currently held tag and let the active session finish before scanning again.

If COM25 is occupied, the UI reports that the port is busy/access is denied and asks you to close Arduino Serial Monitor or Serial Plotter. An unplugged device or unavailable port is reported without pretending it is connected. Refresh ports after plugging a device back in; reconnect explicitly.

### Important firmware contract

Removal is **inferred from the absence of UID messages**, not a physical presence signal. Firmware must emit the known UID periodically **while the tag remains present**, at intervals safely below the configured threshold (for example, every 200 ms). Startup chatter and unknown UID lines do not keep a known-tag session alive.

If firmware only prints once on initial detection, stops polling a halted card, or pauses for two seconds while a tag is held, software cannot distinguish that silence from removal. Adjust that firmware or increase the absence threshold. This application uses the requested absence-based state machine rather than a fixed registration cooldown.

The active hardware session is saved. USB disconnects and backend downtime **do not count as proof of tag removal**: a held tag is suppressed after reconnect, and the reader must observe a full absence interval before rearming. Hardware and simulated sessions are tracked separately and never share repeat reads.

High-rate repeated reads are written in bounded SQLite transactions, and Socket.IO publishes at most ten snapshots per second. Every raw read is counted and logged without flooding the interface.

For direct USB troubleshooting, first disconnect the dashboard from the port, then run `node scripts/serial-diagnostic.js COM25 15000 --reset`. It captures real bytes, hexadecimal input, and firmware messages for 15 seconds after a normal reset. Stop Serial Monitor before using either tool.

## Demonstrate without hardware

1. Disconnect the physical reader, then enable **Demo mode**.
2. Click **Simulate scan**. A virtual tag emits repeated valid serial-style lines for 850 ms, then is removed automatically. Wait for the absence interval before the next presentation.
3. Or choose **Hold tag** to emit a UID every 200 ms continuously. Hold for ten seconds and confirm there is still only one arrival. Click **Remove tag**, wait for rearming, then present again.
4. Every simulated registration, raw message, and scan event is labelled **DEMO**. Hardware remains disconnected. Both sources select from the same 15 sample patient profiles without duplicates.

The 15 records are defined in `server/patients.js`. **No patients are inserted at startup.** Previously saved registrations will reappear. The UID identifies the reusable physical tag; it does not identify which synthetic patient is randomly assigned to a new session. RED, YELLOW, GREEN and BLACK are supported in the interface; the 15-profile dataset includes all four categories. Categories are predetermined demonstration data, not automatic medical assessments.

## Dashboard functions

- **Overview:** unique registrations, arrivals in the last 30 minutes, awaiting-triage count, active RED-category count (discharged patients excluded), category distribution, scan state, live queue and recent activity.
- **Patient intake:** search name/ID/UID/injury, filter category or care status, view first-arrival and last-seen separately. Select a row to inspect injury, UID, raw-read count and input source, or update care status.
- **Event history:** filter by source, search events, optionally include suppressed repeat reads, and export CSV. The latest 10,000 events are loaded; the list displays the first 200 matching records. Full history remains in SQLite.
- **Reader settings:** detected port selector, connect/disconnect, absence threshold (0.5–10 seconds, initially 2), raw serial message, hardware information, confirmed dataset reset.
- **Export report:** downloads patient records with ISO timestamps, stable UID, care status, raw counts and explicit hardware/simulation source. It exports every registered patient; event CSV exports all currently matching loaded events.
- **Live notifications:** new arrivals and connection errors. Socket.IO reconnects automatically and sends a fresh SQLite snapshot to every connected client. A stale/offline dashboard is labelled accordingly.

## Local persistence

The database is created automatically at **`data/triage.sqlite`**. SQLite WAL mode is enabled. Registrations have unique patient IDs, and each arrival plus its event is committed in a transaction.

Tables:

| Table | Contents |
|---|---|
| `registrations` | Synthetic patient details, category, UID, source, first arrival, last seen, raw count and care status |
| `events` | Arrival, each repeated UID read, removal/rearm, unknown UID, connection/disconnection, errors, resets and status changes |
| `settings` | Saved absence threshold and active scan sessions per input source |

Patient IDs use `PAT-001` through `PAT-015`. Existing `DEMO-` IDs are migrated to the matching `PAT-` IDs while preserving arrivals, scan counts, event links, and active sessions.

**Reset patient data** clears the dataset’s registrations and associated events, including registrations made using real hardware. It preserves connection/system audit events and reader settings. Reset does not rearm an active held tag. This is confirmed in both the UI and API. Stop the app before copying the SQLite files for backup; WAL files may contain pending pages while it is running.

To use another database path or port:

```powershell
$env:DATABASE_PATH = 'D:\RFID\data\another-demo.sqlite'
$env:PORT = '3001'
npm start
```

Development Vite expects port 3001 by default. If changing it, set `$env:RFID_API_TARGET = 'http://127.0.0.1:YOUR_PORT'` before `npm run dev`. Persisted database files are ignored by Git.

## Verification

```powershell
npm test
npm run build
```

Automated Node tests cover strict parsing, 30 seconds of continuous reads producing one registration, rearming, exhaustion, unknown tags, held-tag reset behavior, file-backed SQLite restart persistence, reconnect suppression, fragmented serial chunks, unavailable/busy ports, HTTP endpoints, source restrictions, status updates and Socket.IO arrival delivery.

Browser tests use **Microsoft Edge**, an isolated API on port 3002 with **in-memory SQLite**, and a separate frontend on port 5174. They never clear your database or connect a real serial port:

```powershell
npm run test:e2e
```

Ensure ports 3002 and 5174 are free. Edge must be installed. You can use installed Chrome by setting `$env:PLAYWRIGHT_CHANNEL = 'chrome'`. Desktop/mobile screenshots and failure traces are saved in `artifacts/`.

The tests validate the transport with simulated USB chunks. Successful physical tag testing additionally requires an available COM port and someone presenting/removing the physical tag.

## Source layout

```text
src/App.tsx                  Dashboard, queue, events, settings and dialogs
src/styles.css               Responsive UI, Tailwind and local font definitions
src/types.ts                 Typed live-state models
server/index.js              Local entrypoint and shutdown
server/app.js                Express API, Socket.IO and demo transport
server/serial.js             SerialPort discovery, read-line parsing and errors
server/session.js            Absence-based session state machine
server/store.js              SQLite schema, transactions and local persistence
server/patients.js           Fifteen sample patient profiles and known UID
server/*.test.js             Unit and integration tests
e2e/dashboard.spec.ts        Headless desktop/mobile browser workflow
playwright.config.ts        Isolated test servers and browser configuration
scripts/e2e-server.js        In-memory test-only service
```

Implementation references: [SerialPort API](https://serialport.io/docs/api-serialport/), [SerialPort usage](https://serialport.io/docs/guide-usage/), and [Socket.IO server initialization](https://socket.io/docs/v4/server-initialization/).

import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Bell, BookOpen, Cable,
  Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleHelp,
  Clock3, Database, Filter, Fingerprint, HeartPulse, History, Info, LayoutDashboard,
  ListFilter, LoaderCircle, Menu, MoreHorizontal, Plug, Plus, Radio, RefreshCw,
  RotateCcw, ScanLine, Search, Settings2, ShieldCheck, SlidersHorizontal,
  Sparkles, Tag, TriangleAlert, Unplug, Users, Wifi, WifiOff, X, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AppState, Patient, PatientStatus, ScanEvent, SerialPortInfo, Triage } from './types';

const triageInfo: Record<Triage, { label: string; description: string; short: string }> = {
  RED: { label: 'Immediate', description: 'Critical priority', short: 'Immediate care' },
  YELLOW: { label: 'Delayed', description: 'Urgent priority', short: 'Can wait briefly' },
  GREEN: { label: 'Minor', description: 'Low priority', short: 'Walking wounded' },
  BLACK: { label: 'Expectant', description: 'Expectant category', short: 'Expectant' },
};
const categories: Triage[] = ['RED', 'YELLOW', 'GREEN', 'BLACK'];
type Page = 'overview' | 'patients' | 'events' | 'settings';
type Modal = 'reset' | 'guide' | null;
const emptyState: AppState = {
  patients: [], events: [], mode: 'hardware', serial: { phase: 'disconnected', path: null, baudRate: 115200, error: null },
  scanner: { phase: 'armed', lastSeenAt: null, patientId: null, rawScans: 0, absenceMs: 2000 },
  demoPresent: false, lastLine: null, datasetSize: 15, knownUid: '93:4E:7A:B7',
};
const time = (value: string) => new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fullDate = (value: string) => new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' });
function relative(value: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  return seconds < 10 ? 'Just now' : seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}
async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, body === undefined ? undefined : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
function downloadCSV(name: string, rows: unknown[][]) {
  const csv = '\uFEFF' + rows.map(row => row.map(value => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
function Badge({ triage, long = false }: { triage: Triage; long?: boolean }) {
  return <span className={`triage-badge ${triage.toLowerCase()}`}><span className="dot" />{long ? triageInfo[triage].label : triage}<span className="sr-only"> priority</span></span>;
}
function Logo({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'small' : ''}`}><div className="brand-mark"><Plus strokeWidth={3.4} /></div>{!small && <span>respondr<span className="brand-period">.</span></span>}</div>;
}

export default function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [online, setOnline] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState<Page>('overview');
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [arrival, setArrival] = useState<Patient | null>(null);
  const [now, setNow] = useState(Date.now());
  const [query, setQuery] = useState('');
  const [triage, setTriage] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [showFilters, setShowFilters] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [eventQuery, setEventQuery] = useState('');
  const [eventSource, setEventSource] = useState('all');
  const [allEvents, setAllEvents] = useState<ScanEvent[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [absence, setAbsence] = useState('2');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arrivalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDemo = state.mode === 'demo';
  const connected = state.serial.phase === 'connected' && online;
  const readerOpen = Boolean(state.serial.open || connected);
  const exhausted = state.patients.length >= state.datasetSize;
  const navigate = (next: Page) => { setPage(next); setMobileNav(false); setQuery(''); setTriage('ALL'); setStatusFilter('ALL'); };

  useEffect(() => {
    const socket = io({ reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
    socket.on('connect', () => { setOnline(true); setError(null); });
    socket.on('disconnect', () => setOnline(false));
    socket.on('connect_error', () => { setOnline(false); setLoaded(true); });
    socket.on('state', (next: AppState) => { setState(next); setLoaded(true); });
    socket.on('arrival', (next: Patient) => {
      setArrival(next);
      if (arrivalTimer.current) clearTimeout(arrivalTimer.current);
      arrivalTimer.current = setTimeout(() => setArrival(null), 8000);
    });
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => { socket.disconnect(); clearInterval(interval); if (arrivalTimer.current) clearTimeout(arrivalTimer.current); };
  }, []);
  useEffect(() => { setAbsence(String(state.scanner.absenceMs / 1000)); }, [state.scanner.absenceMs]);
  useEffect(() => {
    if (!modal && !patient) return;
    const previous = document.activeElement as HTMLElement | null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])];
    focusable()[0]?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setModal(null); setPatient(null); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handle);
    return () => { document.body.style.overflow = priorOverflow; document.removeEventListener('keydown', handle); if (previous?.isConnected) previous.focus(); };
  }, [modal, patient]);
  const notify = (message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  };
  const refreshPorts = useCallback(async () => {
    setRefreshing(true);
    try {
      const { ports: available } = await api<{ ports: SerialPortInfo[] }>('/ports');
      setPorts(available);
      setSelectedPort(current => available.some(p => p.path === current) ? current : (available.find(p => p.path.toUpperCase() === 'COM25')?.path || available[0]?.path || ''));
    } catch (e) { setError((e as Error).message); }
    finally { setRefreshing(false); }
  }, []);
  useEffect(() => { if (online) void refreshPorts(); }, [online, refreshPorts]);
  useEffect(() => {
    if (page !== 'events' || !online) return;
    void api<{ events: ScanEvent[] }>('/events?limit=10000').then(r => setAllEvents(r.events)).catch(e => setError(e.message));
  }, [page, online, state.events[0]?.id, showRaw, showRaw ? state.scanner.rawScans : 0]);
  const action = async (key: string, path: string, body: unknown, success?: string, method?: string) => {
    setBusy(key); setError(null);
    try { const next = await api<AppState>(path, body, method); setState(next); if (success) notify(success); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(null); }
  };
  const exportPatients = () => {
    downloadCSV(`respondr-intake-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Patient ID', 'Name', 'Age', 'Injury', 'Triage', 'Status', 'RFID UID', 'First arrival (ISO)', 'Last seen (ISO)', 'Raw reads', 'Source'],
      ...state.patients.map(p => [p.id, p.name, p.age, p.injury, p.triage, p.status, p.uid, p.arrivedAt, p.lastSeenAt, p.rawScans, p.source === 'demo' ? 'DEMO SIMULATION' : 'HARDWARE']),
    ]); notify('Patient intake exported as CSV.');
  };
  const counts = Object.fromEntries(categories.map(c => [c, state.patients.filter(p => p.triage === c).length])) as Record<Triage, number>;
  const awaiting = state.patients.filter(p => p.status === 'Awaiting triage').length;
  const recent = state.patients.filter(p => now - Date.parse(p.arrivedAt) < 30 * 60 * 1000).length;
  const critical = state.patients.filter(p => p.triage === 'RED' && p.status !== 'Discharged').length;
  const filtered = state.patients.filter(p =>
    `${p.name} ${p.id} ${p.uid} ${p.injury}`.toLowerCase().includes(query.toLowerCase()) &&
    (triage === 'ALL' || p.triage === triage) && (statusFilter === 'ALL' || p.status === statusFilter));
  const feedEvents = state.events.filter(e => e.type !== 'repeat_read').slice(0, 5);
  const historyEvents = allEvents.filter(e => (showRaw || e.type !== 'repeat_read') && (eventSource === 'all' || e.source === eventSource) &&
    `${e.message} ${e.patientId || ''} ${e.uid || ''}`.toLowerCase().includes(eventQuery.toLowerCase()));
  const currentPatient = patient ? state.patients.find(p => p.id === patient.id) : undefined;
  const pageTitle = { overview: 'NIT J', patients: 'Patient intake', events: 'Event history', settings: 'Reader settings' }[page];

  function renderPortControls({ expanded = false }: { expanded?: boolean }) {
    return <div className={`port-controls ${expanded ? 'expanded' : ''}`}>
      <div className="port-select-wrap"><Cable size={15} /><select aria-label="Serial port" value={selectedPort} onChange={e => setSelectedPort(e.target.value)} disabled={readerOpen || isDemo || !!busy}>
        {!ports.length && <option value="">No ports detected</option>}
        {ports.map(p => <option key={p.path} value={p.path}>{p.path}{expanded ? ` · ${p.manufacturer}` : ''}</option>)}
      </select><ChevronDown size={12} /></div>
      <button className="icon-button port-refresh" title="Refresh serial ports" aria-label="Refresh serial ports" onClick={() => void refreshPorts()} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'spin' : ''} /></button>
      <button className={`button ${readerOpen ? 'button-light' : 'button-primary'} connection-button`} disabled={!online || !!busy || isDemo || (!selectedPort && !readerOpen)} onClick={() => void action('connect', readerOpen ? '/disconnect' : '/connect', readerOpen ? {} : { path: selectedPort })}>
        {busy === 'connect' ? <LoaderCircle size={14} className="spin" /> : readerOpen ? <Unplug size={14} /> : <Plug size={14} />}{state.serial.phase === 'connecting' ? 'Connecting…' : readerOpen ? 'Disconnect' : 'Connect'}
      </button>
    </div>;
  }

  function renderEventRow({ event, compact = false }: { event: ScanEvent; compact?: boolean }) {
    const Icon = event.type === 'arrival' ? Users : event.type === 'rearmed' ? ScanLine : event.type.includes('error') || event.type === 'unknown_uid' ? TriangleAlert : event.type === 'connected' ? Wifi : event.type === 'repeat_read' ? Fingerprint : Activity;
    return <div key={event.id} className={`event-row ${compact ? 'compact' : ''}`}>
      <div className={`event-symbol ${event.type === 'arrival' || event.type === 'connected' ? 'success' : event.type.includes('error') ? 'warning' : ''}`}><Icon size={15} /></div>
      <div className="event-body"><div className="event-heading"><strong>{({ arrival: 'Patient registered', rearmed: 'Ready for next scan', server_started: 'System ready', mode_changed: 'Mode updated', connected: 'Reader connected', disconnected: 'Reader disconnected', repeat_read: 'Duplicate suppressed', dataset_exhausted: 'All patients registered', serial_error: 'Connection issue', patient_reset: 'Patient data reset', demo_reset: 'Patient data reset', unknown_uid: 'Unknown RFID tag', status_changed: 'Patient status updated', settings_changed: 'Settings updated' } as Record<string, string>)[event.type] || 'System event'}{event.source === 'demo' && <span className="demo-label">DEMO</span>}</strong><time title={fullDate(event.timestamp)}>{compact ? relative(event.timestamp, now) : time(event.timestamp)}</time></div>
        <p>{event.message}</p>{!compact && <div className="event-meta"><span>{new Date(event.timestamp).toLocaleDateString('en-IN')}</span><span>{event.patientId || 'System'}</span>{event.uid && <code>{event.uid}</code>}<span className="source-chip">{event.source === 'hardware' ? 'Hardware' : event.source === 'demo' ? 'Simulation' : 'System'}</span></div>}
      </div>
    </div>;
  }

  function renderPatientTable({ full = false }: { full?: boolean }) {
    return <section className={`panel intake-panel ${full ? 'full-intake' : ''}`}>
      <div className="panel-heading intake-heading"><div><div className="heading-with-count"><h2>Live patient intake</h2><span className="count-label">{state.patients.length}</span><span className="live-tag"><span className="dot" />LIVE</span></div><p>Every arrival, accounted for.</p></div><button className="text-button" onClick={exportPatients} disabled={!online}><ArrowDownToLine size={14} /><span>Export</span></button></div>
      <div className="table-toolbar"><div className="search-field"><Search size={16} /><input aria-label="Search patients" placeholder="Search by name, patient ID or RFID…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}><X size={13} /></button>}</div>
        <div className="filter-select"><ListFilter size={14} /><select aria-label="Filter triage priority" value={triage} onChange={e => setTriage(e.target.value)}><option value="ALL">All priorities</option>{categories.map(c => <option key={c} value={c}>{c} · {triageInfo[c].label}</option>)}</select><ChevronDown size={12} /></div>
        <button className={`button button-light filter-button ${showFilters ? 'selected' : ''}`} onClick={() => setShowFilters(!showFilters)}><SlidersHorizontal size={14} />Filters{statusFilter !== 'ALL' && <span className="filter-dot" />}</button>
      </div>
      {showFilters && <div className="extra-filters"><span>Patient status</span><select aria-label="Filter patient status" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="ALL">All statuses</option><option>Awaiting triage</option><option>In treatment</option><option>Discharged</option></select><button className="text-button" onClick={() => { setStatusFilter('ALL'); setTriage('ALL'); setQuery(''); }}>Clear filters</button></div>}
      <div className="table-scroll"><table><thead><tr><th>Patient details</th><th>Triage priority</th><th>First arrival</th><th>Last seen</th><th>Status</th><th className="table-end"><span className="sr-only">View details</span></th></tr></thead><tbody>
        {filtered.map(p => <tr key={p.id} onClick={() => setPatient(p)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setPatient(p); }} aria-label={`View ${p.name}`}>
          <td><div className="patient-cell"><div className={`patient-avatar ${p.triage.toLowerCase()}`}>{p.name.split(' ').at(-1)?.slice(0, 1)}</div><div><strong>{p.name}<span className="patient-age">{p.age} yrs</span></strong><span className="patient-id">{p.id}{p.source === 'demo' && <span className="demo-label">DEMO</span>}</span></div></div></td>
          <td><Badge triage={p.triage} /></td><td><span className="time-cell">{time(p.arrivedAt)}</span><span className="cell-sub">{new Date(p.arrivedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span></td>
          <td><span className="time-cell">{time(p.lastSeenAt)}</span><span className="cell-sub">{p.rawScans} raw read{p.rawScans !== 1 ? 's' : ''}</span></td><td><span className={`status-text ${p.status === 'Discharged' ? 'discharged' : ''}`}><span className="dot" />{p.status}</span></td><td><ChevronRight size={15} /></td>
        </tr>)}
      </tbody></table></div>
      {!filtered.length && <div className="table-empty"><div className="empty-illustration"><Users size={28} strokeWidth={1.3} /><span><Plus size={11} /></span></div><h3>{state.patients.length ? 'No matching patients' : 'Ready for the first arrival'}</h3><p>{state.patients.length ? 'Try another search or clear your priority and status filters.' : 'Scan an RFID tag to register a patient. Their details will appear here in real time.'}</p>{!state.patients.length && <span className="empty-hint"><ShieldCheck size={13} />No preloaded arrivals. Every record starts with a scan.</span>}</div>}
      <div className="table-footer"><span>Showing <strong>{filtered.length ? '1' : '0'}–{filtered.length}</strong> of <strong>{filtered.length}</strong> patients</span><div><span>Rows per page <strong>15</strong></span><button aria-label="Previous page" className="icon-button" disabled><ChevronLeft size={14} /></button><button className="page-number" disabled>1</button><button aria-label="Next page" className="icon-button" disabled><ChevronRight size={14} /></button></div></div>
    </section>;
  }

  return <div className="app-shell">
    {mobileNav && <div className="sidebar-scrim" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <Logo /><div className="workspace-switch"><div className="workspace-icon"><HeartPulse size={18} /></div><div><strong>Disaster response</strong><span>Command center</span></div><ChevronDown size={13} /></div>
      <div className="nav-label">WORKSPACE</div><nav aria-label="Main navigation">{([
        ['overview', LayoutDashboard, 'Overview'], ['patients', Users, 'Patient intake'], ['events', History, 'Event history'], ['settings', Settings2, 'Reader settings'],
      ] as [Page, LucideIcon, string][]).map(([id, Icon, label]) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => navigate(id)}><Icon size={18} /><span>{label}</span>{id === 'patients' && <span className="nav-count">{state.patients.length}</span>}{id === 'overview' && <span className="nav-active-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="local-card"><div className="local-card-icon"><ShieldCheck size={17} /><span className="dot" /></div><strong>Local. Secure. Ready.</strong><p>Your data stays on this device.<br />Built for when it matters.</p><span><Database size={12} />SQLite storage</span></div><button className="nav-item help-link" onClick={() => setModal('guide')}><CircleHelp size={18} />Help & documentation<ArrowUpRight size={13} /></button><div className="profile"><div className="profile-avatar">OP</div><div><strong>Response operator</strong><span>Local workspace</span></div><span className="operator-dot" /></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={20} /></button><span className="product-title">Automated RFID Patient Intake System</span><ChevronRight size={13} /><strong>{page === 'overview' ? 'Overview' : pageTitle}</strong></div><div className="topbar-right"><span className={`backend-status ${online ? 'online' : ''}`}><span className="dot" />{online ? 'System operational' : loaded ? 'Backend offline' : 'Connecting to service'}</span><span className="topbar-divider" /><button className={`icon-button notification-button ${showNotifications ? 'selected' : ''}`} aria-label="Show notifications" onClick={() => setShowNotifications(!showNotifications)}><Bell size={18} />{state.events.some(e => e.type === 'arrival') && <span />}</button><button className="top-avatar" title="Response operator · local workspace" onClick={() => setModal('guide')}>OP</button></div>
        {showNotifications && <div className="notification-popover"><div className="popover-heading"><strong>Notifications</strong><button className="icon-button" aria-label="Close notifications" onClick={() => setShowNotifications(false)}><X size={15} /></button></div>{state.events.filter(e => e.type === 'arrival' || e.type === 'serial_error').slice(0, 4).map(e => renderEventRow({ event: e, compact: true }))}{!state.events.some(e => e.type === 'arrival' || e.type === 'serial_error') && <p className="popover-empty">You’re all caught up. New arrivals and connection alerts will appear here.</p>}</div>}
      </header>
      <main>
        <div className="page-heading"><div><div className="eyebrow"><span className="dot" />REAL-TIME RESPONSE, COORDINATED.</div><h1>{pageTitle}<span className="heading-dot">.</span></h1><p>{page === 'overview' ? 'A clear view of every arrival. A faster path to care.' : page === 'patients' ? 'One live queue. Every patient, every arrival.' : page === 'events' ? 'A complete record of scans, sessions, and connections.' : 'Connect your hardware and configure scan sessions.'}</p></div><div className="page-heading-actions"><div className="date-chip"><Clock3 size={14} />{new Date(now).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}<span>•</span>{new Date(now).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}</div><button className="button button-light export-button" onClick={exportPatients} disabled={!online}><ArrowDownToLine size={15} />Export report</button></div></div>
        {!online && loaded && <div className="alert warning-alert" role="alert"><WifiOff size={17} /><div><strong>Local service is unavailable.</strong> Start the backend with <code>npm run dev</code>. The dashboard will reconnect automatically. Displayed records may be out of date.</div></div>}
        {error && <div className="alert error-alert" role="alert"><TriangleAlert size={18} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError(null)}><X size={15} /></button></div>}
        {state.serial.error && state.serial.error !== error && <div className="alert error-alert" role="alert"><Unplug size={17} /><span>{state.serial.error}</span></div>}

        <section className="connection-bar"><div className="connection-bar-title"><div className={`connection-icon ${connected || isDemo ? 'enabled' : ''}`}><Radio size={18} /></div><div><strong>RFID reader <span className={`connection-badge ${connected ? 'connected' : isDemo ? 'demo' : ''}`}><span className="dot" />{isDemo ? 'Demo mode' : connected ? 'Connected' : state.serial.phase === 'connecting' ? 'Connecting' : 'Disconnected'}</span></strong><span className="connection-description">{isDemo ? 'Simulated input · no hardware reads' : connected ? `${state.serial.path} · ESP8266 / RC522 · 115200 baud` : 'Connect your reader to start live intake'}</span></div></div><div className="connection-bar-actions">{renderPortControls({})}<div className="control-divider" /><label className="demo-toggle"><Sparkles size={14} /><span>Demo mode</span><input type="checkbox" checked={isDemo} disabled={!online || !!busy || readerOpen || state.serial.phase === 'connecting'} onChange={e => void action('mode', '/mode', { mode: e.target.checked ? 'demo' : 'hardware' })} /><span className="toggle-track"><span /></span></label></div></section>

        {exhausted && <div className="alert complete-alert"><CheckCheck size={19} /><div><strong>All {state.datasetSize} patient profiles are registered.</strong> Reset patient data to start a new intake.</div><button className="button button-light" onClick={() => setModal('reset')}><RotateCcw size={14} />Reset patient data</button></div>}

        {page === 'overview' && <>
          <div className="stats-grid">{([
            { label: 'Total registered', value: state.patients.length, Icon: Users, style: 'green', detail: `of ${state.datasetSize} patient profiles`, foot: 'Unique patient arrivals', footIcon: Fingerprint },
            { label: 'New arrivals', value: recent, Icon: ArrowDownToLine, style: 'blue', detail: 'in the last 30 minutes', foot: 'Updated with every scan', footIcon: Activity },
            { label: 'Awaiting triage', value: awaiting, Icon: Clock3, style: 'amber', detail: 'patients in the queue', foot: 'Ready for assessment', footIcon: ListFilter },
            { label: 'Critical priority', value: critical, Icon: HeartPulse, style: 'red', detail: 'red-category patients', foot: 'Immediate attention', footIcon: Zap },
          ]).map(({ label, value, Icon, style, detail, foot, footIcon: FootIcon }) => <section className={`stat-card ${style}`} key={label}><div className="stat-top"><span>{label}</span><div className="stat-icon"><Icon size={18} /></div></div><div className="stat-value">{value.toString().padStart(2, '0')}<span>{detail}</span></div><div className="stat-footer"><FootIcon size={12} />{foot}{value > 0 && label === 'New arrivals' && <span className="stat-live">LIVE</span>}</div></section>)}</div>
          <div className="middle-grid">
            <section className="panel distribution-panel"><div className="panel-heading"><div><h2>Triage distribution<span className="info-tooltip" title="Categories come from the configured patient profiles; no automated clinical assessment."><Info size={14} /></span></h2><p>Priority at a glance. Care where it’s needed.</p></div><span className="subtle-tag">{state.patients.length} patients</span></div><div className={`distribution-bar ${!state.patients.length ? 'empty' : ''}`} aria-label="Triage category distribution">{state.patients.length ? categories.filter(c => counts[c]).map(c => <div key={c} className={c.toLowerCase()} style={{ flex: counts[c] }} title={`${triageInfo[c].label}: ${counts[c]}`}>{counts[c]}</div>) : <><span /><span /><span /><span /></>}</div><div className="priority-grid">{categories.map(c => <button className={`priority-item ${c.toLowerCase()}`} key={c} onClick={() => { navigate('patients'); setTriage(c); }}><div><span className="dot" /><span>{triageInfo[c].label}</span><ArrowUpRight size={12} /></div><strong>{counts[c].toString().padStart(2, '0')}</strong><span>{triageInfo[c].short}</span></button>)}</div><div className="distribution-note"><Info size={13} /><span>Categories are assigned from patient profiles.</span><span className="legend-note">Not a clinical assessment</span></div></section>
            <section className={`scanner-card ${isDemo ? 'demo' : ''} ${state.scanner.phase === 'present' ? 'scanning' : ''}`}><div className="scanner-card-heading"><span><ScanLine size={16} />LIVE SCANNER</span><span className="scanner-source"><span className="dot" />{isDemo ? 'DEMO' : connected ? 'HARDWARE' : 'OFFLINE'}</span></div><div className="scanner-main"><div className="scanner-graphic"><div className="scan-orbit orbit-one" /><div className="scan-orbit orbit-two" /><div className="scan-corners" /><Fingerprint size={43} strokeWidth={1.1} /><div className="scan-line" /><span className="scan-check">{state.scanner.phase === 'present' ? <Check size={10} /> : <Radio size={10} />}</span></div><div className="scanner-copy"><h2>{!online ? 'Service offline' : !isDemo && !connected ? 'Waiting for reader' : state.scanner.phase === 'present' ? 'Tag detected' : exhausted ? 'All patients registered' : isDemo || connected ? 'Ready for a scan' : 'Waiting for reader'}</h2><p>{state.scanner.phase === 'present' ? `Session active · ${state.scanner.rawScans} reads, one arrival` : isDemo ? 'Simulate a tag to register a patient.' : connected ? 'Present the RFID tag near your reader.' : 'Connect via USB to start intake.'}</p><span className="scanner-uid"><Tag size={11} />{state.knownUid}</span></div></div>{isDemo ? <div className="scanner-demo-actions"><button disabled={!online || !!busy || state.scanner.phase === 'present' || exhausted} onClick={() => void action('scan', '/demo/scan', {})}><ScanLine size={14} />Simulate scan<ArrowRight size={14} /></button><button className="hold-button" disabled={!online || !!busy || (!state.demoPresent && (state.scanner.phase === 'present' || exhausted))} onClick={() => void action('hold', state.demoPresent ? '/demo/remove' : '/demo/scan', state.demoPresent ? {} : { hold: true })}>{state.demoPresent ? 'Remove tag' : 'Hold tag'}</button></div> : <div className="scanner-bottom"><span className="scanner-dot" />{connected ? `Listening · ${state.serial.receivedBytes || 0} bytes / ${state.serial.receivedLines || 0} lines` : 'No active serial connection'}<span>115200 baud</span></div>}</section>
          </div>
          <div className="bottom-grid">{renderPatientTable({})}<section className="panel recent-panel"><div className="panel-heading"><div><h2>Recent activity<span className="live-dot" /></h2><p>Your live intake timeline.</p></div><button className="icon-button" title="Open full event history" aria-label="Open full event history" onClick={() => navigate('events')}><MoreHorizontal size={18} /></button></div><div className="recent-feed">{feedEvents.map(e => renderEventRow({ event: e, compact: true }))}{!feedEvents.length && <div className="feed-empty"><Activity size={24} /><p>Listening for system events…</p></div>}</div><button className="view-events" onClick={() => navigate('events')}>View all activity<ArrowRight size={14} /></button></section></div>
          <section className="workflow-strip"><div className="workflow-title"><div><Zap size={17} /></div><span>From scan to care<strong>A simpler intake workflow.</strong></span></div><div className="workflow-steps"><span><span className="step-number">1</span>Scan RFID tag</span><ChevronRight size={13} /><span><span className="step-number">2</span>Register patient</span><ChevronRight size={13} /><span><span className="step-number">3</span>Coordinate care</span></div><button className="text-button" onClick={() => setModal('guide')}>How it works<ArrowUpRight size={13} /></button></section>
        </>}

        {page === 'patients' && <><div className="page-info-bar"><Users size={18} /><span><strong>{state.patients.length}</strong> registered <span>·</span> <strong>{awaiting}</strong> awaiting triage <span>·</span> <strong>{critical}</strong> critical priority</span><span className="synthetic-label">RFID PATIENT INTAKE</span></div>{renderPatientTable({ full: true })}<div className="patient-page-note"><Info size={15} />Each new scan session registers an available patient profile. Select a patient to view their record and update care status.</div></>}

        {page === 'events' && <section className="panel history-panel"><div className="panel-heading"><div><h2>Scan & connection log<span className="count-label">{historyEvents.length}</span></h2><p>Saved locally in SQLite. All times are shown in your local timezone.</p></div><button className="button button-light" onClick={() => { downloadCSV('respondr-event-history.csv', [['ID', 'Time (ISO)', 'Type', 'Source', 'Patient', 'UID', 'Message'], ...historyEvents.map(e => [e.id, e.timestamp, e.type, e.source, e.patientId, e.uid, e.message])]); notify('Event history exported.'); }}><ArrowDownToLine size={14} />Export events</button></div><div className="table-toolbar"><div className="search-field"><Search size={16} /><input placeholder="Search events, patient IDs or RFID…" aria-label="Search event history" value={eventQuery} onChange={e => setEventQuery(e.target.value)} /></div><div className="filter-select"><Filter size={14} /><select aria-label="Filter event source" value={eventSource} onChange={e => setEventSource(e.target.value)}><option value="all">All sources</option><option value="hardware">Hardware</option><option value="demo">Demo simulation</option><option value="system">System</option></select><ChevronDown size={12} /></div><label className="raw-toggle"><input type="checkbox" checked={showRaw} onChange={e => setShowRaw(e.target.checked)} />Include repeat reads</label></div><div className="history-list">{historyEvents.slice(0, 200).map(e => renderEventRow({ event: e }))}{!historyEvents.length && <div className="table-empty"><History size={28} /><h3>No events to show</h3><p>Adjust your search or scan a tag to start the timeline.</p></div>}</div><div className="history-footer"><ShieldCheck size={14} />Connection events are retained when patient registrations are reset.<span>Showing {Math.min(200, historyEvents.length)} of {historyEvents.length} matching loaded events · latest 10,000 loaded</span></div></section>}

        {page === 'settings' && <div className="settings-grid"><div><section className="panel settings-panel"><div className="panel-heading"><div><h2><Cable size={17} />Serial connection</h2><p>USB communication with your ESP8266 and RC522 reader.</p></div><span className={`connection-badge ${connected ? 'connected' : ''}`}><span className="dot" />{connected ? 'Connected' : 'Disconnected'}</span></div><div className="settings-body"><label className="field-label">Available serial port</label>{renderPortControls({ expanded: true })}<button className="text-button port-help" onClick={() => void refreshPorts()}><RefreshCw size={13} />Refresh available USB devices</button><div className="settings-specs"><div><span>Baud rate</span><strong>115200</strong></div><div><span>Controller</span><strong>NodeMCU ESP-12E</strong></div><div><span>RFID module</span><strong>RC522</strong></div></div><div className="settings-info"><Info size={15} /><p>COM25 is selected automatically when available. Close Arduino Serial Monitor and Serial Plotter before connecting; only one program can use a serial port at a time.</p></div></div></section><section className="panel settings-panel"><div className="panel-heading"><div><h2><ScanLine size={17} />Scan session detection</h2><p>Prevent repeated reads from creating duplicate arrivals.</p></div></div><div className="settings-body"><label className="field-label" htmlFor="absence">Tag absence threshold</label><div className="absence-control"><input id="absence" type="number" min="0.5" max="10" step="0.1" value={absence} onChange={e => setAbsence(e.target.value)} /><span>seconds without a valid UID read</span></div><p className="field-description">The scanner rearms only after this interval without a known tag read. Continuous reads always remain in the same session.</p><button className="button button-primary" disabled={!online || !!busy || state.scanner.phase === 'present'} onClick={() => void action('settings', '/settings', { absenceMs: Math.round(Number(absence) * 1000) }, 'Scanner settings saved.')}><Check size={14} />Save settings</button></div></section><section className="panel settings-panel reset-settings"><div><h2>Reset patient data</h2><p>Clear the patient pool’s registrations and related scan events. Connection history and reader settings are retained.</p></div><button className="button button-danger-light" disabled={!online || !!busy} onClick={() => setModal('reset')}><RotateCcw size={14} />Reset patient data</button></section></div><div><section className="panel hardware-panel"><div className="panel-heading"><h2>Hardware at a glance</h2><Radio size={18} /></div><div className="hardware-visual"><div className="chip"><span>ESP8266</span><Wifi size={27} /><small>NodeMCU ESP-12E</small>{Array.from({ length: 8 }, (_, i) => <i key={i} style={{ top: 16 + i * 12 }} />)}</div><span className="wire" /><div className="rfid-board"><Radio size={27} /><strong>RC522</strong><span>13.56 MHz</span></div></div><dl className="hardware-details"><div><dt>Transport</dt><dd>USB serial</dd></div><div><dt>Read format</dt><dd>Newline-delimited</dd></div><div><dt>Registered tag</dt><dd><code>{state.knownUid}</code></dd></div><div><dt>Persistence</dt><dd><span className="dot" />Local SQLite</dd></div><div><dt>Patient records</dt><dd>{state.datasetSize} patient profiles</dd></div></dl></section><section className="panel terminal-panel"><div className="panel-heading"><h2>Latest serial message</h2><span className="demo-label">{state.lastLine?.source === 'demo' ? 'DEMO' : 'RAW INPUT'}</span></div><div className="terminal-content"><span>›</span><code>{state.lastLine?.text || 'Waiting for serial input…'}</code></div><p>{state.lastLine ? fullDate(state.lastLine.timestamp) : 'Non-UID startup lines are shown here but never register a patient.'}{connected && ` ? ${state.serial.receivedBytes || 0} bytes received / ${state.serial.receivedLines || 0} complete lines`}</p></section></div></div>}

        <footer className="main-footer"><span><span className={`dot ${online ? 'online-dot' : ''}`} />Automated RFID Patient Intake System<span className="footer-separator">/</span>Disaster Triage</span><span><ShieldCheck size={12} />Local storage · SQLite<span className="footer-version">v1.0</span></span></footer>
      </main>
    </div>

    {arrival && <div className="arrival-toast" role="status"><div className={`arrival-icon ${arrival.triage.toLowerCase()}`}><Check size={20} /></div><div><strong>New patient registered{arrival.source === 'demo' && <span className="demo-label">DEMO</span>}</strong><p>{arrival.name} <span>· {arrival.id}</span></p><span>{time(arrival.arrivedAt)}<Badge triage={arrival.triage} /></span></div><button className="icon-button" aria-label="Dismiss arrival notification" onClick={() => setArrival(null)}><X size={15} /></button></div>}
    {notice && <div className="notice-toast" role="status"><CheckCheck size={17} />{notice}<button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice(null)}><X size={14} /></button></div>}

    {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><section className={`modal ${modal === 'guide' ? 'guide-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label="Close dialog" onClick={() => setModal(null)}><X size={20} /></button>{modal === 'reset' ? <><div className="modal-symbol"><RotateCcw size={24} /></div><h2 id="modal-title">Start a new intake?</h2><p>This will permanently clear all <strong>{state.patients.length} patient registrations</strong> and their scan history from local SQLite. Connection events and reader settings will be retained.</p><div className="reset-note"><Info size={16} />Remove the RFID tag before starting the next intake. An active session must finish before a new arrival can be registered.</div><div className="modal-actions"><button className="button button-light" onClick={() => setModal(null)}>Cancel</button><button className="button button-danger" disabled={!!busy || !online} onClick={async () => { if (await action('reset', '/reset', { confirm: 'RESET PATIENT DATA' }, 'Patient data cleared. Ready for the next intake.')) { setModal(null); setPatient(null); setArrival(null); } }}>{busy === 'reset' ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}Reset patient data</button></div></> : <><div className="guide-eyebrow"><BookOpen size={16} />OPERATOR’S GUIDE</div><h2 id="modal-title">Every scan starts a new arrival.</h2><p>Automated RFID Patient Intake System for Disaster Triage — a B.Tech project with 15 patient profiles.</p><div className="guide-steps"><div><span>01</span><section><h3>Connect your reader</h3><p>Plug the NodeMCU into USB, close Arduino Serial Monitor, refresh the port list, and connect at 115200 baud. COM25 is preferred if detected.</p></section></div><div><span>02</span><section><h3>Present the RFID tag</h3><p>Tag <code>93:4E:7A:B7</code> starts one session. An available patient profile is selected at random and saved locally. Repeated reads update last-seen time and raw read count.</p></section></div><div><span>03</span><section><h3>Remove, wait, and present again</h3><p>Wait {state.scanner.absenceMs / 1000} seconds without UID reads to rearm. Present the tag again to add another patient. Reset patient data after all 15 profiles are registered.</p></section></div></div><div className="guide-demo"><Sparkles size={20} /><div><strong>No hardware? Try Demo mode.</strong><p>“Simulate scan” presents a virtual tag briefly. “Hold tag” produces continuous reads until you select “Remove tag.” Every simulated read is labelled DEMO.</p></div></div><div className="settings-info"><Info size={17} /><p>The RFID UID identifies the physical tag, not the assigned patient profile. Triage categories are predetermined test data; the system does not assess real patients.</p></div><div className="modal-actions"><button className="button button-primary" onClick={() => setModal(null)}>Got it<Check size={14} /></button></div></>}</section></div>}

    {patient && <div className="modal-backdrop drawer-backdrop" onClick={() => setPatient(null)}><section className="patient-drawer" role="dialog" aria-modal="true" aria-labelledby="patient-title" onClick={e => e.stopPropagation()}><div className="drawer-header"><span>PATIENT RECORD</span><button className="icon-button" aria-label="Close patient details" onClick={() => setPatient(null)}><X size={20} /></button></div>{currentPatient ? <><div className={`drawer-avatar ${currentPatient.triage.toLowerCase()}`}>{currentPatient.name.split(' ').at(-1)?.slice(0, 1)}</div><h2 id="patient-title">{currentPatient.name}</h2><p className="drawer-patient-id">{currentPatient.id} · {currentPatient.age} years old</p><div className="drawer-badges"><Badge triage={currentPatient.triage} />{currentPatient.source === 'demo' && <span className="demo-label">DEMO SIMULATION</span>}<span className="source-chip">{currentPatient.source === 'hardware' ? 'RFID registration' : 'Simulated registration'}</span></div><div className="injury-card"><span>REPORTED INJURY</span><strong>{currentPatient.injury}</strong><p>Category: {triageInfo[currentPatient.triage].label} · assigned from the patient profile.</p></div><dl className="record-details"><div><dt><Clock3 size={15} />First arrival</dt><dd>{fullDate(currentPatient.arrivedAt)}</dd></div><div><dt><History size={15} />Last seen</dt><dd>{fullDate(currentPatient.lastSeenAt)}</dd></div><div><dt><Tag size={15} />Physical RFID UID</dt><dd><code>{currentPatient.uid}</code></dd></div><div><dt><Fingerprint size={15} />Raw scan count</dt><dd>{currentPatient.rawScans} reads</dd></div><div><dt><Radio size={15} />Input source</dt><dd>{currentPatient.source === 'demo' ? 'DEMO · Simulated serial reads' : 'Physical USB serial reader'}</dd></div></dl><div className="status-editor"><label htmlFor="care-status">Care status</label><select id="care-status" value={currentPatient.status} disabled={!!busy || !online} onChange={e => void action('status', `/patients/${currentPatient.id}`, { status: e.target.value as PatientStatus }, 'Patient care status updated.', 'PATCH')}><option>Awaiting triage</option><option>In treatment</option><option>Discharged</option></select><p>Status changes are saved in local SQLite and recorded in the event history.</p></div><div className="settings-info"><Info size={16} /><p>This patient profile was assigned to this scan session. The physical UID alone does not identify a patient.</p></div></> : <div className="table-empty"><Users size={28} /><h2 id="patient-title">Record no longer available</h2><p>The patient data may have been reset in another window.</p></div>}</section></div>}
  </div>;
}

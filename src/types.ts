export type Triage = 'RED' | 'YELLOW' | 'GREEN' | 'BLACK';
export type PatientStatus = 'Awaiting triage' | 'In treatment' | 'Discharged';
export interface Patient {
  id: string; name: string; age: number; injury: string; triage: Triage;
  uid: string; arrivedAt: string; lastSeenAt: string; rawScans: number;
  source: 'hardware' | 'demo'; status: PatientStatus;
}
export interface ScanEvent {
  id: number; type: string; message: string; source: string;
  timestamp: string; patientId: string | null; uid: string | null;
}
export interface AppState {
  patients: Patient[]; events: ScanEvent[]; mode: 'hardware' | 'demo';
  serial: { phase: 'disconnected' | 'connecting' | 'connected' | 'error'; path: string | null; baudRate: number; error: string | null; open?: boolean; receivedBytes?: number; receivedLines?: number; connectedAt?: string | null; lastReceivedAt?: string | null };
  scanner: { phase: 'armed' | 'present' | 'waiting'; lastSeenAt: string | null; patientId: string | null; rawScans: number; absenceMs: number };
  demoPresent: boolean; lastLine: { text: string; source: string; timestamp: string } | null;
  datasetSize: number; knownUid: string;
}
export interface SerialPortInfo { path: string; manufacturer: string; serialNumber: string | null }

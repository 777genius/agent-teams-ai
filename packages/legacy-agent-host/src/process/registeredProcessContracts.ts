import type { ChildProcess } from 'node:child_process';
export interface DarwinProcessIdentity {
  auditToken: readonly number[];
  sessionId: number;
  bootId: string;
  osBuild: string;
}
export interface RegistrarBinding {
  backendId: string;
  teamId: string;
  runId: string;
  memberId: string;
  generation: string;
}
/** Private original registration evidence; never an IPC/MCP-supplied token. */
export type RegisteredProcessCapture = {
  registrar: RegistrarBinding;
  target: DarwinProcessIdentity;
  root: DarwinProcessIdentity;
} & ({ version: 1 } | { version: 2; admission: 'live-ancestry-v1' });
export type ProcessObservation = 'same-live' | 'absent' | 'stale' | 'unknown';
export interface RegisteredProcessNative {
  capture(pid: number, registrar: RegistrarBinding): RegisteredProcessCapture;
  observe(capture: RegisteredProcessCapture): ProcessObservation;
  /** Synchronous; caller must persist requested before entry. Throw means requested-unknown. */
  signal(capture: RegisteredProcessCapture): 'accepted' | 'refused';
}
export type ProcessMetadataSelector = { processRef: string } | { id: string } | { pid: number };
export interface TeamProcessRow {
  id: string;
  pid: number;
  label: string;
  registeredAt: string;
  stoppedAt?: string;
  registeredBy?: string;
  port?: number;
  url?: string;
  command?: string;
  /** Stripped by explicit Desktop projection; same existing processes.json storage. */
  capturedNative?: RegisteredProcessCapture;
  capturedByCommand?: string;
}
export interface TeamProcessView extends Omit<
  TeamProcessRow,
  'capturedNative' | 'capturedByCommand'
> {
  processRef: string;
  observation: ProcessObservation | 'metadata-stopped';
  canTerminate: boolean;
  pendingStop?: { commandId: string; originalProcessRef: string; native: 'unknown' | 'accepted' };
}
export type ProcessStopState =
  | { phase: 'prepared'; native: 'not-requested' }
  | { phase: 'requested'; native: 'unknown' | 'accepted' }
  | { phase: 'completed'; native: 'not-requested' }
  | { phase: 'completed'; native: 'observed-absent'; signalAccepted: boolean | 'unknown' }
  | { phase: 'refused'; native: 'not-requested' | 'refused' };
export interface ProcessCommandReceipt {
  schemaVersion: 1;
  family: 'process';
  commandId: string;
  principalId: string;
  binding: { backendId: string; teamId: string; teamName: string };
  authorityRevision: number;
  requestDigest: string;
  fingerprint: string;
  operation: 'register' | 'metadata-stop' | 'unregister' | 'terminate';
  processRef?: string;
  /** Immutable original row/target; lookup never selects a newer PID or generation. */
  original?: TeamProcessRow;
  capture?: RegisteredProcessCapture;
  phase: 'prepared' | 'held' | 'completed' | 'rejected';
  state: ProcessStopState;
  /** Exact metadata-selected rows retained before policy write; never OS signal authority. */
  selected?: { id: string; processRef: string }[];
  result?: TeamProcessView | TeamProcessView[];
}

export interface RegisteredProcessRootSource {
  captureRoot(
    child: ChildProcess,
    current: () => boolean
  ): {
    capture(pid: number, registrar: RegistrarBinding): RegisteredProcessCapture;
  };
}

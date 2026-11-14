import type { ChildProcess } from 'node:child_process';
import type { WindowsRegisteredProcessPort, WindowsServiceCapture, WindowsServiceIntent } from '../owned-process/retainedServiceContracts.js';
export interface DarwinProcessIdentity {
  auditToken: readonly number[];
  sessionId: number;
  bootId: string;
  osBuild: string;
}
export interface LinuxProcessIdentity {
  pid: number;
  sessionId: number;
  /** Kernel pidfs inode: stable per boot; never /proc start ticks or a reusable PID. */
  pidfdId: string;
  pidNamespaceId: string;
  bootId: string;
}
export interface RegistrarBinding {
  backendId: string;
  teamId: string;
  runId: string;
  memberId: string;
  generation: string;
}
/** Private original registration evidence; never an IPC/MCP-supplied token. */
export type DarwinRegisteredProcessCapture = {
  registrar: RegistrarBinding;
  target: DarwinProcessIdentity;
  root: DarwinProcessIdentity;
} & ({ version: 1 } | { version: 2; admission: 'live-ancestry-v1' });
export interface LinuxRegisteredProcessCapture {
  version: 3;
  platform: 'linux';
  registrar: RegistrarBinding;
  root: LinuxProcessIdentity;
  target: LinuxProcessIdentity;
}
/** Warm-only identity: serialization is metadata, never authority to reopen a PID. */
export type LinuxWarmProcessIdentity = Omit<LinuxProcessIdentity, 'pidfdId'>;
export interface LinuxWarmRegisteredProcessCapture {
  version: 4;
  platform: 'linux';
  admission: 'owner-pidfd-v1';
  ownerInstance: string;
  captureKey: string;
  registrar: RegistrarBinding;
  root: LinuxWarmProcessIdentity;
  target: LinuxWarmProcessIdentity;
}
export type RegisteredProcessCapture =
  | DarwinRegisteredProcessCapture | LinuxRegisteredProcessCapture | LinuxWarmRegisteredProcessCapture
  | WindowsServiceCapture;
export type ProcessObservation = 'same-live' | 'absent' | 'stale' | 'unknown';
export interface RegisteredProcessNative {
  capture(pid: number, registrar: RegistrarBinding): RegisteredProcessCapture;
  observe(capture: RegisteredProcessCapture): ProcessObservation;
  /** Synchronous; caller must persist requested before entry. Throw means requested-unknown. */
  signal(capture: RegisteredProcessCapture): 'accepted' | 'refused';
}
/** Private asynchronous Windows facet; captures select only this member's original provider root. */
export type WindowsProcessNative = Pick<WindowsRegisteredProcessPort, 'prepareControl' | 'run' | 'lookup' | 'query'> & {
  prepareCapture?(pid: number, registrar: RegistrarBinding): WindowsServiceIntent;
};
export interface ProcessRegisterInput {
  pid: number;
  label: string;
  port?: number;
  url?: string;
  command?: string;
}
export interface OriginalProcessRegistration {
  input: ProcessRegisterInput;
  memberName: string;
  /** Durable before the first policy write; unknown policy effects are never replayed. */
  policyRequested: boolean;
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
/** Portable observation of the original registered Windows scope, never a Stop request. */
export interface NaturalProcessAbsence {
  schemaVersion: 1;
  kind: 'windows-service-absence-v1';
  captureDigest: string;
  evidence: 'native-scope' | 'retained-terminal' | 'original-whole-job';
  settlement: 'unprepared' | 'requested' | 'not-dispatched' | 'settled';
}
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
  /** Private original Main intent; its operationRef never becomes canonical physical identity. */
  nativeIntent?: WindowsServiceIntent;
  originalRegistration?: OriginalProcessRegistration;
  /** Optional durable natural observation on the original completed register receipt only. */
  nativeAbsence?: NaturalProcessAbsence;
  /** After durable original absence; an unknown intent has lookup authority only. */
  nativeSettlement?: WindowsServiceIntent;
  /** Original completed Stop's definitive no-dispatch; only a later call may replace that intent. */
  nativeSettlementNotDispatched?: true;
  /** Same original Stop and settlement intent, confirmed by the retained Main scope owner. */
  nativeSettlementConfirmed?: true;
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
  /** Fresh native executable evidence for a previously captured original child only. */
  readRootExecutable?(
    child: ChildProcess,
    executable: { path: string; sha256: string }
  ): {
    executablePath: string;
    executableSha256: string;
    pid: number;
    startIdentity: string;
  };
}

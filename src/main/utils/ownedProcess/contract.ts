import type { Readable, Writable } from 'node:stream';

export type ProcessOwner = Readonly<{
  teamIncarnation: string;
  runId: string;
  laneId: string;
  processGeneration: string;
}>;
export type Creation = 'known-not-created' | 'contained-suspended' | 'running' | 'uncertain';
export type Coverage = 'job-membership' | 'no-local-dispatch';
export type TreeReceipt = Readonly<{
  owner: ProcessOwner;
  attemptId: string;
  coverage: Coverage;
  rootExited: boolean;
  proofDigest: string;
}>;
export type TreeOutcome =
  | Readonly<{ kind: 'confirmed'; receipt: TreeReceipt }>
  | Readonly<{
      kind: 'unknown';
      owner: ProcessOwner;
      attemptId: string;
      reason: string;
      creation: Creation;
      deadlineExpired: boolean;
    }>;
export type StopRequest = Readonly<{
  expectedOwner: ProcessOwner;
  attemptId: string;
  mode: 'force' | 'graceful';
  /** Absolute performance.now() deadline, never wall clock. */
  deadlineMs: number;
}>;
export type ResolvedLaunchSpec = Readonly<{
  executable: string;
  /** Already encoded by the existing Windows launcher policy. No shell interpretation here. */
  commandLine: string;
  cwd: string;
  environment: readonly string[];
}>;
export type RootExit = Readonly<{ code: number; birth: string }>;
export type TargetDrain = Readonly<{ kind: 'complete' | 'incomplete'; reason?: string }>;
export interface PendingOwnedProcess {
  readonly owner: ProcessOwner;
  stop(request: StopRequest): Promise<TreeOutcome>;
  /** Last-handle containment fallback; retains unknown evidence, never releases ownership. */
  abandonControl(expectedOwner: ProcessOwner): void;
  /** Requires this capability's genuine receipt and component-required coverage. */
  release(receipt: TreeReceipt, requiredCoverage: Coverage): Promise<void>;
}
export interface PreparedOwnedProcess extends PendingOwnedProcess {
  readonly root: Readonly<{ pid: number; birth: string }>;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  observeRootExit(callback: (exit: RootExit) => void): () => void;
  observeTransportFailure(callback: (reason: string) => void): () => void;
  /** Persist exact owner and attach runtime observers in installOwner before native resume. */
  resume(expectedOwner: ProcessOwner, installOwner: () => Promise<void>): Promise<void>;
  /** Lifecycle finalization must wait for this independently bounded drain. */
  drain(deadlineMs: number): Promise<TargetDrain>;
}
export type Preparation =
  | Readonly<{ kind: 'prepared'; process: PreparedOwnedProcess }>
  | Readonly<{ kind: 'failed'; creation: Creation; reason: string; cleanup: PendingOwnedProcess }>;
export interface OwnedLaunchPort {
  /** Pure allocation; the caller registers this authority before prepare. */
  allocate(owner: ProcessOwner): PendingOwnedProcess;
  prepare(pending: PendingOwnedProcess, spec: ResolvedLaunchSpec): Promise<Preparation>;
}
export function sameOwner(a: ProcessOwner, b: ProcessOwner): boolean {
  return (
    a.teamIncarnation === b.teamIncarnation &&
    a.runId === b.runId &&
    a.laneId === b.laneId &&
    a.processGeneration === b.processGeneration
  );
}

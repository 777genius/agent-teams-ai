import type { RuntimeBinding, RuntimeSessionRecord } from '../runtime/contracts.js';
import type { TeamStore } from '../team/ports.js';
import type { JsonValue } from '../contracts.js';
import type { LaunchWorktreeReceipt } from './worktreeContracts.js';

/** Private configuration selected before native allocation; interpreted only by composition. */
export interface PreparedLaunchMember {
  memberId: string;
  configuration: JsonValue;
  configurationDigest: string;
  baseConfigurationDigest: string;
  configRevision: string;
}
export interface LaunchPreparation {
  commandId: string;
  sourceRosterRevision: string;
  fingerprint: string;
  members: PreparedLaunchMember[];
}

export interface NativeContextEvidence {
  kind: 'native-configuration';
  contextDigest: string;
  generation: string;
  configRevision: string;
}
export interface ExpectedLaunchMember {
  memberId: string;
  binding: RuntimeBinding | null;
  configurationDigest: string | null;
  contextDigest: string | null;
  configRevision: string | null;
  skipped: boolean;
  timeoutMs: number;
  runtimeGeneration?: number;
  baseConfigurationDigest?: string;
  restore?: { commandId: string; reference: string; sourceBinding: RuntimeBinding };
}
export interface TeamLaunchDefinition {
  launchId: string;
  rosterRevision: string;
  rosterScope?: import('../contracts.js').JsonValue;
  /** Private composition source; immutable recipe digests and product choices, never credentials. */
  capture?: JsonValue;
  members: ExpectedLaunchMember[];
}
export interface RuntimeLaunchObservation {
  record?: RuntimeSessionRecord;
  attached: boolean;
  nativeReady: boolean;
  context?: NativeContextEvidence;
}
export interface RuntimeLaunchPort {
  read(memberId: string): RuntimeLaunchObservation;
  captureAuthority?(memberId: string): () => void;
  open(memberId: string, assertAuthority?: () => void): Promise<void>;
}
export type LaunchMemberStatus =
  | 'not-started'
  | 'pending-bootstrap'
  | 'pending-human'
  | 'ready'
  | 'failed'
  | 'unknown'
  | 'skipped';
export interface LaunchAttempt {
  attemptId: string;
  hostIncarnation: string;
  startedAtMs: number;
  deadlineMs: number;
  claimed: boolean;
  status: LaunchMemberStatus;
  reason: string;
  nativeReady: boolean;
  contextApplied: boolean;
  everReady: boolean;
  usable: boolean;
  controlAvailable: boolean;
  noAllocation: boolean;
}
export interface LaunchMemberRecord {
  memberId: string;
  currentAttemptId: string;
  attempts: LaunchAttempt[];
}
export interface TeamLaunchRecord {
  schemaVersion: 1;
  nativeAdditions?: import('./nativeLaunchAddition.js').NativeLaunchAddition[];
  definition: TeamLaunchDefinition;
  fingerprint: string;
  startCommandId?: string;
  /** Original pre-allocation source for starts without a separate option preparation. */
  sourceRosterRevision?: string;
  /** Original aggregate admission time; not reset by polling/replay/retry. */
  startedAtMs?: number;
  preparation?: LaunchPreparation;
  worktrees?: LaunchWorktreeReceipt[];
  /** Same original launch record: no native definition is admitted until workspace materialization. */
  worktreePreparation?: { intent: JsonValue; admission: string; completedSourceDigest?: string };
  members: LaunchMemberRecord[];
  memberActions?: import('./memberActions.js').MemberActionRecord[];
  restorations?: { commandId: string; fingerprint: string; member: ExpectedLaunchMember }[];
  resumePreparations?: (import('./launchResume.js').ResumePreparation & { fingerprint: string })[];
  retries: {
    commandId: string;
    attemptId: string;
    memberIds: string[];
    fingerprint: string;
    native?: {
      actor: import('./memberActions.js').MemberActionActor;
      input: import('./launchRetry.js').LaunchRetryInput;
    };
  }[];
}
export interface TeamLaunchSummary {
  launchId: string;
  rosterRevision: string;
  startedAtMs: number | null;
  /** Time this Host actually observed the member Runtime facts. */
  observedAtMs: number;
  status: 'ready' | 'pending' | 'partial' | 'failed';
  ready: number;
  expected: number;
  retryCapability: 'same-binding-no-allocation-only';
  admission?: {
    commandId: string;
    sourceRosterRevision: string;
    members: { memberId: string; configuration: JsonValue }[];
  };
  members: { memberId: string; binding: RuntimeBinding | null; attempt: LaunchAttempt }[];
}
export interface TeamLaunchOptions {
  definition: TeamLaunchDefinition;
  hostIncarnation: string;
  store: Pick<TeamStore, 'fenced' | 'read' | 'write'>;
  /** Existing Team authority fence; all async Runtime work occurs after releasing it. */
  authorized<T>(action: 'read' | 'control', callback: () => T): T;
  captureActor?(): import('./memberActions.js').MemberActionActor;
  runtime: RuntimeLaunchPort;
  onProgress?(): void;
  now?(): number;
}
export class TeamLaunchError extends Error {
  constructor(
    readonly code: 'invalid' | 'conflict' | 'forbidden' | 'hold',
    readonly reason: string
  ) {
    super(`Team launch ${code}`);
  }
}

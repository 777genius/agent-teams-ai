import type { StoppedImportDiagnosticCategory } from './createStoppedImportDiagnostic.js';

export const RETAINED_LEGACY_OPEN_DIAGNOSTIC_NAMESPACE = 'RetainedLegacyOpen';
export const RETAINED_LEGACY_OPEN_DIAGNOSTIC_PHASES = [
  'ipc-shell',
  'ipc-context',
  'source-owner',
  'source-capture',
  'source-key',
  'coordinator',
  'target-capture',
  'runtime-capture',
  'scope-construction',
  'coordinator-admission',
] as const;
export const RETAINED_LEGACY_OPEN_DIAGNOSTIC_CATEGORIES = [
  'invalid',
  'conflict',
  'forbidden',
  'held',
  'busy',
  'unavailable',
  'source-changed',
  'owner-active',
  'command-unknown',
  'native-custody-unverified',
  'source-unreadable',
  'delivery-unknown',
  'outcome-unknown',
  'missing',
  'denied',
  'aborted',
  'deadline',
  'receipt-conflict',
  'receipt-held',
  'receipt-absent',
  'unknown',
] as const satisfies readonly StoppedImportDiagnosticCategory[];
export const RETAINED_LEGACY_OPEN_DIAGNOSTIC_OUTCOMES = ['not-dispatched', 'unknown'] as const;
export const LEGACY_STOPPED_SOURCE_DIAGNOSTIC_BOUNDARIES = [
  'config-read',
  'team-meta-read',
  'members-meta-read',
  'private-configuration',
  'record-shape',
  'lead-roster',
  'removed-members',
  'draft-roster',
  'saved-settings',
  'native-identity',
  'product-records',
  'owner-facts',
  'notification-facts',
  'delivery-outbox',
  'command-facts',
  'launch-state',
  'native-release',
  'source-roots',
  'snapshot-header',
] as const;
export type LegacyStoppedSourceDiagnosticBoundary =
  (typeof LEGACY_STOPPED_SOURCE_DIAGNOSTIC_BOUNDARIES)[number];

export type RetainedLegacyOpenDiagnosticPhase =
  (typeof RETAINED_LEGACY_OPEN_DIAGNOSTIC_PHASES)[number];

/** Closed owner fields only; names never include a team, run, path or credential. */
export const LEGACY_STOPPED_OWNER_FACT_NAMES = [
  'runtime.provisioning',
  'runtime.credentialCleanup',
  'runtime.alive',
  'runtime.adapter',
  'runtime.lanes',
  'runtime.stopping',
  'runtime.liveRuns',
  'runtime.pendingLaunches',
  'runtime.leadRelay',
  'runtime.memberRelay',
  'runtime.crossTeamReplies',
  'runtime.watchdog',
  'runtime.advisory',
  'lifecycle.restart',
  'lifecycle.adapterStop',
  'lifecycle.lifecycle',
  'lifecycle.lifecycleCompletion',
  'lifecycle.prepared',
  'lifecycle.retry',
  'lifecycle.pendingTimers',
  'lifecycle.unattributedCredentialCleanup',
  'stop.rosterMutation',
  'delivery.relay',
  'delivery.send',
  'delivery.leadActivity',
  'delivery.activityTimer',
  'delivery.selfHeal',
  'background.initialization',
  'background.process',
  'background.active',
  'background.queued',
  'background.notification',
  'background.context',
  'background.autoResume',
] as const;
export interface LegacyStoppedOwnerFact {
  readonly name: (typeof LEGACY_STOPPED_OWNER_FACT_NAMES)[number];
  readonly count: number | 'invalid';
}

/** Private log correlation only; never an IPC result, account or admission capability. */
export interface RetainedLegacyOpenDiagnostic {
  v: 1;
  mainPid: number;
  operationHash: string;
  phase: RetainedLegacyOpenDiagnosticPhase;
  category: StoppedImportDiagnosticCategory;
  outcome: (typeof RETAINED_LEGACY_OPEN_DIAGNOSTIC_OUTCOMES)[number];
  /** Original describe refusal only; no raw source data or admission meaning. */
  sourceBoundary?: LegacyStoppedSourceDiagnosticBoundary;
  /** At most one entry per closed field, from the original rejected owner vector. */
  ownerFacts?: readonly LegacyStoppedOwnerFact[];
}

import type { StoppedImportDiagnosticCategory } from './createStoppedImportDiagnostic';

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

export type RetainedLegacyOpenDiagnosticPhase =
  (typeof RETAINED_LEGACY_OPEN_DIAGNOSTIC_PHASES)[number];

/** Private log correlation only; never an IPC result, account or admission capability. */
export interface RetainedLegacyOpenDiagnostic {
  v: 1;
  mainPid: number;
  operationHash: string;
  phase: RetainedLegacyOpenDiagnosticPhase;
  category: StoppedImportDiagnosticCategory;
  outcome: (typeof RETAINED_LEGACY_OPEN_DIAGNOSTIC_OUTCOMES)[number];
}

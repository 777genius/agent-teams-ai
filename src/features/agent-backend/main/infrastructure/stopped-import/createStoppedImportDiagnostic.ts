export type StoppedImportDiagnosticSource = 'desktop' | 'application';
export const STOPPED_IMPORT_PREPARE_BOUNDARIES = [
  'capture-inputs',
  'initial-source-guard',
  'initial-target-guard',
  'source-construction',
  'source-fence-before-callback',
  'source-describe',
  'snapshot-export',
  'final-source-guard',
  'final-target-guard',
  'snapshot-staging',
] as const;
export type StoppedImportPrepareBoundary = (typeof STOPPED_IMPORT_PREPARE_BOUNDARIES)[number];
/** Private scalar slot, never an import input or an authority decision. */
export interface StoppedImportPrepareObservation {
  boundary?: StoppedImportPrepareBoundary;
}
export type StoppedImportDiagnosticPhase =
  | 'request'
  | 'source-owner'
  | 'source-capture'
  | 'source-key'
  | 'source-queue'
  | 'queued-source'
  | 'application'
  | 'publication-result'
  | 'command'
  | 'guard'
  | 'host-capture'
  | 'receipts'
  | 'lookup'
  | 'receipt-source'
  | 'retry'
  | 'prepare'
  | 'publish-guard'
  | 'publish'
  | 'reconcile'
  | 'receipt'
  | 'published-source'
  | 'register'
  | 'final-guard';
export type StoppedImportDiagnosticCategory =
  | 'invalid'
  | 'conflict'
  | 'forbidden'
  | 'held'
  | 'busy'
  | 'unavailable'
  | 'source-changed'
  | 'owner-active'
  | 'command-unknown'
  | 'native-custody-unverified'
  | 'source-unreadable'
  | 'delivery-unknown'
  | 'outcome-unknown'
  | 'missing'
  | 'denied'
  | 'aborted'
  | 'deadline'
  | 'receipt-conflict'
  | 'receipt-held'
  | 'receipt-absent'
  | 'unknown';
export interface StoppedImportDiagnostic {
  source: StoppedImportDiagnosticSource;
  phase: StoppedImportDiagnosticPhase;
  category: StoppedImportDiagnosticCategory;
  outcome: 'not-dispatched' | 'unknown';
  prepareBoundary?: StoppedImportPrepareBoundary;
}
export type StoppedImportDiagnosticSink = (observation: StoppedImportDiagnostic) => unknown;

const phases: Record<StoppedImportDiagnosticSource, ReadonlySet<StoppedImportDiagnosticPhase>> = {
  desktop: new Set([
    'request',
    'source-owner',
    'source-capture',
    'source-key',
    'source-queue',
    'queued-source',
    'application',
    'publication-result',
  ]),
  application: new Set([
    'request',
    'source-capture',
    'command',
    'guard',
    'host-capture',
    'receipts',
    'lookup',
    'receipt-source',
    'retry',
    'prepare',
    'publish-guard',
    'publish',
    'reconcile',
    'receipt',
    'published-source',
    'register',
    'final-guard',
  ]),
};
const categories = new Map<string, StoppedImportDiagnosticCategory>([
  ['invalid', 'invalid'],
  ['conflict', 'conflict'],
  ['forbidden', 'forbidden'],
  ['hold', 'held'],
  ['held', 'held'],
  ['busy', 'busy'],
  ['unavailable', 'unavailable'],
  ['source-changed', 'source-changed'],
  ['owner-active', 'owner-active'],
  ['command-unknown', 'command-unknown'],
  ['native-custody-unverified', 'native-custody-unverified'],
  ['source-unreadable', 'source-unreadable'],
  ['delivery-unknown', 'delivery-unknown'],
  ['outcome-unknown', 'outcome-unknown'],
  ['ENOENT', 'missing'],
  ['EACCES', 'denied'],
  ['EPERM', 'denied'],
  ['ABORT_ERR', 'aborted'],
  ['ETIMEDOUT', 'deadline'],
  ['AbortError', 'aborted'],
  ['TimeoutError', 'deadline'],
  ['TypeError', 'invalid'],
]);
const explicitCategories = new Set<StoppedImportDiagnosticCategory>([
  'receipt-conflict',
  'receipt-held',
  'receipt-absent',
]);
const prepareBoundaries = new Set<string>(STOPPED_IMPORT_PREPARE_BOUNDARIES);

function ownString(error: unknown, key: 'reason' | 'code' | 'name'): string | undefined {
  if ((!error || typeof error !== 'object') && typeof error !== 'function') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}
function category(error: unknown): StoppedImportDiagnosticCategory {
  for (const key of ['reason', 'code', 'name'] as const) {
    const value = ownString(error, key);
    if (value !== undefined && categories.has(value)) return categories.get(value)!;
  }
  try {
    return error instanceof TypeError ? 'invalid' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** One private observation; no request identifiers, exception text or admission authority. */
export function createStoppedImportDiagnostic(
  source: StoppedImportDiagnosticSource,
  sink?: StoppedImportDiagnosticSink
): (
  phase: StoppedImportDiagnosticPhase,
  error: unknown,
  outcome: StoppedImportDiagnostic['outcome'],
  explicitCategory?: StoppedImportDiagnosticCategory,
  prepare?: StoppedImportPrepareObservation
) => void {
  let observed = false;
  return (phase, error, outcome, explicitCategory, prepare) => {
    if (observed) return;
    observed = true;
    try {
      if (
        !sink ||
        !(source === 'desktop' || source === 'application') ||
        !phases[source].has(phase) ||
        !(outcome === 'not-dispatched' || outcome === 'unknown') ||
        (explicitCategory !== undefined && !explicitCategories.has(explicitCategory))
      )
        return;
      const descriptor = prepare && Object.getOwnPropertyDescriptor(prepare, 'boundary');
      const boundary = descriptor && 'value' in descriptor ? descriptor.value : undefined;
      if (
        prepare !== undefined &&
        (source !== 'application' ||
          phase !== 'prepare' ||
          (boundary !== undefined &&
            (typeof boundary !== 'string' || !prepareBoundaries.has(boundary))))
      )
        return;
      const observation: StoppedImportDiagnostic = {
        source,
        phase,
        category: explicitCategory ?? category(error),
        outcome,
        ...(boundary === undefined
          ? {}
          : { prepareBoundary: boundary as StoppedImportPrepareBoundary }),
      };
      void Promise.resolve(sink(observation)).catch(() => {
        // Diagnostics cannot replace the original refusal or its uncertainty.
      });
    } catch {
      // A broken observer cannot change publication, custody or cleanup.
    }
  };
}

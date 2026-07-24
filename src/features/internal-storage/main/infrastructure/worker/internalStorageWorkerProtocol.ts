import type {
  CommentJournalEntryRecord,
  StallJournalEntryRecord,
} from '../../../contracts/internalStorageContracts';
import type { TeamRosterSnapshotRecord } from '../../../contracts/teamRosterStorageContracts';
import type {
  ProcessOwnershipStorageCompareAndSwapRequest,
  ProcessOwnershipStorageCompareAndSwapResult,
  ProcessOwnershipStorageLoadResult,
  ProcessOwnershipStorageScope,
  StoredProcessOwnershipPhase,
  StoredProcessOwnershipState,
} from '../ProcessOwnershipStorageGateway';
import type {
  DurableApplicationCommandCommitRequest,
  DurableApplicationCommandConsumerApplyRequest,
  DurableApplicationCommandConsumerProjectionRequest,
  DurableApplicationCommandPersistClaimRequest,
} from '@features/application-command-ledger';
import type {
  BackupFenceCompletionDisposition,
  BackupRunRecord,
  BackupRunState,
} from '@features/coordination-backup/contracts';
import type { CoordinationSnapshotRequest } from '@features/coordination-events';
import type {
  CoordinationEventActor,
  CoordinationEventDraft,
  CoordinationJsonValue,
} from '@features/coordination-events/contracts';
import type { TeamId } from '@shared/contracts/hosted';

export interface InternalStorageWorkerData {
  databasePath: string;
}

export type ApplicationCommandLedgerWorkerOp =
  | 'appCommandLedger.begin'
  | 'appCommandLedger.markCompleted'
  | 'appCommandLedger.markFailed'
  | 'appCommandLedger.getByCommandId'
  | 'appCommandLedger.getByIdempotencyKey'
  | 'appCommandLedger.listByScope'
  | 'appCommandLedger.durable.claim'
  | 'appCommandLedger.durable.getStatus'
  | 'appCommandLedger.durable.getByClaim'
  | 'appCommandLedger.durable.renewAttemptLease'
  | 'appCommandLedger.durable.transitionCommand'
  | 'appCommandLedger.durable.transitionEffect'
  | 'appCommandLedger.durable.commit'
  | 'appCommandLedger.durable.listOutbox'
  | 'appCommandLedger.durable.claimOutbox'
  | 'appCommandLedger.durable.acknowledgeOutboxDelivery'
  | 'appCommandLedger.durable.applyConsumerEvent'
  | 'appCommandLedger.durable.getConsumerProjection';

/** Payloads whose durable envelope semantics must remain typed across IPC. */
export interface ApplicationCommandLedgerWorkerPayloadByOp {
  'appCommandLedger.durable.claim': DurableApplicationCommandPersistClaimRequest & {
    /**
     * Internal trusted attribution supplied by an owning command composition.
     * Existing public command DTOs remain unchanged; absent values are stored
     * with explicit recovery/legacy provenance and never promoted to operator.
     */
    readonly coordinationAttribution?: StoredCommandCoordinationAttribution;
  };
  'appCommandLedger.durable.commit': DurableApplicationCommandCommitRequest;
  'appCommandLedger.durable.applyConsumerEvent': DurableApplicationCommandConsumerApplyRequest;
  'appCommandLedger.durable.getConsumerProjection': DurableApplicationCommandConsumerProjectionRequest;
}

export interface StoredCommandCoordinationAttribution {
  readonly actor: Exclude<CoordinationEventActor, { readonly kind: 'external_file' }>;
  readonly runId?: string;
  readonly provenance: 'trusted_context_v1' | 'legacy_recovery_v1';
}

type TypedApplicationCommandLedgerWorkerRequest = {
  [TOp in keyof ApplicationCommandLedgerWorkerPayloadByOp]: {
    id: string;
    op: TOp;
    payload: ApplicationCommandLedgerWorkerPayloadByOp[TOp];
  };
}[keyof ApplicationCommandLedgerWorkerPayloadByOp];

interface UntypedApplicationCommandLedgerWorkerRequest {
  id: string;
  op: Exclude<ApplicationCommandLedgerWorkerOp, keyof ApplicationCommandLedgerWorkerPayloadByOp>;
  payload: unknown;
}

export interface StoredEventJournalMetadata {
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly retentionFloorSequence: number;
  readonly highWatermarkSequence: number;
}

export interface StoredCoordinationEventRow {
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly eventSequence: number;
  readonly eventId: string;
  readonly bodyJson: string;
}

export interface StoredSnapshotRetentionLease {
  readonly leaseId: string;
  readonly watermark: StoredEventJournalMetadata;
  readonly deadlineAtMs: number;
}

export interface StoredSnapshotRetentionLeaseUse {
  readonly active: boolean;
  readonly watermark: StoredEventJournalMetadata;
}

export interface CoordinationDrainStorageEvidence {
  readonly backupRunId: string;
  readonly fenceGeneration: number;
  readonly throughCommandSequence: number;
  readonly throughEventSequence: number;
  readonly eventEpoch: string;
  readonly durableBarrier: string;
}

export interface SqliteOnlineBackupStorageResult {
  readonly status: 'completed' | 'busy_timeout' | 'deadline_exceeded' | 'source_corrupt';
  readonly applicationId?: number;
  readonly userVersion?: number;
  readonly byteLength?: number;
  readonly mode?: number;
  readonly sha256?: string;
}

export interface SqliteBackupChunkStorageResult {
  readonly offset: number;
  readonly totalByteLength: number;
  readonly bytes: Uint8Array;
  readonly eof: boolean;
}

export type SqliteSnapshotVerificationStorageResult =
  | {
      readonly status: 'valid';
      readonly applicationId: number;
      readonly userVersion: number;
      readonly requiredTables: readonly string[];
    }
  | {
      readonly status: 'invalid';
      readonly reason:
        | 'integrity_check_failed'
        | 'application_id_mismatch'
        | 'schema_mismatch'
        | 'migration_incomplete'
        | 'required_identity_missing';
    };

export interface CoordinationDurabilityWorkerPayloadByOp {
  'coordinationEvents.initialize': {
    readonly deploymentId: string;
    readonly eventEpoch?: string;
    readonly nowIso: string;
  };
  'coordinationEvents.getWatermark': { readonly deploymentId: string };
  'coordinationEvents.read': {
    readonly deploymentId: string;
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly limit: number;
  };
  'coordinationEvents.append': {
    readonly deploymentId: string;
    readonly eventEpoch: string;
    readonly draft: CoordinationEventDraft<CoordinationJsonValue>;
    readonly bodyJson: string;
    readonly nowIso: string;
  };
  'coordinationEvents.prune': {
    readonly deploymentId: string;
    readonly eventEpoch: string;
    readonly throughSequence: number;
    readonly nowMs: number;
    readonly nowIso: string;
  };
  'coordinationEvents.lease.acquire': {
    readonly deploymentId: string;
    readonly leaseId: string;
    readonly request: CoordinationSnapshotRequest;
    readonly nowMs: number;
    readonly deadlineAtMs: number;
  };
  'coordinationEvents.lease.beginUse': {
    readonly leaseId: string;
    readonly useToken: string;
    readonly nowMs: number;
  };
  'coordinationEvents.lease.endUse': {
    readonly leaseId: string;
    readonly useToken: string;
  };
  'coordinationEvents.lease.release': { readonly leaseId: string };
  'coordinationBackupRuns.create': { readonly record: BackupRunRecord };
  'coordinationBackupRuns.get': { readonly backupRunId: string };
  'coordinationBackupRuns.listRecoverable': Record<string, never>;
  'coordinationBackupRuns.compareAndSet': {
    readonly backupRunId: string;
    readonly expectedRevision: number;
    readonly expectedState: BackupRunState;
    readonly record: BackupRunRecord;
  };
  'coordinationBackupFence.acquire': {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly expectedGeneration: number | null;
    readonly leaseId: string;
    readonly acquiredAt: string;
  };
  'coordinationBackupFence.complete': {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly generation: number;
    readonly leaseId: string;
    readonly disposition: BackupFenceCompletionDisposition;
    readonly completedAt: string;
  };
  'coordinationBackupFlush.drain': {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly fenceGeneration: number;
  };
  'coordinationBackupFlush.capture': {
    readonly deploymentId: string;
    readonly evidence: CoordinationDrainStorageEvidence;
  };
  'coordinationBackup.sqlite.online': {
    readonly backupRunId: string;
    readonly deadlineAtMs: number;
    readonly busyRetryMs: number;
    readonly pagesPerStep: number;
  };
  'coordinationBackup.sqlite.verify': {
    readonly backupRunId: string;
  };
  'coordinationBackup.sqlite.readChunk': {
    readonly backupRunId: string;
    readonly offset: number;
    readonly maximumBytes: number;
  };
  'coordinationBackup.sqlite.discard': { readonly backupRunId: string };
}

type TypedCoordinationDurabilityWorkerRequest = {
  [TOp in keyof CoordinationDurabilityWorkerPayloadByOp]: {
    id: string;
    op: TOp;
    payload: CoordinationDurabilityWorkerPayloadByOp[TOp];
  };
}[keyof CoordinationDurabilityWorkerPayloadByOp];

export interface ProcessOwnershipWorkerPayloadByOp {
  'processOwnership.loadByScope': { readonly scope: ProcessOwnershipStorageScope };
  'processOwnership.loadByProcessRef': { readonly processRef: string };
  'processOwnership.list': Record<string, never>;
  'processOwnership.compareAndSwap': {
    readonly request: ProcessOwnershipStorageCompareAndSwapRequest;
    readonly admission: { readonly deadlineAtMs: number };
  };
}

type TypedProcessOwnershipWorkerRequest = {
  [TOp in keyof ProcessOwnershipWorkerPayloadByOp]: {
    id: string;
    op: TOp;
    payload: ProcessOwnershipWorkerPayloadByOp[TOp];
  };
}[keyof ProcessOwnershipWorkerPayloadByOp];

export type InternalStorageWorkerRequest =
  | { id: string; op: 'ping'; payload: Record<string, never> }
  | { id: string; op: 'stallJournal.load'; payload: { teamName: string } }
  | {
      id: string;
      op: 'stallJournal.replace';
      payload: { teamName: string; entries: StallJournalEntryRecord[] };
    }
  | { id: string; op: 'commentJournal.load'; payload: { teamName: string } }
  | {
      id: string;
      op: 'commentJournal.replace';
      payload: { teamName: string; entries: CommentJournalEntryRecord[] };
    }
  | { id: string; op: 'commentJournal.exists'; payload: { teamName: string } }
  | { id: string; op: 'commentJournal.ensureInitialized'; payload: { teamName: string } }
  | {
      id: string;
      op: 'storeImports.record';
      payload: { storeId: string; teamName: string; entryCount: number };
    }
  | {
      id: string;
      op: 'storeImports.has';
      payload: { storeId: string; teamName: string };
    }
  | { id: string; op: 'teamIdentity.list'; payload: Record<string, never> }
  | { id: string; op: 'teamIdentity.get'; payload: { teamId: TeamId } }
  | { id: string; op: 'teamRoster.get'; payload: { teamId: TeamId } }
  | { id: string; op: 'teamRoster.adopt'; payload: { roster: TeamRosterSnapshotRecord } }
  // Member-work-sync ops share one wire shape; the typed client methods and
  // the worker-side dispatcher (memberWorkSyncWorkerOps) own the payloads.
  | TypedApplicationCommandLedgerWorkerRequest
  | TypedCoordinationDurabilityWorkerRequest
  | TypedProcessOwnershipWorkerRequest
  | UntypedApplicationCommandLedgerWorkerRequest
  | { id: string; op: `mws.${string}`; payload: unknown }
  | { id: string; op: 'close'; payload: Record<string, never> };

export type InternalStorageWorkerOp = InternalStorageWorkerRequest['op'];

interface JournalReplacePayloadByOp {
  'stallJournal.replace': { teamName: string; entries: StallJournalEntryRecord[] };
  'commentJournal.replace': { teamName: string; entries: CommentJournalEntryRecord[] };
}

/**
 * Runtime-checks the team-isolation invariant before a replace operation can
 * delete any rows. TypeScript cannot guarantee that every entry's embedded
 * teamName agrees with the payload teamName after the worker-thread hop.
 */
export function parseJournalReplacePayload<TOp extends keyof JournalReplacePayloadByOp>(
  op: TOp,
  payload: unknown
): JournalReplacePayloadByOp[TOp] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`Invalid ${op} payload: expected an object`);
  }

  const candidate = payload as { teamName?: unknown; entries?: unknown };
  if (typeof candidate.teamName !== 'string') {
    throw new Error(`Invalid ${op} payload: teamName must be a string`);
  }
  if (!Array.isArray(candidate.entries)) {
    throw new Error(`Invalid ${op} payload: entries must be an array`);
  }

  for (const [index, entry] of candidate.entries.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Invalid ${op} payload: entries[${index}] must be an object`);
    }
    const entryTeamName = (entry as { teamName?: unknown }).teamName;
    if (entryTeamName !== candidate.teamName) {
      throw new Error(
        `Invalid ${op} payload: entries[${index}].teamName must match payload teamName`
      );
    }
  }

  return candidate as JournalReplacePayloadByOp[TOp];
}

export type InternalStorageWorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

const PROCESS_OWNERSHIP_WORKER_OPS = new Set<InternalStorageWorkerOp>([
  'processOwnership.loadByScope',
  'processOwnership.loadByProcessRef',
  'processOwnership.list',
  'processOwnership.compareAndSwap',
]);
const PROCESS_OWNERSHIP_PHASES = new Set<StoredProcessOwnershipPhase>([
  'spawn_intent',
  'owned',
  'stopping',
  'drained',
  'unclassified_residual',
]);
const PROCESS_OWNERSHIP_SHA_256 = /^sha256:[a-f0-9]{64}$/;
const PROCESS_OWNERSHIP_OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROCESS_OWNERSHIP_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/;
const PROCESS_OWNERSHIP_MAX_STATE_BYTES = 64 * 1_024;
const PROCESS_OWNERSHIP_MAX_RECORDS = 10_000;

export function isProcessOwnershipWorkerOp(
  op: InternalStorageWorkerOp
): op is keyof ProcessOwnershipWorkerPayloadByOp {
  return PROCESS_OWNERSHIP_WORKER_OPS.has(op);
}

export function parseInternalStorageWorkerResponse(value: unknown): InternalStorageWorkerResponse {
  const record = exactWorkerRecord(value, 'response');
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new TypeError('internal-storage-worker-response-id-invalid');
  }
  if (record.ok === true) {
    exactWorkerFields(record, ['id', 'ok', 'result'], 'response');
    return { id: record.id, ok: true, result: record.result };
  }
  if (record.ok === false && typeof record.error === 'string') {
    exactWorkerFields(record, ['id', 'ok', 'error'], 'response');
    return { id: record.id, ok: false, error: record.error };
  }
  throw new TypeError('internal-storage-worker-response-shape-invalid');
}

export function parseInternalStorageWorkerResponseForPending(
  value: unknown,
  getOp: (id: string) => InternalStorageWorkerOp | undefined
): InternalStorageWorkerResponse {
  const response = parseInternalStorageWorkerResponse(value);
  const op = getOp(response.id);
  return response.ok && op !== undefined && isProcessOwnershipWorkerOp(op)
    ? { ...response, result: parseProcessOwnershipWorkerResult(op, response.result) }
    : response;
}

export function parseProcessOwnershipWorkerPayload<
  TOp extends keyof ProcessOwnershipWorkerPayloadByOp,
>(op: TOp, value: unknown): ProcessOwnershipWorkerPayloadByOp[TOp] {
  let parsed: ProcessOwnershipWorkerPayloadByOp[keyof ProcessOwnershipWorkerPayloadByOp];
  if (op === 'processOwnership.loadByScope') {
    const record = exactWorkerFields(value, ['scope'], 'ownership-load-scope');
    parsed = { scope: parseWorkerOwnershipScope(record.scope) };
  } else if (op === 'processOwnership.loadByProcessRef') {
    const record = exactWorkerFields(value, ['processRef'], 'ownership-load-ref');
    parsed = { processRef: parseWorkerProcessRef(record.processRef) };
  } else if (op === 'processOwnership.list') {
    exactWorkerFields(value, [], 'ownership-list');
    parsed = {};
  } else {
    const record = exactWorkerFields(value, ['request', 'admission'], 'ownership-cas');
    const admission = exactWorkerFields(record.admission, ['deadlineAtMs'], 'ownership-admission');
    const deadlineAtMs = parseWorkerPositiveInteger(
      admission.deadlineAtMs,
      'ownership-admission-deadline'
    );
    parsed = {
      request: parseWorkerCompareAndSwapRequest(record.request),
      admission: { deadlineAtMs },
    };
  }
  return parsed as ProcessOwnershipWorkerPayloadByOp[TOp];
}

interface ProcessOwnershipWorkerResultByOp {
  'processOwnership.loadByScope': ProcessOwnershipStorageLoadResult;
  'processOwnership.loadByProcessRef': ProcessOwnershipStorageLoadResult;
  'processOwnership.list': readonly StoredProcessOwnershipState[];
  'processOwnership.compareAndSwap': ProcessOwnershipStorageCompareAndSwapResult;
}

export function parseProcessOwnershipWorkerResult<
  TOp extends keyof ProcessOwnershipWorkerResultByOp,
>(op: TOp, value: unknown): ProcessOwnershipWorkerResultByOp[TOp] {
  let parsed: ProcessOwnershipWorkerResultByOp[keyof ProcessOwnershipWorkerResultByOp];
  if (op === 'processOwnership.list') {
    if (
      !Array.isArray(value) ||
      value.length > PROCESS_OWNERSHIP_MAX_RECORDS ||
      Reflect.ownKeys(value).length !== value.length + 1
    ) {
      throw new TypeError('internal-storage-worker-ownership-list-result-invalid');
    }
    parsed = Object.freeze(value.map(parseWorkerStoredOwnershipState));
  } else {
    const record = exactWorkerRecord(value, 'ownership-result');
    if (record.status === 'missing') {
      exactWorkerFields(record, ['status'], 'ownership-load-result');
      parsed = { status: 'missing' };
    } else if (record.status === 'conflict') {
      exactWorkerFields(record, ['status'], 'ownership-cas-result');
      parsed = { status: 'conflict' };
    } else if (record.status === 'found') {
      exactWorkerFields(record, ['status', 'record'], 'ownership-load-result');
      parsed = { status: 'found', record: parseWorkerStoredOwnershipState(record.record) };
    } else if (record.status === 'applied') {
      exactWorkerFields(record, ['status', 'record'], 'ownership-cas-result');
      parsed = { status: 'applied', record: parseWorkerStoredOwnershipState(record.record) };
    } else {
      throw new TypeError('internal-storage-worker-ownership-result-invalid');
    }
    if (
      (op === 'processOwnership.compareAndSwap') !==
      (parsed.status === 'applied' || parsed.status === 'conflict')
    ) {
      throw new TypeError('internal-storage-worker-ownership-result-op-invalid');
    }
  }
  return parsed as ProcessOwnershipWorkerResultByOp[TOp];
}

function parseWorkerCompareAndSwapRequest(
  value: unknown
): ProcessOwnershipStorageCompareAndSwapRequest {
  const record = exactWorkerFields(
    value,
    ['scope', 'expectedRevision', 'expectedCurrent', 'next'],
    'ownership-cas-request'
  );
  const scope = parseWorkerOwnershipScope(record.scope);
  const expectedRevision =
    record.expectedRevision === null
      ? null
      : parseWorkerPositiveInteger(record.expectedRevision, 'ownership-expected-revision');
  const expectedCurrent =
    record.expectedCurrent === null
      ? null
      : parseWorkerStoredOwnershipState(record.expectedCurrent);
  const next = parseWorkerStoredOwnershipState(record.next);
  if (
    !workerOwnershipScopesEqual(scope, next.scope) ||
    (expectedRevision === null) !== (expectedCurrent === null) ||
    (expectedCurrent !== null &&
      (expectedCurrent.revision !== expectedRevision ||
        expectedCurrent.processRef !== next.processRef ||
        !workerOwnershipScopesEqual(expectedCurrent.scope, scope))) ||
    next.revision !== (expectedRevision ?? 0) + 1
  ) {
    throw new TypeError('internal-storage-worker-ownership-cas-binding-invalid');
  }
  return { scope, expectedRevision, expectedCurrent, next };
}

function parseWorkerStoredOwnershipState(value: unknown): StoredProcessOwnershipState {
  const record = exactWorkerFields(
    value,
    ['scope', 'processRef', 'codecVersion', 'stateVersion', 'revision', 'phase', 'stateJson'],
    'ownership-record'
  );
  if (
    record.codecVersion !== 1 ||
    record.stateVersion !== 1 ||
    !PROCESS_OWNERSHIP_PHASES.has(record.phase as StoredProcessOwnershipPhase)
  ) {
    throw new TypeError('internal-storage-worker-ownership-record-version-invalid');
  }
  const stateJson = parseWorkerCanonicalStateJson(record.stateJson);
  const envelope = JSON.parse(stateJson) as {
    codecVersion: number;
    state: Record<string, unknown>;
  };
  const revision = parseWorkerPositiveInteger(record.revision, 'ownership-revision');
  if (
    envelope.codecVersion !== record.codecVersion ||
    envelope.state.stateVersion !== record.stateVersion ||
    envelope.state.revision !== revision ||
    envelope.state.phase !== record.phase
  ) {
    throw new TypeError('internal-storage-worker-ownership-record-metadata-invalid');
  }
  return {
    scope: parseWorkerOwnershipScope(record.scope),
    processRef: parseWorkerProcessRef(record.processRef),
    codecVersion: 1,
    stateVersion: 1,
    revision,
    phase: record.phase as StoredProcessOwnershipPhase,
    stateJson,
  };
}

function parseWorkerCanonicalStateJson(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > PROCESS_OWNERSHIP_MAX_STATE_BYTES
  ) {
    throw new TypeError('internal-storage-worker-ownership-state-json-invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('internal-storage-worker-ownership-state-json-invalid');
  }
  const envelope = exactWorkerFields(parsed, ['codecVersion', 'state'], 'ownership-envelope');
  exactWorkerRecord(envelope.state, 'ownership-state');
  if (canonicalWorkerJson(parsed) !== value) {
    throw new TypeError('internal-storage-worker-ownership-state-json-noncanonical');
  }
  return value;
}

function parseWorkerOwnershipScope(value: unknown): ProcessOwnershipStorageScope {
  const record = exactWorkerFields(
    value,
    ['teamId', 'runId', 'planGeneration', 'planHash', 'executionUnitId'],
    'ownership-scope'
  );
  if (typeof record.planHash !== 'string' || !PROCESS_OWNERSHIP_SHA_256.test(record.planHash)) {
    throw new TypeError('internal-storage-worker-ownership-plan-hash-invalid');
  }
  return {
    teamId: parseWorkerOpaque(record.teamId, 'team-id'),
    runId: parseWorkerOpaque(record.runId, 'run-id'),
    planGeneration: parseWorkerPositiveInteger(record.planGeneration, 'ownership-plan-generation'),
    planHash: record.planHash,
    executionUnitId: parseWorkerOpaque(record.executionUnitId, 'execution-unit-id'),
  };
}

function parseWorkerProcessRef(value: unknown): string {
  if (typeof value !== 'string' || !PROCESS_OWNERSHIP_REF.test(value)) {
    throw new TypeError('internal-storage-worker-ownership-process-ref-invalid');
  }
  return value;
}

function parseWorkerOpaque(value: unknown, reason: string): string {
  if (typeof value !== 'string' || !PROCESS_OWNERSHIP_OPAQUE.test(value)) {
    throw new TypeError(`internal-storage-worker-ownership-${reason}-invalid`);
  }
  return value;
}

function parseWorkerPositiveInteger(value: unknown, reason: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`internal-storage-worker-${reason}-invalid`);
  }
  return value;
}

function workerOwnershipScopesEqual(
  left: ProcessOwnershipStorageScope,
  right: ProcessOwnershipStorageScope
): boolean {
  return (
    left.teamId === right.teamId &&
    left.runId === right.runId &&
    left.planGeneration === right.planGeneration &&
    left.planHash === right.planHash &&
    left.executionUnitId === right.executionUnitId
  );
}

function exactWorkerFields(
  value: unknown,
  fields: readonly string[],
  reason: string
): Record<string, unknown> {
  const record = exactWorkerRecord(value, reason);
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new TypeError(`internal-storage-worker-${reason}-fields-invalid`);
  }
  return record;
}

function exactWorkerRecord(value: unknown, reason: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string')
  ) {
    throw new TypeError(`internal-storage-worker-${reason}-invalid`);
  }
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if (descriptors.some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) {
    throw new TypeError(`internal-storage-worker-${reason}-descriptor-invalid`);
  }
  return value as Record<string, unknown>;
}

function canonicalWorkerJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('internal-storage-worker-number-invalid');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalWorkerJson).join(',')}]`;
  const record = exactWorkerRecord(value, 'canonical-value');
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalWorkerJson(record[key])}`)
    .join(',')}}`;
}

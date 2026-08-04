import { COORDINATION_EVENT_SCHEMA_VERSION } from '@features/coordination-events/contracts';
import {
  parseWorkspaceId,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted/identifiers';

import type {
  CoordinationEventActor,
  CoordinationJsonValue,
  PublishCoordinationEventCommand,
} from '@features/coordination-events';
import type {
  ExternalFileReconciliationPort,
  ExternalFileReconciliationRequest,
  ExternalFileReconciliationResult,
  ExternalFileSourceFingerprint,
  ExternalSelfWriteIntent,
  ExternalWriterObserver,
} from '@features/external-writer-coordination';

export const HOSTED_TASK_EXTERNAL_WRITER_FEATURE_KEY = 'tasks' as const;

const MAX_COORDINATION_IDENTIFIER_LENGTH = 256;
const MAX_EXTERNAL_VALUE_LENGTH = 1_024;
const MAX_RECONCILIATION_ID_LENGTH = 4 * MAX_EXTERNAL_VALUE_LENGTH + 128;
const MAX_TASK_ID_LENGTH = 240;
const MAX_TASK_DOCUMENT_DEPTH = 32;
const MAX_TASK_DOCUMENT_NODES = 20_000;
const MAX_TASK_DOCUMENT_KEY_LENGTH = 512;

export interface HostedTaskExternalWriterJsonObject {
  readonly [key: string]: HostedTaskExternalWriterJsonValue;
}

export type HostedTaskExternalWriterJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly HostedTaskExternalWriterJsonValue[]
  | HostedTaskExternalWriterJsonObject;

export interface HostedTaskExternalWriterDocument {
  readonly taskId: string;
  /** A detached, immutable JSON object; no file-provided actor fields are trusted as attribution. */
  readonly document: HostedTaskExternalWriterJsonObject;
}

export type HostedTaskExternalWriterEffect =
  | { readonly kind: 'observed'; readonly document: HostedTaskExternalWriterDocument }
  | { readonly kind: 'missing'; readonly taskId: string };

export type HostedTaskExternalWriterActor =
  | {
      readonly kind: 'external_file';
      readonly fileWriterEpoch: number;
      readonly observationSequence: number;
    }
  | {
      readonly kind: 'verified_run';
      readonly runId: string;
      readonly runGeneration: number;
      readonly memberId: string | null;
      readonly evidenceRef: string;
    };

export interface HostedTaskExternalWriterObservation {
  readonly teamId: TeamId;
  readonly fileKey: string;
  readonly fingerprint: ExternalFileSourceFingerprint;
  readonly fileWriterEpoch: number;
  readonly observationSequence: number;
  readonly actor: HostedTaskExternalWriterActor;
}

/** Canonical target identity resolved by the integration, never from file JSON. */
export interface HostedTaskExternalWriterTarget {
  readonly workspaceId: WorkspaceId;
  readonly taskId: string;
}

/** The accepted resource coordinates allocated by the authority's commit. */
export interface HostedTaskExternalWriterCommittedChange {
  readonly sourceGeneration: number;
  readonly featureRevision: number;
}

export interface HostedTaskExternalWriterReconciliationCommit {
  readonly reconciliationId: string;
  readonly observation: HostedTaskExternalWriterObservation;
  readonly effect: HostedTaskExternalWriterEffect;
  /**
   * Invoke only for a newly accepted effect after the authority has allocated
   * the committed resource coordinates. The returned handoff is persisted with
   * that effect/result; an idempotent replay, conflict, or noop never invokes
   * this factory.
   */
  readonly buildCommittedCoordinationEvent: (
    committed: HostedTaskExternalWriterCommittedChange
  ) => PublishCoordinationEventCommand;
}

/**
 * Integration owns the keyed transaction behind this narrow port. It validates
 * the live file-writer epoch and verified-run lineage immediately before
 * committing, deduplicates an exact reconciliation ID/input pair, applies the
 * domain effect, and appends the supplied coordination-event handoff only for
 * an accepted change. This feature does not own lifecycle commands.
 */
export interface HostedTaskExternalWriterAuthority {
  /** Resolves the task and its hosted workspace together under authority control. */
  resolveTaskTarget(input: {
    readonly teamId: TeamId;
    readonly fileKey: string;
  }): Promise<HostedTaskExternalWriterTarget | null>;
  createEventId(input: {
    readonly reconciliationId: string;
    readonly eventType: 'team.task.external_file_observed' | 'team.task.external_file_missing';
  }): string;
  nowIso(): string;
  getResult(reconciliationId: string): Promise<ExternalFileReconciliationResult | null>;
  commit(
    input: HostedTaskExternalWriterReconciliationCommit
  ): Promise<ExternalFileReconciliationResult>;
}

export interface HostedTaskExternalWriterSelfWrite {
  readonly intentId: string;
  readonly teamId: TeamId;
  readonly fileKey: string;
  readonly expectedChecksum: string | null;
  readonly sourceGeneration: number;
  readonly fileWriterEpoch: number;
  readonly expiresAtMs: number;
}

interface NormalizationBudget {
  nodes: number;
}

function invalid(diagnosticCode: string): ExternalFileReconciliationResult {
  return Object.freeze({ outcome: 'invalid', diagnosticCode, blocksDependentMutations: true });
}

function isBoundedString(value: unknown, maximum = MAX_EXTERNAL_VALUE_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isCoordinationIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_COORDINATION_IDENTIFIER_LENGTH &&
    value.trim() === value
  );
}

function isReconciliationId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_RECONCILIATION_ID_LENGTH
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isWorkspaceId(value: unknown): value is WorkspaceId {
  try {
    return parseWorkspaceId(value) === value;
  } catch {
    return false;
  }
}

function validFingerprint(fingerprint: ExternalFileSourceFingerprint): boolean {
  if (!fingerprint.exists) {
    return fingerprint.checksum === null && fingerprint.statIdentity === null;
  }
  const identity = fingerprint.statIdentity;
  return (
    isBoundedString(fingerprint.checksum) &&
    identity !== null &&
    isNonNegativeSafeInteger(identity.byteLength) &&
    isBoundedString(identity.device) &&
    isBoundedString(identity.inode) &&
    isBoundedString(identity.modifiedTimeNs) &&
    isBoundedString(identity.changedTimeNs)
  );
}

function sourceIsConsistent(request: ExternalFileReconciliationRequest): boolean {
  if (request.content === null) {
    return (
      !request.fingerprint.exists &&
      request.fingerprint.checksum === null &&
      request.fingerprint.statIdentity === null
    );
  }
  return (
    request.fingerprint.exists &&
    request.fingerprint.statIdentity !== null &&
    typeof request.fingerprint.checksum === 'string' &&
    request.fingerprint.statIdentity.byteLength === request.content.byteLength
  );
}

function copyFingerprint(
  fingerprint: ExternalFileSourceFingerprint
): ExternalFileSourceFingerprint {
  return Object.freeze({
    exists: fingerprint.exists,
    checksum: fingerprint.checksum,
    statIdentity:
      fingerprint.statIdentity === null
        ? null
        : Object.freeze({
            byteLength: fingerprint.statIdentity.byteLength,
            device: fingerprint.statIdentity.device,
            inode: fingerprint.statIdentity.inode,
            modifiedTimeNs: fingerprint.statIdentity.modifiedTimeNs,
            changedTimeNs: fingerprint.statIdentity.changedTimeNs,
          }),
  });
}

function toActor(request: ExternalFileReconciliationRequest): HostedTaskExternalWriterActor | null {
  const actor = request.actor;
  if (actor.teamId !== request.registration.scope.teamId) return null;
  if (actor.kind === 'external_file') {
    if (
      actor.featureKey !== HOSTED_TASK_EXTERNAL_WRITER_FEATURE_KEY ||
      actor.fileKey !== request.registration.fileKey ||
      actor.checksum !== request.fingerprint.checksum ||
      actor.observationSequence !== request.observationSequence
    ) {
      return null;
    }
    return Object.freeze({
      kind: 'external_file',
      fileWriterEpoch: request.fileWriterEpoch,
      observationSequence: request.observationSequence,
    });
  }
  if (
    request.registration.attributionPolicy !== 'verified_run_evidence' ||
    !isCoordinationIdentifier(actor.runId) ||
    !isPositiveSafeInteger(actor.runGeneration) ||
    (actor.memberId !== null && !isCoordinationIdentifier(actor.memberId)) ||
    !isCoordinationIdentifier(actor.evidenceRef)
  ) {
    return null;
  }
  return Object.freeze({
    kind: 'verified_run',
    runId: actor.runId,
    runGeneration: actor.runGeneration,
    memberId: actor.memberId,
    evidenceRef: actor.evidenceRef,
  });
}

function normalizeJsonValue(
  value: unknown,
  depth: number,
  budget: NormalizationBudget
): HostedTaskExternalWriterJsonValue | undefined {
  if (depth > MAX_TASK_DOCUMENT_DEPTH || budget.nodes >= MAX_TASK_DOCUMENT_NODES) return undefined;
  budget.nodes += 1;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const normalized: HostedTaskExternalWriterJsonValue[] = [];
    for (const child of value) {
      const parsed = normalizeJsonValue(child, depth + 1, budget);
      if (parsed === undefined) return undefined;
      normalized.push(parsed);
    }
    return Object.freeze(normalized);
  }
  if (!value || typeof value !== 'object') return undefined;

  const source = value as Record<string, unknown>;
  const normalized = Object.create(null) as Record<string, HostedTaskExternalWriterJsonValue>;
  for (const key of Object.keys(source)) {
    if (key.length === 0 || key.length > MAX_TASK_DOCUMENT_KEY_LENGTH) return undefined;
    const parsed = normalizeJsonValue(source[key], depth + 1, budget);
    if (parsed === undefined) return undefined;
    Object.defineProperty(normalized, key, {
      value: parsed,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(normalized);
}

function isJsonObject(
  value: HostedTaskExternalWriterJsonValue
): value is HostedTaskExternalWriterJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function taskIdFromDocument(document: HostedTaskExternalWriterJsonObject): string | null {
  const value = document.id;
  const taskId =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : '';
  return taskId.length > 0 && taskId.length <= MAX_TASK_ID_LENGTH ? taskId : null;
}

function parseTaskDocument(
  content: Uint8Array | null,
  expectedTaskId: string
): HostedTaskExternalWriterEffect | null {
  if (content === null) return Object.freeze({ kind: 'missing', taskId: expectedTaskId });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)) as unknown;
  } catch {
    return null;
  }
  const document = normalizeJsonValue(parsed, 0, { nodes: 0 });
  if (
    document === undefined ||
    !isJsonObject(document) ||
    taskIdFromDocument(document) !== expectedTaskId
  ) {
    return null;
  }
  return Object.freeze({
    kind: 'observed',
    document: Object.freeze({ taskId: expectedTaskId, document }),
  });
}

function coordinationActor(actor: HostedTaskExternalWriterActor): CoordinationEventActor {
  return actor.kind === 'external_file'
    ? Object.freeze({
        kind: 'external_file',
        fileWriterEpoch: actor.fileWriterEpoch,
        observationSequence: actor.observationSequence,
      })
    : Object.freeze({
        kind: 'verified_runtime',
        actorRef: actor.evidenceRef,
        runId: actor.runId,
        ...(actor.memberId === null ? {} : { memberId: actor.memberId }),
      });
}

function validTimestamp(value: string): boolean {
  return (
    value.length > 0 && value.length <= 64 && Number.isFinite(Date.parse(value)) && /T/.test(value)
  );
}

function isCommittedChange(
  value: HostedTaskExternalWriterCommittedChange
): value is HostedTaskExternalWriterCommittedChange {
  return (
    isNonNegativeSafeInteger(value.sourceGeneration) &&
    isNonNegativeSafeInteger(value.featureRevision)
  );
}

/**
 * Converts catalogued task JSON observations into a narrow, idempotent domain
 * effect. It never infers a run or member from JSON and never invokes a task
 * lifecycle or runtime command.
 */
export class HostedTaskExternalWriterReconciler implements ExternalFileReconciliationPort {
  constructor(private readonly authority: HostedTaskExternalWriterAuthority) {}

  getResult(reconciliationId: string): Promise<ExternalFileReconciliationResult | null> {
    return isReconciliationId(reconciliationId)
      ? this.authority.getResult(reconciliationId)
      : Promise.resolve(null);
  }

  async reconcile(
    request: ExternalFileReconciliationRequest
  ): Promise<ExternalFileReconciliationResult> {
    if (
      request.registration.scope.featureKey !== HOSTED_TASK_EXTERNAL_WRITER_FEATURE_KEY ||
      !isReconciliationId(request.reconciliationId) ||
      !isCoordinationIdentifier(request.registration.scope.teamId) ||
      !isBoundedString(request.registration.fileKey) ||
      !isPositiveSafeInteger(request.fileWriterEpoch) ||
      !isPositiveSafeInteger(request.observationSequence) ||
      !validFingerprint(request.fingerprint) ||
      !sourceIsConsistent(request)
    ) {
      return invalid('external_task_reconciliation_invalid');
    }
    const actor = toActor(request);
    if (actor === null) return invalid('external_task_attribution_invalid');

    const target = await this.authority.resolveTaskTarget({
      teamId: request.registration.scope.teamId,
      fileKey: request.registration.fileKey,
    });
    if (
      !target ||
      !isCoordinationIdentifier(target.taskId) ||
      target.taskId.length > MAX_TASK_ID_LENGTH
    ) {
      return invalid('task_file_unregistered');
    }
    if (!isWorkspaceId(target.workspaceId)) return invalid('task_file_workspace_unbound');
    const { taskId, workspaceId } = target;
    const effect = parseTaskDocument(request.content, taskId);
    if (effect === null) return invalid('task_file_document_invalid');

    const eventType =
      effect.kind === 'observed'
        ? ('team.task.external_file_observed' as const)
        : ('team.task.external_file_missing' as const);
    const observation = Object.freeze({
      teamId: request.registration.scope.teamId,
      fileKey: request.registration.fileKey,
      fingerprint: copyFingerprint(request.fingerprint),
      fileWriterEpoch: request.fileWriterEpoch,
      observationSequence: request.observationSequence,
      actor,
    });
    const eventActor = coordinationActor(actor);
    return this.authority.commit(
      Object.freeze({
        reconciliationId: request.reconciliationId,
        observation,
        effect,
        buildCommittedCoordinationEvent: (committed: HostedTaskExternalWriterCommittedChange) => {
          if (!isCommittedChange(committed)) {
            throw new TypeError('hosted-task-external-writer-committed-change-invalid');
          }
          const eventId = this.authority.createEventId({
            reconciliationId: request.reconciliationId,
            eventType,
          });
          const emittedAt = this.authority.nowIso();
          if (!isCoordinationIdentifier(eventId) || !validTimestamp(emittedAt)) {
            throw new TypeError('hosted-task-external-writer-event-identity-invalid');
          }
          return Object.freeze({
            trustedContext: Object.freeze({
              actor: eventActor,
              ...(actor.kind === 'verified_run' ? { runId: actor.runId } : {}),
            }),
            draft: Object.freeze({
              schemaVersion: COORDINATION_EVENT_SCHEMA_VERSION,
              eventId,
              scope: Object.freeze({ kind: 'team', scopeId: request.registration.scope.teamId }),
              workspaceId,
              teamId: request.registration.scope.teamId,
              eventType,
              resourceRevision: Object.freeze({
                resourceKey: `task:${taskId}`,
                generation: committed.sourceGeneration,
                revision: committed.featureRevision,
              }),
              emittedAt,
              payload: Object.freeze({
                reconciliationId: request.reconciliationId,
                fileKey: request.registration.fileKey,
                taskId,
                contentChecksum: request.fingerprint.checksum,
                effect: effect.kind === 'observed' ? 'observed' : 'missing',
                actorKind: actor.kind,
                ...(actor.kind === 'verified_run' ? { runGeneration: actor.runGeneration } : {}),
              }) satisfies CoordinationJsonValue,
            }),
          });
        },
      })
    );
  }

  /** Register before an app-owned write becomes observable; the observer fences stale epochs. */
  recordAppWrite(
    observer: Pick<ExternalWriterObserver, 'recordSelfWriteIntent'>,
    input: HostedTaskExternalWriterSelfWrite
  ): Promise<void> {
    if (
      !isBoundedString(input.intentId) ||
      !isCoordinationIdentifier(input.teamId) ||
      !isBoundedString(input.fileKey) ||
      (input.expectedChecksum !== null && !isBoundedString(input.expectedChecksum)) ||
      !isNonNegativeSafeInteger(input.sourceGeneration) ||
      !isPositiveSafeInteger(input.fileWriterEpoch) ||
      !Number.isFinite(input.expiresAtMs)
    ) {
      return Promise.reject(new TypeError('hosted-task-external-writer-self-write-invalid'));
    }
    return observer.recordSelfWriteIntent(
      Object.freeze({
        intentId: input.intentId,
        scope: Object.freeze({
          teamId: input.teamId,
          featureKey: HOSTED_TASK_EXTERNAL_WRITER_FEATURE_KEY,
        }),
        fileKey: input.fileKey,
        expectedChecksum: input.expectedChecksum,
        sourceGeneration: input.sourceGeneration,
        fileWriterEpoch: input.fileWriterEpoch,
        expiresAtMs: input.expiresAtMs,
      }) satisfies ExternalSelfWriteIntent
    );
  }
}

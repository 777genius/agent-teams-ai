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

export const HOSTED_MESSAGE_EXTERNAL_WRITER_FEATURE_KEY = 'inboxes' as const;

const MAX_COORDINATION_IDENTIFIER_LENGTH = 256;
const MAX_EXTERNAL_VALUE_LENGTH = 1_024;
const MAX_RECONCILIATION_ID_LENGTH = 4 * MAX_EXTERNAL_VALUE_LENGTH + 128;
const MAX_INBOX_ID_LENGTH = 240;
const MAX_MESSAGE_ID_LENGTH = 512;
const MAX_MESSAGE_FIELD_LENGTH = 512 * 1_024;
const MAX_MESSAGES_PER_FILE = 10_000;
const MAX_TASK_REFS_PER_MESSAGE = 1_000;

export interface HostedMessageExternalWriterTaskRef {
  readonly taskId: string;
  readonly displayId: string;
  readonly teamName: string;
}

export interface HostedMessageExternalWriterMessage {
  readonly messageId: string;
  /** File-provided recipient fields are ignored; the catalog identity supplies this value. */
  readonly recipient: string;
  readonly from: string;
  readonly text: string;
  readonly timestamp: string;
  readonly read: boolean;
  readonly summary?: string;
  readonly taskRefs?: readonly HostedMessageExternalWriterTaskRef[];
}

export interface HostedMessageExternalWriterDocument {
  readonly inboxId: string;
  readonly messages: readonly HostedMessageExternalWriterMessage[];
}

export type HostedMessageExternalWriterEffect =
  | { readonly kind: 'observed'; readonly document: HostedMessageExternalWriterDocument }
  | { readonly kind: 'missing'; readonly inboxId: string };

export type HostedMessageExternalWriterActor =
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

export interface HostedMessageExternalWriterObservation {
  readonly teamId: TeamId;
  readonly fileKey: string;
  readonly fingerprint: ExternalFileSourceFingerprint;
  readonly fileWriterEpoch: number;
  readonly observationSequence: number;
  readonly actor: HostedMessageExternalWriterActor;
}

/** Canonical target identity resolved by the integration, never from file JSON. */
export interface HostedMessageExternalWriterTarget {
  readonly workspaceId: WorkspaceId;
  readonly inboxId: string;
}

/** The accepted resource coordinates allocated by the authority's commit. */
export interface HostedMessageExternalWriterCommittedChange {
  readonly sourceGeneration: number;
  readonly featureRevision: number;
}

export interface HostedMessageExternalWriterReconciliationCommit {
  readonly reconciliationId: string;
  readonly observation: HostedMessageExternalWriterObservation;
  readonly effect: HostedMessageExternalWriterEffect;
  /**
   * Invoke only for a newly accepted effect after the authority has allocated
   * the committed resource coordinates. The returned handoff is persisted with
   * that effect/result; an idempotent replay, conflict, or noop never invokes
   * this factory.
   */
  readonly buildCommittedCoordinationEvent: (
    committed: HostedMessageExternalWriterCommittedChange
  ) => PublishCoordinationEventCommand;
}

/**
 * The integration-owned transaction resolves the catalog identity, fences the
 * current writer epoch and verified-run generation, then atomically stores the
 * idempotency result, message effect, and accepted-change journal handoff.
 * It intentionally exposes no runtime delivery or lifecycle capability.
 */
export interface HostedMessageExternalWriterAuthority {
  /** Resolves the inbox and its hosted workspace together under authority control. */
  resolveInboxTarget(input: {
    readonly teamId: TeamId;
    readonly fileKey: string;
  }): Promise<HostedMessageExternalWriterTarget | null>;
  deriveLegacyMessageId(input: {
    readonly from: string;
    readonly timestamp: string;
    readonly text: string;
  }): string;
  createEventId(input: {
    readonly reconciliationId: string;
    readonly eventType:
      | 'team.message.external_inbox_observed'
      | 'team.message.external_inbox_missing';
  }): string;
  nowIso(): string;
  getResult(reconciliationId: string): Promise<ExternalFileReconciliationResult | null>;
  commit(
    input: HostedMessageExternalWriterReconciliationCommit
  ): Promise<ExternalFileReconciliationResult>;
}

export interface HostedMessageExternalWriterSelfWrite {
  readonly intentId: string;
  readonly teamId: TeamId;
  readonly fileKey: string;
  readonly expectedChecksum: string | null;
  readonly sourceGeneration: number;
  readonly fileWriterEpoch: number;
  readonly expiresAtMs: number;
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

function toActor(
  request: ExternalFileReconciliationRequest
): HostedMessageExternalWriterActor | null {
  const actor = request.actor;
  if (actor.teamId !== request.registration.scope.teamId) return null;
  if (actor.kind === 'external_file') {
    if (
      actor.featureKey !== HOSTED_MESSAGE_EXTERNAL_WRITER_FEATURE_KEY ||
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

function boundedText(value: unknown, maximum = MAX_MESSAGE_FIELD_LENGTH): string | null {
  return typeof value === 'string' && value.length <= maximum ? value : null;
}

function boundedIdentifier(value: unknown, maximum = MAX_MESSAGE_ID_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function parseTaskRefs(value: unknown): readonly HostedMessageExternalWriterTaskRef[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_TASK_REFS_PER_MESSAGE) return undefined;
  const taskRefs: HostedMessageExternalWriterTaskRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const taskId = boundedIdentifier(record.taskId);
    const displayId = boundedIdentifier(record.displayId);
    const teamName = boundedIdentifier(record.teamName);
    if (taskId && displayId && teamName) {
      taskRefs.push(Object.freeze({ taskId, displayId, teamName }));
    }
  }
  return taskRefs.length > 0 ? Object.freeze(taskRefs) : undefined;
}

function sameTaskRefs(
  left: readonly HostedMessageExternalWriterTaskRef[] | undefined,
  right: readonly HostedMessageExternalWriterTaskRef[] | undefined
): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.length === right.length &&
      left.every(
        (entry, index) =>
          entry.taskId === right[index]?.taskId &&
          entry.displayId === right[index]?.displayId &&
          entry.teamName === right[index]?.teamName
      ))
  );
}

function sameMessage(
  left: HostedMessageExternalWriterMessage,
  right: HostedMessageExternalWriterMessage
): boolean {
  return (
    left.messageId === right.messageId &&
    left.recipient === right.recipient &&
    left.from === right.from &&
    left.text === right.text &&
    left.timestamp === right.timestamp &&
    left.read === right.read &&
    left.summary === right.summary &&
    sameTaskRefs(left.taskRefs, right.taskRefs)
  );
}

function parseMessage(input: {
  readonly value: unknown;
  readonly recipient: string;
  readonly authority: HostedMessageExternalWriterAuthority;
}): HostedMessageExternalWriterMessage | null {
  if (!input.value || typeof input.value !== 'object' || Array.isArray(input.value)) return null;
  const record = input.value as Record<string, unknown>;
  const from = boundedText(record.from);
  const text = boundedText(record.text);
  const timestamp = boundedText(record.timestamp);
  if (from === null || text === null || timestamp === null) return null;
  const explicitMessageId =
    record.messageId === undefined ? null : boundedIdentifier(record.messageId);
  if (record.messageId !== undefined && explicitMessageId === null) return null;
  const messageId =
    explicitMessageId ??
    boundedIdentifier(input.authority.deriveLegacyMessageId({ from, timestamp, text }));
  if (messageId === null) return null;
  const summary = record.summary === undefined ? undefined : boundedText(record.summary);
  if (summary === null) return null;
  const taskRefs = parseTaskRefs(record.taskRefs);
  return Object.freeze({
    messageId,
    recipient: input.recipient,
    from,
    text,
    timestamp,
    read: typeof record.read === 'boolean' ? record.read : false,
    ...(summary === undefined ? {} : { summary }),
    ...(taskRefs === undefined ? {} : { taskRefs }),
  });
}

type ParsedDocument =
  | { readonly ok: true; readonly effect: HostedMessageExternalWriterEffect }
  | { readonly ok: false; readonly diagnosticCode: string };

function parseDocument(
  content: Uint8Array | null,
  inboxId: string,
  authority: HostedMessageExternalWriterAuthority
): ParsedDocument {
  if (content === null) {
    return Object.freeze({ ok: true, effect: Object.freeze({ kind: 'missing', inboxId }) });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)) as unknown;
  } catch {
    return Object.freeze({ ok: false, diagnosticCode: 'inbox_file_json_invalid' });
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_MESSAGES_PER_FILE) {
    return Object.freeze({ ok: false, diagnosticCode: 'inbox_file_document_invalid' });
  }
  const byMessageId = new Map<string, HostedMessageExternalWriterMessage>();
  const messages: HostedMessageExternalWriterMessage[] = [];
  for (const value of parsed) {
    const message = parseMessage({ value, recipient: inboxId, authority });
    if (message === null) {
      return Object.freeze({ ok: false, diagnosticCode: 'inbox_file_message_invalid' });
    }
    const prior = byMessageId.get(message.messageId);
    if (prior) {
      if (!sameMessage(prior, message)) {
        return Object.freeze({
          ok: false,
          diagnosticCode: 'inbox_file_duplicate_message_conflict',
        });
      }
      continue;
    }
    byMessageId.set(message.messageId, message);
    messages.push(message);
  }
  return Object.freeze({
    ok: true,
    effect: Object.freeze({
      kind: 'observed',
      document: Object.freeze({ inboxId, messages: Object.freeze(messages) }),
    }),
  });
}

function coordinationActor(actor: HostedMessageExternalWriterActor): CoordinationEventActor {
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
    value.length > 0 &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value)) &&
    value.includes('T')
  );
}

function isCommittedChange(
  value: HostedMessageExternalWriterCommittedChange
): value is HostedMessageExternalWriterCommittedChange {
  return (
    isNonNegativeSafeInteger(value.sourceGeneration) &&
    isNonNegativeSafeInteger(value.featureRevision)
  );
}

/**
 * Converts catalogued inbox JSON into display-safe message effects. File data
 * cannot claim a recipient, source, run, member, or provider attribution.
 */
export class HostedMessageExternalWriterReconciler implements ExternalFileReconciliationPort {
  constructor(private readonly authority: HostedMessageExternalWriterAuthority) {}

  getResult(reconciliationId: string): Promise<ExternalFileReconciliationResult | null> {
    return isReconciliationId(reconciliationId)
      ? this.authority.getResult(reconciliationId)
      : Promise.resolve(null);
  }

  async reconcile(
    request: ExternalFileReconciliationRequest
  ): Promise<ExternalFileReconciliationResult> {
    if (
      request.registration.scope.featureKey !== HOSTED_MESSAGE_EXTERNAL_WRITER_FEATURE_KEY ||
      !isReconciliationId(request.reconciliationId) ||
      !isCoordinationIdentifier(request.registration.scope.teamId) ||
      !isBoundedString(request.registration.fileKey) ||
      !isPositiveSafeInteger(request.fileWriterEpoch) ||
      !isPositiveSafeInteger(request.observationSequence) ||
      !validFingerprint(request.fingerprint) ||
      !sourceIsConsistent(request)
    ) {
      return invalid('external_inbox_reconciliation_invalid');
    }
    const actor = toActor(request);
    if (actor === null) return invalid('external_inbox_attribution_invalid');

    const target = await this.authority.resolveInboxTarget({
      teamId: request.registration.scope.teamId,
      fileKey: request.registration.fileKey,
    });
    if (
      !target ||
      !isCoordinationIdentifier(target.inboxId) ||
      target.inboxId.length > MAX_INBOX_ID_LENGTH
    ) {
      return invalid('inbox_file_unregistered');
    }
    if (!isWorkspaceId(target.workspaceId)) return invalid('inbox_file_workspace_unbound');
    const { inboxId, workspaceId } = target;
    const parsed = parseDocument(request.content, inboxId, this.authority);
    if (!parsed.ok) return invalid(parsed.diagnosticCode);
    const { effect } = parsed;

    const eventType =
      effect.kind === 'observed'
        ? ('team.message.external_inbox_observed' as const)
        : ('team.message.external_inbox_missing' as const);
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
        buildCommittedCoordinationEvent: (
          committed: HostedMessageExternalWriterCommittedChange
        ) => {
          if (!isCommittedChange(committed)) {
            throw new TypeError('hosted-message-external-writer-committed-change-invalid');
          }
          const eventId = this.authority.createEventId({
            reconciliationId: request.reconciliationId,
            eventType,
          });
          const emittedAt = this.authority.nowIso();
          if (!isCoordinationIdentifier(eventId) || !validTimestamp(emittedAt)) {
            throw new TypeError('hosted-message-external-writer-event-identity-invalid');
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
                resourceKey: `inbox:${inboxId}`,
                generation: committed.sourceGeneration,
                revision: committed.featureRevision,
              }),
              emittedAt,
              payload: Object.freeze({
                reconciliationId: request.reconciliationId,
                fileKey: request.registration.fileKey,
                inboxId,
                contentChecksum: request.fingerprint.checksum,
                effect: effect.kind === 'observed' ? 'observed' : 'missing',
                messageCount: effect.kind === 'observed' ? effect.document.messages.length : 0,
                actorKind: actor.kind,
                ...(actor.kind === 'verified_run' ? { runGeneration: actor.runGeneration } : {}),
              }) satisfies CoordinationJsonValue,
            }),
          });
        },
      })
    );
  }

  /** Register before an app-owned inbox write becomes observable. */
  recordAppWrite(
    observer: Pick<ExternalWriterObserver, 'recordSelfWriteIntent'>,
    input: HostedMessageExternalWriterSelfWrite
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
      return Promise.reject(new TypeError('hosted-message-external-writer-self-write-invalid'));
    }
    return observer.recordSelfWriteIntent(
      Object.freeze({
        intentId: input.intentId,
        scope: Object.freeze({
          teamId: input.teamId,
          featureKey: HOSTED_MESSAGE_EXTERNAL_WRITER_FEATURE_KEY,
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

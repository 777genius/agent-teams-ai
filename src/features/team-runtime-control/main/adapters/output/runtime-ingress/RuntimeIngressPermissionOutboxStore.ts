import { RUNTIME_INGRESS_BEARER_MIN_LENGTH } from '../../../../contracts/runtime-ingress-http';
import {
  parseRuntimePermissionApprovalPayload,
  type RuntimePermissionApprovalIngressAuthority,
} from '../../../../contracts/runtimePermissionApproval';
import {
  areRuntimeIngressPermissionOutboxIntentsExact,
  isRuntimeIngressPermissionOutboxAcknowledgeRequest,
  isRuntimeIngressPermissionOutboxClaimRequest,
  isRuntimeIngressPermissionOutboxRecord,
  RUNTIME_INGRESS_PERMISSION_OUTBOX_MAX_LEASE_DURATION_MS,
  type RuntimeIngressPermissionOutboxAcknowledgeRequest,
  type RuntimeIngressPermissionOutboxAcknowledgeResult,
  type RuntimeIngressPermissionOutboxClaimRequest,
  type RuntimeIngressPermissionOutboxClockPort,
  type RuntimeIngressPermissionOutboxPort,
  type RuntimeIngressPermissionOutboxRecord,
  type RuntimeIngressRelayAuthority,
  type RuntimeIngressRelayBinding,
} from '../../../../core/application/runtime-ingress';
import {
  isRuntimeIngressSessionStateRecoverable,
  isSessionBoundToCredential,
  issueRuntimeIngressCredential,
} from '../../../../core/domain/runtime-ingress';

import type { RuntimePlanRef } from '../../../../core/application/ports';
import type { ApplyRuntimeIngressAtomicallyRequest } from '../../../../core/application/runtime-ingress';
import type {
  PresentedRuntimeIngressCredential,
  RuntimeIngressCredential,
  RuntimeIngressCredentialScope,
  RuntimeIngressSessionId,
  RuntimeIngressSessionState,
} from '../../../../core/domain/runtime-ingress';
import type {
  RuntimeIngressReplayCompactionEvidence,
  RuntimeIngressSnapshot,
  RuntimeIngressSnapshotRetentionLimits,
} from './runtimeIngressDurableState';

interface RuntimeIngressPermissionOutboxPersistence {
  exclusive<T extends { readonly status: string }>(operation: () => Promise<T>): Promise<T>;
  loadSnapshot(): Promise<RuntimeIngressSnapshot>;
  persistSnapshot(snapshot: RuntimeIngressSnapshot): Promise<void>;
}

export interface RuntimeIngressPermissionOutboxStoreOptions {
  readonly clock?: RuntimeIngressPermissionOutboxClockPort;
}

const SYSTEM_CLOCK: RuntimeIngressPermissionOutboxClockPort = Object.freeze({ now: Date.now });

function currentTime(clock: RuntimeIngressPermissionOutboxClockPort): number | null {
  try {
    const value = clock.now();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function toIso(value: number): string | null {
  try {
    const iso = new Date(value).toISOString();
    return Date.parse(iso) === value ? iso : null;
  } catch {
    return null;
  }
}

function assertReadableOutboxLeaseState(snapshot: RuntimeIngressSnapshot, now: number): void {
  const latestAllowedLeaseExpiry = now + RUNTIME_INGRESS_PERMISSION_OUTBOX_MAX_LEASE_DURATION_MS;
  if (!Number.isSafeInteger(latestAllowedLeaseExpiry)) {
    throw new Error('runtime-ingress-permission-outbox-clock-invalid');
  }
  for (const record of permissionOutbox(snapshot)) {
    if (!isRuntimeIngressPermissionOutboxRecord(record)) {
      throw new Error('runtime-ingress-permission-outbox-record-invalid');
    }
    if (record.acknowledgedAtIso !== null || record.lease === null) continue;
    const claimedAtMs = Date.parse(record.lease.claimedAtIso);
    const leaseExpiresAtMs = Date.parse(record.lease.leaseExpiresAtIso);
    if (claimedAtMs > now || leaseExpiresAtMs > latestAllowedLeaseExpiry) {
      throw new Error('runtime-ingress-permission-outbox-clock-skew');
    }
  }
}

function isClaimedBy(
  record: RuntimeIngressPermissionOutboxRecord,
  request: RuntimeIngressPermissionOutboxClaimRequest,
  now: number
): boolean {
  const lease = record.lease;
  return (
    lease !== null &&
    lease.ownerId === request.ownerId &&
    lease.leaseToken === request.leaseToken &&
    Date.parse(lease.leaseExpiresAtIso) > now
  );
}

function canClaim(record: RuntimeIngressPermissionOutboxRecord, now: number): boolean {
  return (
    record.acknowledgedAtIso === null &&
    (record.lease === null || Date.parse(record.lease.leaseExpiresAtIso) <= now)
  );
}

function orderRecords(
  records: readonly RuntimeIngressPermissionOutboxRecord[]
): RuntimeIngressPermissionOutboxRecord[] {
  return [...records].sort((left, right) => {
    const accepted = left.acceptedAtIso.localeCompare(right.acceptedAtIso);
    return accepted === 0 ? left.outboxId.localeCompare(right.outboxId) : accepted;
  });
}

function permissionOutbox(
  snapshot: RuntimeIngressSnapshot
): readonly RuntimeIngressPermissionOutboxRecord[] {
  return snapshot.permissionApprovalOutbox ?? [];
}

export type RuntimeIngressPermissionOutboxBindingResult =
  | {
      readonly status: 'bound';
      readonly records: readonly RuntimeIngressPermissionOutboxRecord[];
    }
  | { readonly status: 'duplicate'; readonly command: RuntimeIngressSnapshot['commands'][number] }
  | { readonly status: 'conflict' };

/** Binds a provider delivery ref while the ingress snapshot lock is held. */
export function bindRuntimeIngressPermissionOutboxRecord(
  snapshot: RuntimeIngressSnapshot,
  record: RuntimeIngressPermissionOutboxRecord
): RuntimeIngressPermissionOutboxBindingResult {
  const existing = permissionOutbox(snapshot).find(
    (item) => item.deliveryRef === record.deliveryRef
  );
  if (!existing) {
    return Object.freeze({
      status: 'bound',
      records: Object.freeze([...permissionOutbox(snapshot), record]),
    });
  }
  if (!areRuntimeIngressPermissionOutboxIntentsExact(existing, record)) {
    return Object.freeze({ status: 'conflict' });
  }
  const commands = snapshot.commands.filter((item) => item.commandId === record.commandId);
  return commands.length === 1 && commands[0]?.state === 'committed'
    ? Object.freeze({ status: 'duplicate', command: commands[0] })
    : Object.freeze({ status: 'conflict' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isExactIngressAuthority(
  value: unknown,
  record: RuntimeIngressPermissionOutboxRecord
): boolean {
  const authority = record.authority;
  return (
    isRecord(value) &&
    value.deploymentId === authority.deploymentId &&
    value.teamId === authority.teamId &&
    value.runId === authority.runId &&
    value.planGeneration === authority.planGeneration &&
    value.laneId === authority.laneId &&
    value.providerId === authority.providerId &&
    value.credentialGeneration === authority.credentialGeneration &&
    value.verb === 'runtime.permission-request'
  );
}

function isExactClaimScope(value: unknown, record: RuntimeIngressPermissionOutboxRecord): boolean {
  const authority = record.authority;
  return (
    hasExactKeys(value, ['deploymentId', 'stableActorId', 'commandKind', 'idempotencyKey']) &&
    value.deploymentId === authority.deploymentId &&
    value.stableActorId ===
      JSON.stringify([
        authority.teamId,
        authority.runId,
        authority.laneId,
        authority.providerId,
        authority.sessionId,
      ]) &&
    value.commandKind === 'runtime.permission-request' &&
    value.idempotencyKey === record.commandId
  );
}

function isExactReplayKey(value: unknown, record: RuntimeIngressPermissionOutboxRecord): boolean {
  const authority = record.authority;
  return (
    isRecord(value) &&
    isExactIngressAuthority(value.authority, record) &&
    value.credentialId === authority.credentialId &&
    value.sessionId === authority.sessionId &&
    value.runtimeInstanceId === authority.runtimeInstanceId &&
    value.deliveryOwnerId === authority.deliveryOwnerId &&
    value.commandId === record.commandId &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) > 0 &&
    value.observedAtIso === record.observedAtIso
  );
}

function parseAcknowledgement(
  command: Record<string, unknown>,
  record: RuntimeIngressPermissionOutboxRecord,
  fingerprint: Record<string, unknown>
): Record<string, unknown> | null {
  if (typeof command.outcomeJson !== 'string' || typeof fingerprint.digest !== 'string')
    return null;
  try {
    const acknowledgement = JSON.parse(command.outcomeJson) as unknown;
    return isRecord(acknowledgement) &&
      acknowledgement.acknowledgementVersion === 1 &&
      acknowledgement.acknowledgementId === `ack:${fingerprint.digest}` &&
      acknowledgement.effectRef === record.effectRef &&
      acknowledgement.acceptedAtIso === record.acceptedAtIso &&
      isExactReplayKey(acknowledgement.replayKey, record)
      ? acknowledgement
      : null;
  } catch {
    return null;
  }
}

function joinsCommittedPermissionEffect(
  snapshot: RuntimeIngressSnapshot,
  record: RuntimeIngressPermissionOutboxRecord
): boolean {
  const commands = [...snapshot.commands, ...snapshot.replayCompaction.retainedCommands].filter(
    (item) => item.commandId === record.commandId
  );
  const command = commands[0];
  if (
    commands.length !== 1 ||
    !command ||
    !snapshot.commands.includes(command) ||
    !isRecord(command) ||
    command.commandId !== record.commandId ||
    command.state !== 'committed' ||
    command.auditSessionId !== record.authority.sessionId ||
    command.createdAt !== record.acceptedAtIso ||
    command.updatedAt !== record.acceptedAtIso ||
    command.committedAt !== record.acceptedAtIso ||
    command.errorCode !== null ||
    command.errorJson !== null ||
    !hasExactKeys(command.claim, ['scope', 'fingerprint']) ||
    !isExactClaimScope(command.claim.scope, record) ||
    !isRecord(command.claim.fingerprint) ||
    typeof command.claim.fingerprint.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(command.claim.fingerprint.digest) ||
    record.effectRef !== `effect:${command.claim.fingerprint.digest}` ||
    !isRecord(command.descriptor) ||
    command.descriptor.commandKind !== 'runtime.permission-request'
  ) {
    return false;
  }
  const acknowledgement = parseAcknowledgement(command, record, command.claim.fingerprint);
  const effect = snapshot.effects.filter(
    (item) => item.claimKey === claimKey(command.claim.scope as Parameters<typeof claimKey>[0])
  );
  return (
    acknowledgement !== null &&
    effect.length === 1 &&
    isRecord(effect[0]) &&
    effect[0].claimKey === claimKey(command.claim.scope as Parameters<typeof claimKey>[0]) &&
    isExactIngressAuthority(effect[0].authority, record) &&
    effect[0].acknowledgementId === acknowledgement.acknowledgementId &&
    effect[0].payloadJson === record.payloadJson &&
    effect[0].appliedAtIso === record.acceptedAtIso
  );
}

/** Rejects an unacknowledged row unless it still proves one exact committed ingress effect. */
export function assertRuntimeIngressPermissionOutboxIntegrity(
  snapshot: RuntimeIngressSnapshot
): void {
  if (
    permissionOutbox(snapshot).some(
      (record) =>
        record.acknowledgedAtIso === null && !joinsCommittedPermissionEffect(snapshot, record)
    )
  ) {
    throw new Error('runtime-ingress-permission-outbox-integrity');
  }
}

/**
 * File-store collaborator for the durable permission ingress-effect outbox.
 * It only reads and writes the already locked runtime-ingress snapshot; it
 * never invokes approval storage, provider APIs, or process lifecycle code.
 */
export class RuntimeIngressPermissionOutboxStore implements RuntimeIngressPermissionOutboxPort {
  private readonly clock: RuntimeIngressPermissionOutboxClockPort;

  constructor(
    private readonly persistence: RuntimeIngressPermissionOutboxPersistence,
    options: RuntimeIngressPermissionOutboxStoreOptions = {}
  ) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  async claimPermissionApprovalIngressEffects(
    request: RuntimeIngressPermissionOutboxClaimRequest
  ): Promise<readonly RuntimeIngressPermissionOutboxRecord[]> {
    if (!isRuntimeIngressPermissionOutboxClaimRequest(request)) return Object.freeze([]);
    return this.persistence
      .exclusive(async () => {
        try {
          const claimedAtMs = currentTime(this.clock);
          if (claimedAtMs === null) {
            return { status: 'unavailable' as const, records: Object.freeze([]) };
          }
          const leaseExpiresAtMs = claimedAtMs + request.leaseDurationMs;
          const claimedAtIso = toIso(claimedAtMs);
          const leaseExpiresAtIso = toIso(leaseExpiresAtMs);
          if (
            !Number.isSafeInteger(leaseExpiresAtMs) ||
            leaseExpiresAtIso === null ||
            claimedAtIso === null
          ) {
            return { status: 'unavailable' as const, records: Object.freeze([]) };
          }
          const current = await this.persistence.loadSnapshot();
          assertReadableOutboxLeaseState(current, claimedAtMs);
          const ordered = orderRecords(permissionOutbox(current));
          const claimed: RuntimeIngressPermissionOutboxRecord[] = [];
          const next = ordered.map((record) => {
            if (claimed.length >= request.limit || record.acknowledgedAtIso !== null) return record;
            if (isClaimedBy(record, request, claimedAtMs)) {
              claimed.push(record);
              return record;
            }
            if (!canClaim(record, claimedAtMs)) return record;
            const lease = Object.freeze({
              generation: (record.lease?.generation ?? 0) + 1,
              ownerId: request.ownerId,
              leaseToken: request.leaseToken,
              claimedAtIso,
              leaseExpiresAtIso,
            });
            const updated = Object.freeze({ ...record, lease });
            claimed.push(updated);
            return updated;
          });
          const changed = next.some((record, index) => record !== ordered[index]);
          if (changed) {
            await this.persistence.persistSnapshot({
              ...current,
              permissionApprovalOutbox: Object.freeze(next),
            });
          }
          return { status: 'claimed' as const, records: Object.freeze(claimed) };
        } catch {
          return { status: 'unavailable' as const, records: Object.freeze([]) };
        }
      })
      .then((result) => result.records);
  }

  async acknowledgePermissionApprovalIngressEffect(
    request: RuntimeIngressPermissionOutboxAcknowledgeRequest
  ): Promise<RuntimeIngressPermissionOutboxAcknowledgeResult> {
    if (!isRuntimeIngressPermissionOutboxAcknowledgeRequest(request)) {
      return Object.freeze({ status: 'conflict' });
    }
    return this.persistence.exclusive(async () => {
      try {
        const acknowledgedAtMs = currentTime(this.clock);
        const acknowledgedAtIso = acknowledgedAtMs === null ? null : toIso(acknowledgedAtMs);
        if (acknowledgedAtMs === null || acknowledgedAtIso === null) {
          return Object.freeze({ status: 'unavailable' as const });
        }
        const current = await this.persistence.loadSnapshot();
        assertReadableOutboxLeaseState(current, acknowledgedAtMs);
        const record = permissionOutbox(current).find((item) => item.outboxId === request.outboxId);
        if (!record) return Object.freeze({ status: 'conflict' as const });
        const lease = record.lease;
        const matches =
          lease !== null &&
          lease.generation === request.generation &&
          lease.ownerId === request.ownerId &&
          lease.leaseToken === request.leaseToken;
        if (record.acknowledgedAtIso !== null) {
          return Object.freeze({ status: matches ? 'already_acknowledged' : 'conflict' } as const);
        }
        if (!matches || acknowledgedAtMs >= Date.parse(lease.leaseExpiresAtIso)) {
          return Object.freeze({ status: 'conflict' as const });
        }
        const next = permissionOutbox(current).map((item) =>
          item.outboxId === request.outboxId ? Object.freeze({ ...item, acknowledgedAtIso }) : item
        );
        await this.persistence.persistSnapshot({
          ...current,
          permissionApprovalOutbox: Object.freeze(next),
        });
        return Object.freeze({ status: 'acknowledged' as const });
      } catch {
        return Object.freeze({ status: 'unavailable' as const });
      }
    });
  }
}

/** Creates an outbox record from the durable effect and the persisted scope. */
export function createRuntimeIngressPermissionOutboxRecord(input: {
  readonly request: ApplyRuntimeIngressAtomicallyRequest;
  readonly credential: RuntimeIngressCredential;
  readonly session: RuntimeIngressSessionState;
}): RuntimeIngressPermissionOutboxRecord {
  const { request, credential, session } = input;
  if (request.claimScope.commandKind !== 'runtime.permission-request') {
    throw new TypeError('runtime-permission-outbox-verb-invalid');
  }
  const replayKey = request.acknowledgement.replayKey;
  const authority: RuntimePermissionApprovalIngressAuthority = Object.freeze({
    deploymentId: credential.scope.deploymentId,
    teamId: credential.scope.teamId,
    runId: credential.scope.runId,
    planGeneration: credential.scope.planGeneration,
    laneId: credential.scope.laneId,
    providerId: credential.scope.providerId,
    credentialGeneration: credential.scope.credentialGeneration,
    credentialId: credential.credentialId,
    sessionId: credential.sessionId,
    runtimeInstanceId: replayKey.runtimeInstanceId,
    deliveryOwnerId: session.deliveryOwnerId,
  });
  if (
    replayKey.sessionId !== credential.sessionId ||
    replayKey.deliveryOwnerId !== session.deliveryOwnerId ||
    replayKey.authority.deploymentId !== authority.deploymentId ||
    replayKey.authority.teamId !== authority.teamId ||
    replayKey.authority.runId !== authority.runId ||
    replayKey.authority.planGeneration !== authority.planGeneration ||
    replayKey.authority.laneId !== authority.laneId ||
    replayKey.authority.providerId !== authority.providerId ||
    replayKey.authority.credentialGeneration !== authority.credentialGeneration ||
    replayKey.authority.verb !== 'runtime.permission-request'
  ) {
    throw new TypeError('runtime-permission-outbox-authority-invalid');
  }
  const payload = parseRuntimePermissionApprovalPayload(
    JSON.parse(request.effect.payloadJson) as unknown
  );
  return Object.freeze({
    outboxVersion: 1,
    outboxId: `runtime_permission:${request.acknowledgement.effectRef}`,
    commandId: replayKey.commandId,
    effectRef: request.acknowledgement.effectRef,
    deliveryRef: payload.deliveryRef,
    authority,
    payloadJson: request.effect.payloadJson,
    observedAtIso: replayKey.observedAtIso,
    acceptedAtIso: request.acknowledgement.acceptedAtIso,
    lease: null,
    acknowledgedAtIso: null,
  });
}

export interface BuildRuntimeIngressCredentialInput {
  readonly credentialId: RuntimeIngressCredential['credentialId'];
  readonly presentedSecret: PresentedRuntimeIngressCredential['secret'];
  readonly scope: RuntimeIngressCredentialScope;
  readonly planRef: RuntimePlanRef;
  readonly sessionId: RuntimeIngressSessionId;
  readonly issuedAtIso: string;
  readonly credentialDigestKeyVersion: number;
  readonly credentialDigestKey: Uint8Array;
  readonly digest: (key: Uint8Array, value: string) => string;
}

/** Shared file-store credential construction extracted from the 800-line adapter. */
export function buildRuntimeIngressCredential(
  input: BuildRuntimeIngressCredentialInput
): RuntimeIngressCredential {
  if (
    input.planRef.teamId !== input.scope.teamId ||
    input.planRef.runId !== input.scope.runId ||
    input.planRef.generation !== input.scope.planGeneration ||
    !/^sha256:[a-f0-9]{64}$/.test(input.planRef.planHash)
  ) {
    throw new TypeError('runtime-ingress-trusted-plan-binding-invalid');
  }
  if (input.presentedSecret.length < RUNTIME_INGRESS_BEARER_MIN_LENGTH) {
    throw new TypeError('runtime-ingress-presented-secret-entropy-invalid');
  }
  return issueRuntimeIngressCredential({
    credentialId: input.credentialId,
    secretDigest: `sha256:${input.digest(input.credentialDigestKey, input.presentedSecret)}`,
    secretDigestKeyVersion: input.credentialDigestKeyVersion,
    scope: input.scope,
    sessionId: input.sessionId,
    issuedAtIso: input.issuedAtIso,
  });
}

export function verifyPresentedRuntimeIngressCredential(input: {
  readonly snapshot: RuntimeIngressSnapshot;
  readonly presented: PresentedRuntimeIngressCredential;
  readonly activeKeyVersion: number;
  readonly credentialKeys: ReadonlyMap<number, Uint8Array>;
  readonly digest: (key: Uint8Array, value: string) => string;
  readonly constantTimeEqual: (left: string, right: string) => boolean;
}): RuntimeIngressCredential | null {
  const credential = input.snapshot.credentials.find(
    (candidate) => candidate.credentialId === input.presented.credentialId
  );
  const keyVersion = credential?.secretDigestKeyVersion ?? input.activeKeyVersion;
  const key = input.credentialKeys.get(keyVersion);
  if (!key) throw new Error('runtime-ingress-credential-key-unavailable');
  const presentedDigest = input.digest(key, input.presented.secret);
  const expectedDigest = credential?.secretDigest.slice('sha256:'.length) ?? '0'.repeat(64);
  return input.constantTimeEqual(presentedDigest, expectedDigest) && credential ? credential : null;
}

/** Snapshot-only read used by the file store after its lock is acquired. */
export function resolveRuntimeIngressCredentialContext(input: {
  readonly snapshot: RuntimeIngressSnapshot;
  readonly credential: RuntimeIngressCredential | null;
}):
  | {
      readonly status: 'resolved';
      readonly context: {
        readonly credential: RuntimeIngressCredential;
        readonly session: RuntimeIngressSessionState;
      };
    }
  | { readonly status: 'rejected' } {
  const credential = input.credential;
  if (!credential || credential.phase !== 'active') return { status: 'rejected' };
  const session = input.snapshot.sessions.find((item) => item.sessionId === credential.sessionId);
  if (
    !session ||
    !isRuntimeIngressSessionStateRecoverable(session) ||
    !isSessionBoundToCredential(session, credential)
  ) {
    return { status: 'rejected' };
  }
  return { status: 'resolved', context: { credential, session } };
}

function areVerbSetsExact(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((verb) => right.includes(verb)) &&
    right.every((verb) => left.includes(verb))
  );
}

function isRuntimePlanRefExact(left: RuntimePlanRef, right: RuntimePlanRef): boolean {
  return (
    left.teamId === right.teamId &&
    left.runId === right.runId &&
    left.generation === right.generation &&
    left.planHash === right.planHash
  );
}

/** Snapshot-only relay binding lookup extracted from the bounded file adapter. */
export function findRuntimeIngressRelayBindingFromSnapshot(input: {
  readonly snapshot: RuntimeIngressSnapshot;
  readonly authority: RuntimeIngressRelayAuthority;
}):
  | { readonly status: 'found'; readonly binding: RuntimeIngressRelayBinding }
  | { readonly status: 'missing' | 'ambiguous' } {
  const { authority, snapshot } = input;
  const matches = snapshot.credentials.filter(
    (credential) =>
      credential.phase === 'active' &&
      credential.scope.deploymentId === authority.deploymentId &&
      credential.scope.teamId === authority.planRef.teamId &&
      credential.scope.runId === authority.planRef.runId &&
      credential.scope.planGeneration === authority.planRef.generation &&
      credential.scope.laneId === authority.laneId &&
      credential.scope.providerId === authority.providerId &&
      credential.scope.credentialGeneration === authority.credentialGeneration &&
      areVerbSetsExact(credential.scope.allowedVerbs, authority.allowedVerbs)
  );
  if (matches.length !== 1) return { status: matches.length === 0 ? 'missing' : 'ambiguous' };
  const credential = matches[0];
  const session = snapshot.sessions.find((item) => item.sessionId === credential.sessionId);
  const planBinding = snapshot.planBindings.find(
    (item) => item.credentialId === credential.credentialId
  );
  if (
    !session ||
    !planBinding ||
    !isRuntimePlanRefExact(planBinding.planRef, authority.planRef) ||
    !authority.memberIds.includes(session.deliveryOwnerId) ||
    !isSessionBoundToCredential(session, credential)
  ) {
    return { status: 'missing' };
  }
  return { status: 'found', binding: { credential, session, planRef: planBinding.planRef } };
}

function fenceKey(scope: {
  readonly deploymentId: string;
  readonly teamId: string;
  readonly runId: string;
  readonly planGeneration: number;
  readonly laneId: string;
  readonly providerId: string;
}): string {
  return JSON.stringify([
    scope.deploymentId,
    scope.teamId,
    scope.runId,
    scope.planGeneration,
    scope.laneId,
    scope.providerId,
  ]);
}

function claimKey(scope: {
  readonly deploymentId: string;
  readonly stableActorId: string;
  readonly commandKind: string;
  readonly idempotencyKey: string;
}): string {
  return JSON.stringify([
    scope.deploymentId,
    scope.stableActorId,
    scope.commandKind,
    scope.idempotencyKey,
  ]);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== 'object' || value === null) return value;
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(sorted, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: sortJson((value as Record<string, unknown>)[key]),
    });
  }
  return sorted;
}

/**
 * Retains every unacknowledged permission ingress effect. An acknowledged
 * projection may compact only after the durable approval authority has its
 * idempotent pending record, so compaction cannot lose a provider request.
 */
export function compactRuntimeIngressSnapshot(
  snapshot: RuntimeIngressSnapshot,
  limits: RuntimeIngressSnapshotRetentionLimits,
  digest: (canonicalEvidence: string) => string,
  fits: (candidate: RuntimeIngressSnapshot) => boolean = () => true
): RuntimeIngressSnapshot {
  let credentials = [...snapshot.credentials];
  let sessions = [...snapshot.sessions];
  let planBindings = [...snapshot.planBindings];
  let credentialGenerationFences = [...snapshot.credentialGenerationFences];
  let permissionApprovalOutbox = [...(snapshot.permissionApprovalOutbox ?? [])];
  const evictOldestRevokedCredential = (): boolean => {
    const removable = credentials.find((credential) => credential.phase === 'revoked');
    if (!removable) return false;
    credentials = credentials.filter(({ credentialId }) => credentialId !== removable.credentialId);
    sessions = sessions.filter((session) => session.sessionId !== removable.sessionId);
    planBindings = planBindings.filter(
      ({ credentialId }) => credentialId !== removable.credentialId
    );
    const fenceKeys = new Set(credentials.map((credential) => fenceKey(credential.scope)));
    credentialGenerationFences = credentialGenerationFences.filter((fence) =>
      fenceKeys.has(fenceKey(fence))
    );
    return true;
  };
  const evictAcknowledgedPermission = (): boolean => {
    const index = permissionApprovalOutbox.findIndex((record) => record.acknowledgedAtIso !== null);
    if (index < 0) return false;
    permissionApprovalOutbox = permissionApprovalOutbox.filter(
      (_, candidate) => candidate !== index
    );
    return true;
  };
  while (credentials.length > limits.maxCredentials || sessions.length > limits.maxSessions) {
    if (!evictOldestRevokedCredential()) throw new Error('runtime-ingress-active-retention-limit');
  }
  while (permissionApprovalOutbox.length > limits.maxPermissionApprovalOutbox) {
    if (!evictAcknowledgedPermission()) throw new Error('runtime-ingress-permission-outbox-limit');
  }

  const target = Math.min(limits.maxCommands, limits.maxEffects);
  const commands = [...snapshot.commands];
  const effects = [...snapshot.effects];
  const replayRetentionStart = -limits.maxCompactedCommands;
  let replayCompaction: RuntimeIngressReplayCompactionEvidence = {
    ...snapshot.replayCompaction,
    retainedCommands: snapshot.replayCompaction.retainedCommands.slice(replayRetentionStart),
  };
  const compactOldestCommand = (): void => {
    const index = commands.findIndex(
      (command) =>
        !permissionApprovalOutbox.some(
          (record) => record.commandId === command.commandId && record.acknowledgedAtIso === null
        )
    );
    if (index < 0) throw new Error('runtime-ingress-permission-outbox-retention-limit');
    const [command] = commands.splice(index, 1);
    if (!command) throw new Error('runtime-ingress-compaction-command-missing');
    const key = claimKey(command.claim.scope);
    const effectIndex = effects.findIndex((effect) => effect.claimKey === key);
    if (effectIndex < 0) throw new Error('runtime-ingress-compaction-effect-missing');
    const [effect] = effects.splice(effectIndex, 1);
    const previousChainRoot = replayCompaction.chainRoot;
    replayCompaction = {
      ...replayCompaction,
      compactedCommandCount: replayCompaction.compactedCommandCount + 1,
      chainRoot: digest(canonicalJson({ previousChainRoot, command, effect })),
      retainedCommands: [...replayCompaction.retainedCommands, command].slice(replayRetentionStart),
    };
  };
  while (commands.length > target) compactOldestCommand();
  const buildCandidate = (): RuntimeIngressSnapshot => ({
    ...snapshot,
    credentials,
    sessions,
    planBindings,
    credentialGenerationFences,
    commands,
    effects,
    ...(snapshot.permissionApprovalOutbox === undefined && permissionApprovalOutbox.length === 0
      ? {}
      : { permissionApprovalOutbox }),
    replayCompaction,
  });
  while (!fits(buildCandidate())) {
    if (evictAcknowledgedPermission()) continue;
    if (replayCompaction.retainedCommands.length > 0) {
      replayCompaction = {
        ...replayCompaction,
        retainedCommands: replayCompaction.retainedCommands.slice(1),
      };
    } else if (commands.length > 1) {
      compactOldestCommand();
    } else if (!evictOldestRevokedCredential()) {
      throw new Error('runtime-ingress-snapshot-size-limit');
    }
  }
  return buildCandidate();
}

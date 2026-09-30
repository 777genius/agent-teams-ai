import {
  createCommandClaimScope,
  createDurableCommandDescriptorIdentity,
  createInitialEffectPlan,
  resolveCommandClaim,
} from '@features/application-command-ledger';
import {
  ApplicationCommandBeginOutcome,
  ApplicationCommandFailureKind,
  ApplicationCommandLedgerStatus,
  DURABLE_COMMAND_STATES,
  DURABLE_EFFECT_STATES,
} from '@features/application-command-ledger/contracts';

import {
  type AppCommandBeginRequest,
  type AppCommandBeginResult,
  type AppCommandRecord,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_OUTBOX_PAGE_SIZE,
  MAX_SAFE_JSON_BYTES,
} from './applicationCommandLedgerWorkerTypes';

import type {
  DurableApplicationCommandAttemptClaim,
  DurableApplicationCommandAttemptLeaseRequest,
  DurableApplicationCommandAttemptReference,
  DurableApplicationCommandCommitRequest,
  DurableApplicationCommandConsumerApplyRequest,
  DurableApplicationCommandConsumerProjectionRequest,
  DurableApplicationCommandEffectTransitionRequest,
  DurableApplicationCommandOutboxClaimRequest,
  DurableApplicationCommandOutboxDeliveryAcknowledgementRequest,
  DurableApplicationCommandOutboxRecord,
  DurableApplicationCommandPersistClaimRequest,
  DurableApplicationCommandRecord,
  DurableApplicationCommandTransitionRequest,
} from '@features/application-command-ledger';
import type {
  ApplicationCommandConflictReason,
  CommandClaimRecord,
  DurableCommandState,
  DurableEffectPlanItem,
  DurableEffectState,
  EffectDescriptor,
  ValidatedDurableEffectEvidence,
} from '@features/application-command-ledger/contracts';

export function mutationConflict(
  reason: ApplicationCommandConflictReason,
  existing: AppCommandRecord | null,
  requested: AppCommandBeginRequest
): AppCommandBeginResult {
  return {
    outcome: ApplicationCommandBeginOutcome.Conflict,
    reason,
    existing,
    requested,
  };
}

export function validateDurableClaim<TCommandKind extends string>(
  input: DurableApplicationCommandPersistClaimRequest<TCommandKind>
): DurableApplicationCommandPersistClaimRequest<TCommandKind> {
  assertIdentifier('commandId', input.commandId);
  const scope = createCommandClaimScope(input.scope);
  assertIdentifier('idempotencyKey', scope.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  assertIdentifier('retentionClass', input.retentionClass);
  if (input.auditSessionId !== null) assertIdentifier('auditSessionId', input.auditSessionId);
  assertIsoTimestamp('createdAtIso', input.createdAtIso);
  validateDurableAttemptClaim(input.attempt);
  if (Date.parse(input.createdAtIso) > Date.parse(input.attempt.claimedAtIso)) {
    throw new Error('Durable application command cannot be claimed before it is created');
  }

  const descriptor = createDurableCommandDescriptorIdentity(input.descriptor);
  const incoming: CommandClaimRecord<TCommandKind> = { scope, fingerprint: input.fingerprint };
  resolveCommandClaim(null, incoming);
  if (
    descriptor.commandKind !== scope.commandKind ||
    descriptor.descriptorId !== input.fingerprint.descriptorId ||
    descriptor.descriptorVersion !== input.fingerprint.descriptorVersion ||
    descriptor.inputSchemaVersion !== input.fingerprint.schemaVersion ||
    descriptor.fingerprintVersion !== input.fingerprint.fingerprintVersion ||
    descriptor.effectPlanVersion !== input.fingerprint.effectPlanVersion
  ) {
    throw new Error('Durable application command claim descriptor and fingerprint do not match');
  }

  if (!Array.isArray(input.effectPlan) || input.effectPlan.length === 0) {
    throw new Error('Durable application command effect plan must be non-empty');
  }
  const expected = createInitialEffectPlan({
    descriptorId: descriptor.descriptorId,
    effects: input.effectPlan.map(effectDescriptor) as [EffectDescriptor, ...EffectDescriptor[]],
  });
  input.effectPlan.forEach((actual, ordinal) => {
    const actualEffect = actual as DurableEffectPlanItem;
    const expectedEffect: DurableEffectPlanItem | undefined = expected[ordinal];
    if (
      !expectedEffect ||
      actualEffect.ordinal !== ordinal ||
      actualEffect.state !== 'not_started' ||
      !sameEffectIdentity(expectedEffect, actualEffect)
    ) {
      throw new Error(
        `Invalid initial durable application command effect plan: ordinal=${ordinal}`
      );
    }
  });
  return {
    ...input,
    scope,
    descriptor,
    effectPlan: expected,
  };
}

export function validateDurableAttemptClaim(input: DurableApplicationCommandAttemptClaim): void {
  assertIdentifier('attempt.attemptId', input.attemptId);
  assertIdentifier('attempt.ownerId', input.ownerId);
  assertIdentifier('attempt.leaseToken', input.leaseToken);
  assertLeaseWindow(input.claimedAtIso, input.leaseExpiresAtIso, 'attempt');
}

export function validateDurableAttemptReference(
  input: DurableApplicationCommandAttemptReference
): void {
  assertPositiveVersion('attempt.generation', input.generation);
  assertIdentifier('attempt.attemptId', input.attemptId);
  assertIdentifier('attempt.ownerId', input.ownerId);
  assertIdentifier('attempt.leaseToken', input.leaseToken);
}

export function validateDurableAttemptLease(
  input: DurableApplicationCommandAttemptLeaseRequest
): void {
  assertIdentifier('deploymentId', input.deploymentId);
  assertIdentifier('commandId', input.commandId);
  validateDurableAttemptReference(input.attempt);
  assertLeaseWindow(input.renewedAtIso, input.leaseExpiresAtIso, 'attempt renewal');
}

export function validateDurableCommandTransition(
  input: DurableApplicationCommandTransitionRequest
): void {
  assertIdentifier('deploymentId', input.deploymentId);
  assertIdentifier('commandId', input.commandId);
  validateDurableAttemptReference(input.attempt);
  assertKnownCommandState(input.expectedState);
  assertKnownCommandState(input.nextState);
  if (input.errorCode !== null) assertIdentifier('errorCode', input.errorCode);
  if (input.errorJson !== null) assertSafeJson('errorJson', input.errorJson);
  assertIsoTimestamp('transitionedAtIso', input.transitionedAtIso);
}

export function validateDurableEffectTransition(
  input: DurableApplicationCommandEffectTransitionRequest
): void {
  assertIdentifier('deploymentId', input.deploymentId);
  assertIdentifier('commandId', input.commandId);
  validateDurableAttemptReference(input.attempt);
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new Error('Durable application command effect ordinal must be non-negative');
  }
  assertKnownEffectState(input.expectedState);
  assertKnownEffectState(input.nextState);
  if (input.evidenceJson !== null) assertSafeJson('evidenceJson', input.evidenceJson);
  assertIsoTimestamp('transitionedAtIso', input.transitionedAtIso);
}

export function validateDurableCommit(input: DurableApplicationCommandCommitRequest): void {
  assertIdentifier('deploymentId', input.deploymentId);
  assertIdentifier('commandId', input.commandId);
  validateDurableAttemptReference(input.attempt);
  if (input.expectedState !== 'running' && input.expectedState !== 'recovering') {
    throw new Error(
      'Durable application command commit expectedState must be running or recovering'
    );
  }
  assertSafeJson('outcomeJson', input.outcomeJson);
  assertIsoTimestamp('committedAtIso', input.committedAtIso);
  assertIdentifier('outbox.eventId', input.outbox.eventId);
  assertIdentifier('outbox.eventType', input.outbox.eventType);
  assertIdentifier('outbox.scopeKind', input.outbox.scopeKind);
  assertIdentifier('outbox.scopeId', input.outbox.scopeId);
  assertPositiveVersion('outbox.schemaVersion', input.outbox.schemaVersion);
  assertPositiveVersion('outbox.semanticRevision', input.outbox.semanticRevision);
  assertSafeJson('outbox.payloadJson', input.outbox.payloadJson);
  assertIsoTimestamp('outbox.createdAtIso', input.outbox.createdAtIso);
}

export function validateDurableOutboxClaim(
  input: DurableApplicationCommandOutboxClaimRequest
): void {
  assertIdentifier('outbox.ownerId', input.ownerId);
  assertIdentifier('outbox.leaseToken', input.leaseToken);
  assertLeaseWindow(input.claimedAtIso, input.leaseExpiresAtIso, 'outbox delivery');
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > MAX_OUTBOX_PAGE_SIZE
  ) {
    throw new Error(
      `Durable application command outbox limit must be between 1 and ${MAX_OUTBOX_PAGE_SIZE}`
    );
  }
}

export function validateDurableOutboxDeliveryAcknowledgement(
  input: DurableApplicationCommandOutboxDeliveryAcknowledgementRequest
): void {
  assertIdentifier('outbox.eventId', input.eventId);
  assertPositiveVersion('outbox.deliveryGeneration', input.deliveryGeneration);
  assertIdentifier('outbox.ownerId', input.ownerId);
  assertIdentifier('outbox.leaseToken', input.leaseToken);
  assertIsoTimestamp('outbox.acknowledgedAtIso', input.acknowledgedAtIso);
}

export function validateDurableConsumerProjectionRequest(
  input: DurableApplicationCommandConsumerProjectionRequest
): void {
  assertIdentifier('consumer.consumerId', input.consumerId);
  assertIdentifier('consumer.projectionKey', input.projectionKey);
}

export function validateDurableConsumerApply(
  input: DurableApplicationCommandConsumerApplyRequest
): void {
  validateDurableConsumerProjectionRequest(input);
  assertIdentifier('consumer.eventId', input.eventId);
  assertPositiveVersion('consumer.semanticRevision', input.semanticRevision);
  assertSafeJson('consumer.stateJson', input.stateJson);
  assertIsoTimestamp('consumer.appliedAtIso', input.appliedAtIso);
}

export function effectDescriptor(
  effect: Pick<
    DurableEffectPlanItem,
    'effectId' | 'effectVersion' | 'recoveryClass' | 'evidenceSchemaVersion'
  >
): EffectDescriptor {
  return {
    effectId: effect.effectId,
    effectVersion: effect.effectVersion,
    recoveryClass: effect.recoveryClass,
    evidenceSchemaVersion: effect.evidenceSchemaVersion,
  };
}

export function sameEffectIdentity(left: EffectDescriptor, right: EffectDescriptor): boolean {
  return (
    left.effectId === right.effectId &&
    left.effectVersion === right.effectVersion &&
    left.recoveryClass === right.recoveryClass &&
    left.evidenceSchemaVersion === right.evidenceSchemaVersion
  );
}

export function assertEvidenceMatchesEffect(
  evidence: unknown,
  effect: EffectDescriptor,
  expectedOutcome: 'observed_succeeded' | 'observed_absent'
): void {
  const expectedKeys = [
    'effectId',
    'effectVersion',
    'evidenceSchemaVersion',
    'outcome',
    'recoveryClass',
  ];
  if (
    typeof evidence !== 'object' ||
    evidence === null ||
    Array.isArray(evidence) ||
    (Object.getPrototypeOf(evidence) !== Object.prototype &&
      Object.getPrototypeOf(evidence) !== null) ||
    Object.getOwnPropertySymbols(evidence).length > 0
  ) {
    throw new Error('Validated durable effect evidence must be a plain data object');
  }
  const keys = Object.getOwnPropertyNames(evidence).sort((left, right) =>
    left.localeCompare(right)
  );
  const candidate = evidence as ValidatedDurableEffectEvidence;
  if (
    keys.join(',') !== expectedKeys.join(',') ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(evidence, key);
      return !descriptor?.enumerable || !('value' in descriptor);
    }) ||
    !sameEffectIdentity(candidate, effect) ||
    candidate.outcome !== expectedOutcome
  ) {
    throw new Error(
      'Validated durable effect evidence does not match the persisted effect contract'
    );
  }
}

export function sameClaimScope(left: CommandClaimRecord, right: CommandClaimRecord): boolean {
  return (
    left.scope.deploymentId === right.scope.deploymentId &&
    left.scope.stableActorId === right.scope.stableActorId &&
    left.scope.commandKind === right.scope.commandKind &&
    left.scope.idempotencyKey === right.scope.idempotencyKey
  );
}

export function sameAttemptClaim(
  current: DurableApplicationCommandRecord,
  requested: DurableApplicationCommandAttemptClaim
): boolean {
  return (
    current.attempt.attemptId === requested.attemptId &&
    current.attempt.ownerId === requested.ownerId &&
    current.attempt.leaseToken === requested.leaseToken &&
    current.attempt.claimedAt === requested.claimedAtIso &&
    current.attempt.leaseExpiresAt === requested.leaseExpiresAtIso
  );
}

export function assertDurableAttemptFence(
  current: DurableApplicationCommandRecord,
  requested: DurableApplicationCommandAttemptReference,
  operationAtIso: string
): void {
  validateDurableAttemptReference(requested);
  if (
    current.attempt.generation !== requested.generation ||
    current.attempt.attemptId !== requested.attemptId ||
    current.attempt.ownerId !== requested.ownerId ||
    current.attempt.leaseToken !== requested.leaseToken
  ) {
    throw new Error(`Durable application command attempt fence is stale: ${current.commandId}`);
  }
  assertIsoTimestamp('attempt operation timestamp', operationAtIso);
  const operationAt = Date.parse(operationAtIso);
  if (
    operationAt < Date.parse(current.attempt.claimedAt) ||
    operationAt < Date.parse(current.updatedAt) ||
    operationAt >= Date.parse(current.attempt.leaseExpiresAt)
  ) {
    throw new Error(`Durable application command attempt lease expired: ${current.commandId}`);
  }
}

export function isDurableCommandTerminal(state: DurableCommandState): boolean {
  return state === 'committed' || state === 'failed' || state === 'operator_required';
}

export function sameOutboxDeliveryClaim(
  current: DurableApplicationCommandOutboxRecord,
  requested: DurableApplicationCommandOutboxClaimRequest
): boolean {
  return (
    current.deliveryLease?.ownerId === requested.ownerId &&
    current.deliveryLease.leaseToken === requested.leaseToken
  );
}

export function assertOutboxDeliveryFence(
  current: DurableApplicationCommandOutboxRecord,
  requested: DurableApplicationCommandOutboxDeliveryAcknowledgementRequest
): void {
  if (
    current.deliveryLease?.generation !== requested.deliveryGeneration ||
    current.deliveryLease.ownerId !== requested.ownerId ||
    current.deliveryLease.leaseToken !== requested.leaseToken
  ) {
    throw new Error(
      `Durable application command outbox delivery fence is stale: ${current.eventId}`
    );
  }
}

export function staleDurableCommandState(
  current: DurableApplicationCommandRecord,
  requested: DurableCommandState
): Error {
  return new Error(
    `Durable application command state is stale: ${current.commandId} expected=${requested} actual=${current.state}`
  );
}

export function assertKnownCommandState(value: string): asserts value is DurableCommandState {
  if (!DURABLE_COMMAND_STATES.includes(value as DurableCommandState)) {
    throw new Error(`Unsupported durable application command state: ${value}`);
  }
}

export function assertKnownEffectState(value: string): asserts value is DurableEffectState {
  if (!DURABLE_EFFECT_STATES.includes(value as DurableEffectState)) {
    throw new Error(`Unsupported durable application command effect state: ${value}`);
  }
}

export function assertIdentifier(
  field: string,
  value: unknown,
  maxLength = MAX_IDENTIFIER_LENGTH
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    value.includes('\0')
  ) {
    throw new Error(`Durable application command ${field} must be a bounded non-empty string`);
  }
}

export function assertPositiveVersion(field: string, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Durable application command ${field} must be a positive safe integer`);
  }
}

export function assertIsoTimestamp(field: string, value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Durable application command ${field} must be an ISO timestamp`);
  }
}

export function assertLeaseWindow(
  claimedAtIso: string,
  leaseExpiresAtIso: string,
  field: string
): void {
  assertIsoTimestamp(`${field}.claimedAt`, claimedAtIso);
  assertIsoTimestamp(`${field}.leaseExpiresAt`, leaseExpiresAtIso);
  if (Date.parse(leaseExpiresAtIso) <= Date.parse(claimedAtIso)) {
    throw new Error(`Durable application command ${field} lease must expire after it is claimed`);
  }
}

export function assertSafeJson(field: string, value: string): void {
  if (new TextEncoder().encode(value).byteLength > MAX_SAFE_JSON_BYTES) {
    throw new Error(`Durable application command ${field} exceeds the storage budget`);
  }
  try {
    JSON.parse(value);
  } catch {
    throw new Error(`Durable application command ${field} must be valid JSON`);
  }
}

export function canFinalize(status: ApplicationCommandLedgerStatus): boolean {
  return (
    status === ApplicationCommandLedgerStatus.Started ||
    status === ApplicationCommandLedgerStatus.UnknownAfterTimeout
  );
}

export function assertAttemptMatches(
  current: AppCommandRecord,
  requestedAttemptCount: number
): void {
  if (current.attemptCount !== requestedAttemptCount) {
    throw new Error(
      `Application command attempt is stale: ${current.commandId} expected=${current.attemptCount} actual=${requestedAttemptCount}`
    );
  }
}

export function assertValidBeginTiming(input: AppCommandBeginRequest): void {
  if (!Number.isSafeInteger(input.startedStaleAfterMs) || input.startedStaleAfterMs <= 0) {
    throw new Error('Application command startedStaleAfterMs must be a positive integer');
  }
  if (!Number.isFinite(Date.parse(input.nowIso))) {
    throw new Error('Application command nowIso must be a valid ISO timestamp');
  }
}

export function isStartedStale(current: AppCommandRecord, input: AppCommandBeginRequest): boolean {
  const attemptStartedAtMs = Date.parse(current.updatedAt);
  if (!Number.isFinite(attemptStartedAtMs)) {
    return true;
  }
  return Date.parse(input.nowIso) - attemptStartedAtMs >= input.startedStaleAfterMs;
}

export function statusForFailure(
  failureKind: ApplicationCommandFailureKind
): ApplicationCommandLedgerStatus {
  switch (failureKind) {
    case ApplicationCommandFailureKind.Retryable:
      return ApplicationCommandLedgerStatus.FailedRetryable;
    case ApplicationCommandFailureKind.Terminal:
      return ApplicationCommandLedgerStatus.FailedTerminal;
    case ApplicationCommandFailureKind.UnknownAfterTimeout:
      return ApplicationCommandLedgerStatus.UnknownAfterTimeout;
  }
}

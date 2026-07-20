import {
  ApplicationCommandBeginOutcome,
  ApplicationCommandConflictReason,
  ApplicationCommandFailureKind,
  type ApplicationCommandLedgerBeginRequest,
  type ApplicationCommandLedgerBeginResult,
  type ApplicationCommandLedgerCompleteRequest,
  type ApplicationCommandLedgerFailRequest,
  type ApplicationCommandLedgerListScopeRequest,
  type ApplicationCommandLedgerReadByCommandIdRequest,
  type ApplicationCommandLedgerReadByIdempotencyKeyRequest,
  type ApplicationCommandLedgerRecord,
  ApplicationCommandLedgerStatus,
  DURABLE_COMMAND_STATES,
  DURABLE_EFFECT_STATES,
  EFFECT_RECOVERY_CLASSES,
  HMAC_SHA256_LD_V1,
} from '@features/application-command-ledger/contracts';
import {
  classifyAmbiguousEffect,
  commitDurableCommand as assertDurableCommandCommit,
  createCommandClaimScope,
  createDurableCommandDescriptorIdentity,
  createInitialEffectPlan,
  resolveAmbiguousDurableEffect,
  resolveCommandClaim,
  retryDurableEffectAfterObservedAbsent,
  transitionDurableCommandState,
  transitionDurableEffectState,
} from '@features/application-command-ledger/core/domain';
import { and, asc, eq, gt, isNull, lt } from 'drizzle-orm';

import {
  applicationCommandLedger,
  durableApplicationCommandConsumerApplications,
  durableApplicationCommandConsumerProjections,
  durableApplicationCommandEffectEvidence,
  durableApplicationCommandEffects,
  durableApplicationCommandOutbox,
  durableApplicationCommands,
} from './internalStorageSchema';

import type {
  DurableApplicationCommandAttemptClaim,
  DurableApplicationCommandAttemptLeaseRequest,
  DurableApplicationCommandAttemptReference,
  DurableApplicationCommandClaimResult,
  DurableApplicationCommandClaimStatusRequest,
  DurableApplicationCommandCommitRequest,
  DurableApplicationCommandConsumerApplicationRecord,
  DurableApplicationCommandConsumerApplyRequest,
  DurableApplicationCommandConsumerApplyResult,
  DurableApplicationCommandConsumerProjectionRecord,
  DurableApplicationCommandConsumerProjectionRequest,
  DurableApplicationCommandEffectEvidenceRecord,
  DurableApplicationCommandEffectTransitionRequest,
  DurableApplicationCommandOutboxClaimRequest,
  DurableApplicationCommandOutboxDeliveryAcknowledgementRequest,
  DurableApplicationCommandOutboxListRequest,
  DurableApplicationCommandOutboxRecord,
  DurableApplicationCommandPersistClaimRequest,
  DurableApplicationCommandRecord,
  DurableApplicationCommandStatusRequest,
  DurableApplicationCommandTransitionRequest,
} from '@features/application-command-ledger';
import type {
  CommandClaimRecord,
  CommandFingerprintRecord,
  DurableCommandState,
  DurableEffectPlanItem,
  DurableEffectState,
  EffectDescriptor,
  EffectRecoveryClass,
  ValidatedDurableEffectEvidence,
} from '@features/application-command-ledger/contracts';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type AppCommandRecord = ApplicationCommandLedgerRecord<string>;
type AppCommandBeginRequest = ApplicationCommandLedgerBeginRequest<string>;
type AppCommandBeginResult = ApplicationCommandLedgerBeginResult<string>;

interface DurableCommandRow {
  commandId: string;
  deploymentId: string;
  stableActorId: string;
  commandKind: string;
  idempotencyKey: string;
  descriptorId: string;
  descriptorVersion: number;
  inputSchemaVersion: number;
  fingerprintVersion: string;
  effectPlanVersion: number;
  fingerprintKeyVersion: string;
  fingerprintDigest: string;
  attemptGeneration: number;
  attemptId: string;
  attemptOwnerId: string;
  attemptLeaseToken: string;
  attemptClaimedAt: string;
  attemptLeaseExpiresAt: string;
  state: string;
  retentionClass: string;
  auditSessionId: string | null;
  outcomeJson: string | null;
  errorCode: string | null;
  errorJson: string | null;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
}

interface DurableEffectRow {
  commandId: string;
  ordinal: number;
  effectId: string;
  effectVersion: number;
  recoveryClass: string;
  evidenceSchemaVersion: number;
  state: string;
  updatedAt: string;
}

interface DurableEffectEvidenceRow {
  commandId: string;
  ordinal: number;
  sequence: number;
  outcome: string;
  evidenceSchemaVersion: number;
  evidenceJson: string;
  recordedAt: string;
}

interface DurableOutboxRow {
  sequence: number;
  eventId: string;
  commandId: string;
  deploymentId: string;
  eventType: string;
  scopeKind: string;
  scopeId: string;
  schemaVersion: number;
  semanticRevision: number;
  payloadJson: string;
  createdAt: string;
  deliveryGeneration: number;
  deliveryOwnerId: string | null;
  deliveryLeaseToken: string | null;
  deliveryClaimedAt: string | null;
  deliveryLeaseExpiresAt: string | null;
  deliveryAcknowledgedAt: string | null;
}

interface DurableConsumerApplicationRow {
  consumerId: string;
  eventId: string;
  semanticRevision: number;
  projectionKey: string;
  stateJson: string;
  appliedAt: string;
}

interface DurableConsumerProjectionRow {
  consumerId: string;
  projectionKey: string;
  semanticRevision: number;
  lastEventId: string;
  stateJson: string;
  applicationCount: number;
  updatedAt: string;
}

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_IDEMPOTENCY_KEY_LENGTH = 1_024;
const MAX_SAFE_JSON_BYTES = 64 * 1_024;
const MAX_OUTBOX_PAGE_SIZE = 1_000;

export function handleApplicationCommandLedgerOp(
  ops: ApplicationCommandLedgerWorkerOps,
  op: string,
  payload: unknown
): unknown {
  switch (op) {
    case 'appCommandLedger.begin':
      return ops.begin(payload as AppCommandBeginRequest);
    case 'appCommandLedger.markCompleted':
      ops.markCompleted(payload as ApplicationCommandLedgerCompleteRequest);
      return null;
    case 'appCommandLedger.markFailed':
      ops.markFailed(payload as ApplicationCommandLedgerFailRequest);
      return null;
    case 'appCommandLedger.getByCommandId':
      return ops.getByCommandId(payload as ApplicationCommandLedgerReadByCommandIdRequest);
    case 'appCommandLedger.getByIdempotencyKey':
      return ops.getByIdempotencyKey(
        payload as ApplicationCommandLedgerReadByIdempotencyKeyRequest
      );
    case 'appCommandLedger.listByScope':
      return ops.listByScope(payload as ApplicationCommandLedgerListScopeRequest);
    case 'appCommandLedger.durable.claim':
      return ops.durableClaim(payload as DurableApplicationCommandPersistClaimRequest);
    case 'appCommandLedger.durable.getStatus':
      return ops.durableGetStatus(payload as DurableApplicationCommandStatusRequest);
    case 'appCommandLedger.durable.getByClaim':
      return ops.durableGetByClaim(payload as DurableApplicationCommandClaimStatusRequest);
    case 'appCommandLedger.durable.renewAttemptLease':
      return ops.durableRenewAttemptLease(payload as DurableApplicationCommandAttemptLeaseRequest);
    case 'appCommandLedger.durable.transitionCommand':
      return ops.durableTransitionCommand(payload as DurableApplicationCommandTransitionRequest);
    case 'appCommandLedger.durable.transitionEffect':
      return ops.durableTransitionEffect(
        payload as DurableApplicationCommandEffectTransitionRequest
      );
    case 'appCommandLedger.durable.commit':
      return ops.durableCommit(payload as DurableApplicationCommandCommitRequest);
    case 'appCommandLedger.durable.listOutbox':
      return ops.durableListOutbox(payload as DurableApplicationCommandOutboxListRequest);
    case 'appCommandLedger.durable.claimOutbox':
      return ops.durableClaimOutbox(payload as DurableApplicationCommandOutboxClaimRequest);
    case 'appCommandLedger.durable.acknowledgeOutboxDelivery':
      ops.durableAcknowledgeOutboxDelivery(
        payload as DurableApplicationCommandOutboxDeliveryAcknowledgementRequest
      );
      return null;
    case 'appCommandLedger.durable.applyConsumerEvent':
      return ops.durableApplyConsumerEvent(
        payload as DurableApplicationCommandConsumerApplyRequest
      );
    case 'appCommandLedger.durable.getConsumerProjection':
      return ops.durableGetConsumerProjection(
        payload as DurableApplicationCommandConsumerProjectionRequest
      );
    default:
      throw new Error(`Unknown internal-storage op: ${op}`);
  }
}

export class ApplicationCommandLedgerWorkerOps {
  constructor(private readonly getOrm: () => BetterSQLite3Database) {}

  durableClaim<TCommandKind extends string>(
    input: DurableApplicationCommandPersistClaimRequest<TCommandKind>
  ): DurableApplicationCommandClaimResult<TCommandKind> {
    const validated = validateDurableClaim(input);
    const orm = this.getOrm();

    return orm.transaction(
      () => {
        const insertResult = orm
          .insert(durableApplicationCommands)
          .values({
            commandId: validated.commandId,
            deploymentId: validated.scope.deploymentId,
            stableActorId: validated.scope.stableActorId,
            commandKind: validated.scope.commandKind,
            idempotencyKey: validated.scope.idempotencyKey,
            descriptorId: validated.descriptor.descriptorId,
            descriptorVersion: validated.descriptor.descriptorVersion,
            inputSchemaVersion: validated.descriptor.inputSchemaVersion,
            fingerprintVersion: validated.descriptor.fingerprintVersion,
            effectPlanVersion: validated.descriptor.effectPlanVersion,
            fingerprintKeyVersion: validated.fingerprint.keyVersion,
            fingerprintDigest: validated.fingerprint.digest,
            attemptGeneration: 1,
            attemptId: validated.attempt.attemptId,
            attemptOwnerId: validated.attempt.ownerId,
            attemptLeaseToken: validated.attempt.leaseToken,
            attemptClaimedAt: validated.attempt.claimedAtIso,
            attemptLeaseExpiresAt: validated.attempt.leaseExpiresAtIso,
            state: 'prepared',
            retentionClass: validated.retentionClass,
            auditSessionId: validated.auditSessionId,
            outcomeJson: null,
            errorCode: null,
            errorJson: null,
            createdAt: validated.createdAtIso,
            updatedAt: validated.createdAtIso,
            committedAt: null,
          })
          .onConflictDoNothing()
          .run();

        const created = insertResult.changes === 1;
        if (created) {
          orm
            .insert(durableApplicationCommandEffects)
            .values(
              validated.effectPlan.map((effect) => ({
                commandId: validated.commandId,
                ordinal: effect.ordinal,
                effectId: effect.effectId,
                effectVersion: effect.effectVersion,
                recoveryClass: effect.recoveryClass,
                evidenceSchemaVersion: effect.evidenceSchemaVersion,
                state: effect.state,
                updatedAt: validated.createdAtIso,
              }))
            )
            .run();
        }

        const byCommandId = this.readDurableRecord({
          deploymentId: validated.scope.deploymentId,
          commandId: validated.commandId,
        });
        const byClaim = this.readDurableRecordByClaim({ scope: validated.scope });
        if (byCommandId && byClaim && byCommandId.commandId !== byClaim.commandId) {
          throw new Error(
            'Durable application command claim conflicts with both an existing command id and claim scope'
          );
        }
        let command = byClaim ?? byCommandId;
        if (!command) {
          throw new Error('Durable application command claim did not converge to a stored record');
        }

        const incoming: CommandClaimRecord<TCommandKind> = {
          scope: validated.scope,
          fingerprint: validated.fingerprint,
        };
        if (!sameClaimScope(command.claim, incoming)) {
          throw new Error(
            `Durable application command id is already in use: ${validated.commandId}`
          );
        }

        const resolution = created
          ? resolveCommandClaim<TCommandKind>(null, incoming)
          : resolveCommandClaim(command.claim as CommandClaimRecord<TCommandKind>, incoming);
        let attemptAcquired =
          resolution.outcome !== 'idempotency_mismatch' &&
          !isDurableCommandTerminal(command.state) &&
          (created || sameAttemptClaim(command, validated.attempt));
        if (!created && resolution.outcome === 'same_intent' && !attemptAcquired) {
          attemptAcquired = this.tryAcquireExpiredDurableAttempt(command, validated.attempt);
          if (attemptAcquired) {
            command = this.requireDurableRecord({
              deploymentId: validated.scope.deploymentId,
              commandId: command.commandId,
            });
          }
        }
        return {
          resolution,
          attemptAcquired,
          command: command as DurableApplicationCommandRecord<TCommandKind>,
        };
      },
      { behavior: 'immediate' }
    );
  }

  durableGetStatus<TCommandKind extends string>(
    input: DurableApplicationCommandStatusRequest
  ): DurableApplicationCommandRecord<TCommandKind> | null {
    assertIdentifier('deploymentId', input.deploymentId);
    assertIdentifier('commandId', input.commandId);
    const orm = this.getOrm();
    return orm.transaction(
      () => this.readDurableRecord(input) as DurableApplicationCommandRecord<TCommandKind> | null
    );
  }

  durableGetByClaim<TCommandKind extends string>(
    input: DurableApplicationCommandClaimStatusRequest<TCommandKind>
  ): DurableApplicationCommandRecord<TCommandKind> | null {
    const scope = createCommandClaimScope(input.scope);
    const orm = this.getOrm();
    return orm.transaction(() => this.readDurableRecordByClaim({ scope }));
  }

  durableRenewAttemptLease(
    input: DurableApplicationCommandAttemptLeaseRequest
  ): DurableApplicationCommandRecord {
    validateDurableAttemptLease(input);
    const orm = this.getOrm();
    return orm.transaction(
      () => {
        const current = this.requireDurableRecord(input);
        assertDurableAttemptFence(current, input.attempt, input.renewedAtIso);
        if (isDurableCommandTerminal(current.state)) {
          throw new Error(`Durable application command attempt is terminal: ${current.commandId}`);
        }
        if (Date.parse(input.leaseExpiresAtIso) <= Date.parse(current.attempt.leaseExpiresAt)) {
          throw new Error(
            'Durable application command lease renewal must extend the current lease'
          );
        }
        orm
          .update(durableApplicationCommands)
          .set({
            attemptLeaseExpiresAt: input.leaseExpiresAtIso,
            updatedAt: input.renewedAtIso,
          })
          .where(eq(durableApplicationCommands.commandId, current.commandId))
          .run();
        return this.requireDurableRecord(input);
      },
      { behavior: 'immediate' }
    );
  }

  durableTransitionCommand(
    input: DurableApplicationCommandTransitionRequest
  ): DurableApplicationCommandRecord {
    validateDurableCommandTransition(input);
    const orm = this.getOrm();
    return orm.transaction(
      () => {
        const current = this.requireDurableRecord(input);
        assertDurableAttemptFence(current, input.attempt, input.transitionedAtIso);
        if (current.state !== input.expectedState) {
          throw staleDurableCommandState(current, input.expectedState);
        }
        const nextState = transitionDurableCommandState(current.state, input.nextState);
        const terminalError = nextState === 'failed' || nextState === 'operator_required';
        if (terminalError && !input.errorCode) {
          throw new Error(`Durable application command ${nextState} requires a safe error code`);
        }
        if (!terminalError && (input.errorCode !== null || input.errorJson !== null)) {
          throw new Error(
            `Durable application command ${nextState} cannot record terminal error data`
          );
        }
        orm
          .update(durableApplicationCommands)
          .set({
            state: nextState,
            errorCode: input.errorCode,
            errorJson: input.errorJson,
            updatedAt: input.transitionedAtIso,
          })
          .where(eq(durableApplicationCommands.commandId, current.commandId))
          .run();
        return this.requireDurableRecord(input);
      },
      { behavior: 'immediate' }
    );
  }

  durableTransitionEffect(
    input: DurableApplicationCommandEffectTransitionRequest
  ): DurableApplicationCommandRecord {
    validateDurableEffectTransition(input);
    const orm = this.getOrm();
    return orm.transaction(
      () => {
        const current = this.requireDurableRecord(input);
        assertDurableAttemptFence(current, input.attempt, input.transitionedAtIso);
        if (current.state !== 'running' && current.state !== 'recovering') {
          throw new Error(
            `Durable application command effects cannot transition from command state ${current.state}`
          );
        }
        const effect = current.effects[input.ordinal];
        if (effect?.ordinal !== input.ordinal) {
          throw new Error(`Durable application command effect ordinal not found: ${input.ordinal}`);
        }
        if (effect.state !== input.expectedState) {
          throw new Error(
            `Durable application command effect state is stale: ordinal=${input.ordinal} expected=${effect.state} actual=${input.expectedState}`
          );
        }

        if (input.nextState === 'attempting') {
          for (let ordinal = 0; ordinal < input.ordinal; ordinal += 1) {
            if (current.effects[ordinal]?.state !== 'observed_succeeded') {
              throw new Error(
                `Durable application command effects must start in order: ordinal=${input.ordinal}`
              );
            }
          }
        }

        const descriptor = effectDescriptor(effect);
        let nextState: DurableEffectState;
        const isObserved =
          input.nextState === 'observed_succeeded' || input.nextState === 'observed_absent';
        if (isObserved) {
          if (!input.evidence || input.evidenceJson === null) {
            throw new Error('Observed durable effect state requires validated evidence');
          }
          assertEvidenceMatchesEffect(input.evidence, descriptor, input.nextState);
          nextState =
            effect.state === 'ambiguous'
              ? resolveAmbiguousDurableEffect(descriptor, effect.state, input.evidence)
              : transitionDurableEffectState(descriptor, effect.state, input.nextState);
        } else {
          if (input.evidence !== null || input.evidenceJson !== null) {
            throw new Error('Durable effect evidence is allowed only for an observed outcome');
          }
          nextState =
            effect.state === 'observed_absent' && input.nextState === 'attempting'
              ? retryDurableEffectAfterObservedAbsent(descriptor, effect.state)
              : transitionDurableEffectState(descriptor, effect.state, input.nextState);
        }

        orm
          .update(durableApplicationCommandEffects)
          .set({ state: nextState, updatedAt: input.transitionedAtIso })
          .where(
            and(
              eq(durableApplicationCommandEffects.commandId, current.commandId),
              eq(durableApplicationCommandEffects.ordinal, input.ordinal)
            )
          )
          .run();

        if (isObserved && input.evidence && input.evidenceJson !== null) {
          const evidenceRows = this.readEffectEvidence(current.commandId, input.ordinal);
          orm
            .insert(durableApplicationCommandEffectEvidence)
            .values({
              commandId: current.commandId,
              ordinal: input.ordinal,
              sequence: (evidenceRows.at(-1)?.sequence ?? 0) + 1,
              outcome: input.evidence.outcome,
              evidenceSchemaVersion: input.evidence.evidenceSchemaVersion,
              evidenceJson: input.evidenceJson,
              recordedAt: input.transitionedAtIso,
            })
            .run();
        }

        let commandState: DurableCommandState = current.state;
        let errorCode = current.errorCode;
        let errorJson = current.errorJson;
        if (nextState === 'ambiguous') {
          const disposition = classifyAmbiguousEffect(effect.recoveryClass);
          if (commandState === 'running') {
            commandState = transitionDurableCommandState(commandState, 'recovering');
          }
          if (disposition.commandState === 'operator_required') {
            commandState = transitionDurableCommandState(commandState, 'operator_required');
            errorCode = 'ambiguous_non_reconcilable_effect';
            errorJson = JSON.stringify({ effectId: effect.effectId, ordinal: effect.ordinal });
          }
        }
        orm
          .update(durableApplicationCommands)
          .set({
            state: commandState,
            errorCode,
            errorJson,
            updatedAt: input.transitionedAtIso,
          })
          .where(eq(durableApplicationCommands.commandId, current.commandId))
          .run();
        return this.requireDurableRecord(input);
      },
      { behavior: 'immediate' }
    );
  }

  durableCommit(input: DurableApplicationCommandCommitRequest): DurableApplicationCommandRecord {
    validateDurableCommit(input);
    const orm = this.getOrm();
    return orm.transaction(
      () => {
        const current = this.requireDurableRecord(input);
        assertDurableAttemptFence(current, input.attempt, input.committedAtIso);
        if (current.state === 'committed') {
          const storedOutbox = this.readOutboxByCommandId(current.commandId);
          if (
            current.outcomeJson === input.outcomeJson &&
            storedOutbox &&
            sameOutboxInput(storedOutbox, input.outbox)
          ) {
            return current;
          }
          throw new Error(`Durable application command commit conflicts: ${current.commandId}`);
        }
        if (current.state !== input.expectedState) {
          throw staleDurableCommandState(current, input.expectedState);
        }

        const descriptor = {
          ...current.descriptor,
          effects: current.effects.map(effectDescriptor) as [
            EffectDescriptor,
            ...EffectDescriptor[],
          ],
        };
        assertDurableCommandCommit(
          current.state,
          descriptor,
          current.descriptor,
          current.effects.map((effect) => ({
            effectId: effect.effectId,
            effectVersion: effect.effectVersion,
            recoveryClass: effect.recoveryClass,
            evidenceSchemaVersion: effect.evidenceSchemaVersion,
            ordinal: effect.ordinal,
            state: effect.state,
          }))
        );

        orm
          .insert(durableApplicationCommandOutbox)
          .values({
            eventId: input.outbox.eventId,
            commandId: current.commandId,
            deploymentId: current.claim.scope.deploymentId,
            eventType: input.outbox.eventType,
            scopeKind: input.outbox.scopeKind,
            scopeId: input.outbox.scopeId,
            schemaVersion: input.outbox.schemaVersion,
            semanticRevision: input.outbox.semanticRevision,
            payloadJson: input.outbox.payloadJson,
            createdAt: input.outbox.createdAtIso,
            deliveryGeneration: 0,
            deliveryOwnerId: null,
            deliveryLeaseToken: null,
            deliveryClaimedAt: null,
            deliveryLeaseExpiresAt: null,
            deliveryAcknowledgedAt: null,
          })
          .run();
        orm
          .update(durableApplicationCommands)
          .set({
            state: 'committed',
            outcomeJson: input.outcomeJson,
            errorCode: null,
            errorJson: null,
            updatedAt: input.committedAtIso,
            committedAt: input.committedAtIso,
          })
          .where(eq(durableApplicationCommands.commandId, current.commandId))
          .run();
        return this.requireDurableRecord(input);
      },
      { behavior: 'immediate' }
    );
  }

  durableListOutbox(
    input: DurableApplicationCommandOutboxListRequest
  ): DurableApplicationCommandOutboxRecord[] {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new Error('Durable application command outbox afterSequence must be non-negative');
    }
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > MAX_OUTBOX_PAGE_SIZE
    ) {
      throw new Error(
        `Durable application command outbox limit must be between 1 and ${MAX_OUTBOX_PAGE_SIZE}`
      );
    }
    return this.getOrm()
      .select()
      .from(durableApplicationCommandOutbox)
      .where(gt(durableApplicationCommandOutbox.sequence, input.afterSequence))
      .orderBy(asc(durableApplicationCommandOutbox.sequence))
      .limit(input.limit)
      .all()
      .map(mapOutboxRow);
  }

  durableClaimOutbox(
    input: DurableApplicationCommandOutboxClaimRequest
  ): DurableApplicationCommandOutboxRecord[] {
    validateDurableOutboxClaim(input);
    const orm = this.getOrm();
    return orm.transaction(
      () => {
        const rows = orm
          .select()
          .from(durableApplicationCommandOutbox)
          .where(isNull(durableApplicationCommandOutbox.deliveryAcknowledgedAt))
          .orderBy(asc(durableApplicationCommandOutbox.sequence))
          .limit(input.limit)
          .all() as DurableOutboxRow[];
        if (rows.length === 0) return [];

        const first = mapOutboxRow(rows[0]);
        if (first.deliveryLease && !sameOutboxDeliveryClaim(first, input)) {
          if (Date.parse(input.claimedAtIso) < Date.parse(first.deliveryLease.leaseExpiresAt)) {
            return [];
          }
        }

        if (first.deliveryLease && sameOutboxDeliveryClaim(first, input)) {
          const claimed: DurableApplicationCommandOutboxRecord[] = [];
          for (const row of rows) {
            const record = mapOutboxRow(row);
            if (!sameOutboxDeliveryClaim(record, input)) break;
            claimed.push(record);
          }
          return claimed;
        }

        for (const row of rows) {
          orm
            .update(durableApplicationCommandOutbox)
            .set({
              deliveryGeneration: row.deliveryGeneration + 1,
              deliveryOwnerId: input.ownerId,
              deliveryLeaseToken: input.leaseToken,
              deliveryClaimedAt: input.claimedAtIso,
              deliveryLeaseExpiresAt: input.leaseExpiresAtIso,
            })
            .where(eq(durableApplicationCommandOutbox.sequence, row.sequence))
            .run();
        }

        return orm
          .select()
          .from(durableApplicationCommandOutbox)
          .where(isNull(durableApplicationCommandOutbox.deliveryAcknowledgedAt))
          .orderBy(asc(durableApplicationCommandOutbox.sequence))
          .limit(rows.length)
          .all()
          .map(mapOutboxRow);
      },
      { behavior: 'immediate' }
    );
  }

  durableAcknowledgeOutboxDelivery(
    input: DurableApplicationCommandOutboxDeliveryAcknowledgementRequest
  ): void {
    validateDurableOutboxDeliveryAcknowledgement(input);
    const orm = this.getOrm();
    orm.transaction(
      () => {
        const rows = orm
          .select()
          .from(durableApplicationCommandOutbox)
          .where(eq(durableApplicationCommandOutbox.eventId, input.eventId))
          .all();
        const row = rows[0];
        if (!row) {
          throw new Error(`Durable application command outbox event not found: ${input.eventId}`);
        }
        const record = mapOutboxRow(row);
        assertOutboxDeliveryFence(record, input);
        if (row.deliveryAcknowledgedAt !== null) return;
        if (
          Date.parse(input.acknowledgedAtIso) < Date.parse(record.deliveryLease!.claimedAt) ||
          Date.parse(input.acknowledgedAtIso) >= Date.parse(record.deliveryLease!.leaseExpiresAt)
        ) {
          throw new Error(
            `Durable application command outbox delivery lease expired: ${input.eventId}`
          );
        }
        const earlierUnacknowledged = orm
          .select({ sequence: durableApplicationCommandOutbox.sequence })
          .from(durableApplicationCommandOutbox)
          .where(
            and(
              isNull(durableApplicationCommandOutbox.deliveryAcknowledgedAt),
              lt(durableApplicationCommandOutbox.sequence, record.sequence)
            )
          )
          .limit(1)
          .all();
        if (earlierUnacknowledged.length > 0) {
          throw new Error(
            `Durable application command outbox must acknowledge delivery in sequence order: ${input.eventId}`
          );
        }
        orm
          .update(durableApplicationCommandOutbox)
          .set({ deliveryAcknowledgedAt: input.acknowledgedAtIso })
          .where(eq(durableApplicationCommandOutbox.eventId, input.eventId))
          .run();
      },
      { behavior: 'immediate' }
    );
  }

  durableApplyConsumerEvent(
    input: DurableApplicationCommandConsumerApplyRequest
  ): DurableApplicationCommandConsumerApplyResult {
    validateDurableConsumerApply(input);
    const orm = this.getOrm();
    return orm.transaction(
      () => {
        const eventRow = orm
          .select()
          .from(durableApplicationCommandOutbox)
          .where(eq(durableApplicationCommandOutbox.eventId, input.eventId))
          .get() as DurableOutboxRow | undefined;
        if (!eventRow) {
          throw new Error(`Durable application command consumer event not found: ${input.eventId}`);
        }
        const event = mapOutboxRow(eventRow);
        if (event.semanticRevision !== input.semanticRevision) {
          throw new Error(
            `Durable application command consumer semantic revision mismatch: ${input.eventId} expected=${event.semanticRevision} actual=${input.semanticRevision}`
          );
        }

        const existingRow = orm
          .select()
          .from(durableApplicationCommandConsumerApplications)
          .where(
            and(
              eq(durableApplicationCommandConsumerApplications.consumerId, input.consumerId),
              eq(durableApplicationCommandConsumerApplications.eventId, input.eventId)
            )
          )
          .get() as DurableConsumerApplicationRow | undefined;
        if (existingRow) {
          const application = mapConsumerApplicationRow(existingRow);
          if (
            application.semanticRevision !== input.semanticRevision ||
            application.projectionKey !== input.projectionKey ||
            application.stateJson !== input.stateJson
          ) {
            throw new Error(
              `Durable application command consumer replay conflicts with the applied event: ${input.eventId}`
            );
          }
          return {
            outcome: 'duplicate',
            application,
            projection: this.requireDurableConsumerProjection(input),
          };
        }

        const current = this.readDurableConsumerProjection(input);
        if (current && input.semanticRevision <= current.semanticRevision) {
          throw new Error(
            `Durable application command consumer semantic revision must advance: ${input.projectionKey} current=${current.semanticRevision} actual=${input.semanticRevision}`
          );
        }

        orm
          .insert(durableApplicationCommandConsumerApplications)
          .values({
            consumerId: input.consumerId,
            eventId: input.eventId,
            semanticRevision: input.semanticRevision,
            projectionKey: input.projectionKey,
            stateJson: input.stateJson,
            appliedAt: input.appliedAtIso,
          })
          .run();

        if (current) {
          orm
            .update(durableApplicationCommandConsumerProjections)
            .set({
              semanticRevision: input.semanticRevision,
              lastEventId: input.eventId,
              stateJson: input.stateJson,
              applicationCount: current.applicationCount + 1,
              updatedAt: input.appliedAtIso,
            })
            .where(
              and(
                eq(durableApplicationCommandConsumerProjections.consumerId, input.consumerId),
                eq(durableApplicationCommandConsumerProjections.projectionKey, input.projectionKey)
              )
            )
            .run();
        } else {
          orm
            .insert(durableApplicationCommandConsumerProjections)
            .values({
              consumerId: input.consumerId,
              projectionKey: input.projectionKey,
              semanticRevision: input.semanticRevision,
              lastEventId: input.eventId,
              stateJson: input.stateJson,
              applicationCount: 1,
              updatedAt: input.appliedAtIso,
            })
            .run();
        }

        return {
          outcome: 'applied',
          application: mapConsumerApplicationRow({
            consumerId: input.consumerId,
            eventId: input.eventId,
            semanticRevision: input.semanticRevision,
            projectionKey: input.projectionKey,
            stateJson: input.stateJson,
            appliedAt: input.appliedAtIso,
          }),
          projection: this.requireDurableConsumerProjection(input),
        };
      },
      { behavior: 'immediate' }
    );
  }

  durableGetConsumerProjection(
    input: DurableApplicationCommandConsumerProjectionRequest
  ): DurableApplicationCommandConsumerProjectionRecord | null {
    validateDurableConsumerProjectionRequest(input);
    return this.readDurableConsumerProjection(input);
  }

  private readDurableConsumerProjection(
    input: DurableApplicationCommandConsumerProjectionRequest
  ): DurableApplicationCommandConsumerProjectionRecord | null {
    const row = this.getOrm()
      .select()
      .from(durableApplicationCommandConsumerProjections)
      .where(
        and(
          eq(durableApplicationCommandConsumerProjections.consumerId, input.consumerId),
          eq(durableApplicationCommandConsumerProjections.projectionKey, input.projectionKey)
        )
      )
      .get() as DurableConsumerProjectionRow | undefined;
    return row ? mapConsumerProjectionRow(row) : null;
  }

  private requireDurableConsumerProjection(
    input: DurableApplicationCommandConsumerProjectionRequest
  ): DurableApplicationCommandConsumerProjectionRecord {
    const projection = this.readDurableConsumerProjection(input);
    if (!projection) {
      throw new Error(
        `Durable application command consumer projection not found: ${input.consumerId}/${input.projectionKey}`
      );
    }
    return projection;
  }

  private tryAcquireExpiredDurableAttempt(
    current: DurableApplicationCommandRecord,
    attempt: DurableApplicationCommandAttemptClaim
  ): boolean {
    if (
      isDurableCommandTerminal(current.state) ||
      Date.parse(attempt.claimedAtIso) < Date.parse(current.attempt.leaseExpiresAt)
    ) {
      return false;
    }

    const orm = this.getOrm();
    let commandState = current.state;
    let errorCode = current.errorCode;
    let errorJson = current.errorJson;
    for (const effect of current.effects) {
      if (effect.state !== 'attempting' && effect.state !== 'compensating') continue;
      transitionDurableEffectState(effectDescriptor(effect), effect.state, 'ambiguous');
      orm
        .update(durableApplicationCommandEffects)
        .set({ state: 'ambiguous', updatedAt: attempt.claimedAtIso })
        .where(
          and(
            eq(durableApplicationCommandEffects.commandId, current.commandId),
            eq(durableApplicationCommandEffects.ordinal, effect.ordinal)
          )
        )
        .run();
      if (commandState === 'running') {
        commandState = transitionDurableCommandState(commandState, 'recovering');
      }
      if (classifyAmbiguousEffect(effect.recoveryClass).commandState === 'operator_required') {
        if (commandState !== 'recovering') {
          throw new Error('Non-reconcilable effect takeover requires a recovering command');
        }
        commandState = transitionDurableCommandState(commandState, 'operator_required');
        errorCode = 'ambiguous_non_reconcilable_effect';
        errorJson = JSON.stringify({ effectId: effect.effectId, ordinal: effect.ordinal });
      }
    }
    if (commandState === 'running') {
      commandState = transitionDurableCommandState(commandState, 'recovering');
    }

    orm
      .update(durableApplicationCommands)
      .set({
        attemptGeneration: current.attempt.generation + 1,
        attemptId: attempt.attemptId,
        attemptOwnerId: attempt.ownerId,
        attemptLeaseToken: attempt.leaseToken,
        attemptClaimedAt: attempt.claimedAtIso,
        attemptLeaseExpiresAt: attempt.leaseExpiresAtIso,
        state: commandState,
        errorCode,
        errorJson,
        updatedAt: attempt.claimedAtIso,
      })
      .where(eq(durableApplicationCommands.commandId, current.commandId))
      .run();
    return true;
  }

  begin(input: AppCommandBeginRequest): AppCommandBeginResult {
    assertValidBeginTiming(input);
    const orm = this.getOrm();
    return orm.transaction((): AppCommandBeginResult => {
      const currentByCommand = this.readByCommandId(input);
      if (currentByCommand) {
        return this.beginExistingCommand(currentByCommand, input);
      }

      const currentByIdempotencyKey = this.readByIdempotencyKey(input);
      if (currentByIdempotencyKey) {
        return this.beginExistingIdempotencyKey(currentByIdempotencyKey, input);
      }

      const created: AppCommandRecord = {
        namespace: input.namespace,
        scopeKey: input.scopeKey,
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        payloadHash: input.payloadHash,
        status: ApplicationCommandLedgerStatus.Started,
        failureKind: null,
        retryable: false,
        attemptCount: 1,
        resultHash: null,
        resultJson: null,
        metadataJson: input.metadataJson,
        startedAt: input.nowIso,
        updatedAt: input.nowIso,
        completedAt: null,
        lastError: null,
      };
      orm.insert(applicationCommandLedger).values(created).run();
      return { outcome: ApplicationCommandBeginOutcome.Started, record: created };
    });
  }

  markCompleted(input: ApplicationCommandLedgerCompleteRequest): void {
    const orm = this.getOrm();
    orm.transaction(() => {
      const current = this.readByCommandId(input);
      if (!current) {
        throw new Error(`Application command ledger entry not found: ${input.commandId}`);
      }
      if (current.status === ApplicationCommandLedgerStatus.Completed) {
        if (current.resultHash === input.resultHash && current.resultJson === input.resultJson) {
          return;
        }
        throw new Error(
          `Application command completion conflicts with stored result: ${input.commandId}`
        );
      }
      assertAttemptMatches(current, input.attemptCount);
      if (!canFinalize(current.status)) {
        throw new Error(
          `Application command cannot be completed from status ${current.status}: ${input.commandId}`
        );
      }
      this.replaceRow({
        ...current,
        status: ApplicationCommandLedgerStatus.Completed,
        failureKind: null,
        retryable: false,
        resultHash: input.resultHash,
        resultJson: input.resultJson,
        updatedAt: input.completedAtIso,
        completedAt: input.completedAtIso,
        lastError: null,
      });
    });
  }

  markFailed(input: ApplicationCommandLedgerFailRequest): void {
    const orm = this.getOrm();
    orm.transaction(() => {
      const current = this.readByCommandId(input);
      if (!current) {
        throw new Error(`Application command ledger entry not found: ${input.commandId}`);
      }
      assertAttemptMatches(current, input.attemptCount);
      const nextStatus = statusForFailure(input.failureKind);
      if (
        current.status === nextStatus &&
        current.failureKind === input.failureKind &&
        current.lastError === input.errorMessage
      ) {
        return;
      }
      if (!canFinalize(current.status)) {
        throw new Error(
          `Application command cannot be failed from status ${current.status}: ${input.commandId}`
        );
      }
      this.replaceRow({
        ...current,
        status: nextStatus,
        failureKind: input.failureKind,
        retryable: input.failureKind === ApplicationCommandFailureKind.Retryable,
        resultHash: null,
        resultJson: null,
        updatedAt: input.completedAtIso,
        completedAt:
          input.failureKind === ApplicationCommandFailureKind.UnknownAfterTimeout
            ? null
            : input.completedAtIso,
        lastError: input.errorMessage,
      });
    });
  }

  getByCommandId(input: ApplicationCommandLedgerReadByCommandIdRequest): AppCommandRecord | null {
    return this.readByCommandId(input);
  }

  getByIdempotencyKey(
    input: ApplicationCommandLedgerReadByIdempotencyKeyRequest
  ): AppCommandRecord | null {
    return this.readByIdempotencyKey(input);
  }

  listByScope(input: ApplicationCommandLedgerListScopeRequest): AppCommandRecord[] {
    return this.getOrm()
      .select()
      .from(applicationCommandLedger)
      .where(
        and(
          eq(applicationCommandLedger.namespace, input.namespace),
          eq(applicationCommandLedger.scopeKey, input.scopeKey)
        )
      )
      .orderBy(asc(applicationCommandLedger.updatedAt), asc(applicationCommandLedger.commandId))
      .all() as AppCommandRecord[];
  }

  private requireDurableRecord(input: {
    deploymentId: string;
    commandId: string;
  }): DurableApplicationCommandRecord {
    const record = this.readDurableRecord(input);
    if (!record) {
      throw new Error(`Durable application command not found: ${input.commandId}`);
    }
    return record;
  }

  private readDurableRecord(input: {
    deploymentId: string;
    commandId: string;
  }): DurableApplicationCommandRecord | null {
    const rows = this.getOrm()
      .select()
      .from(durableApplicationCommands)
      .where(
        and(
          eq(durableApplicationCommands.deploymentId, input.deploymentId),
          eq(durableApplicationCommands.commandId, input.commandId)
        )
      )
      .all() as DurableCommandRow[];
    return rows[0] ? this.mapDurableRecord(rows[0]) : null;
  }

  private readDurableRecordByClaim<TCommandKind extends string>(input: {
    scope: {
      deploymentId: string;
      stableActorId: string;
      commandKind: TCommandKind;
      idempotencyKey: string;
    };
  }): DurableApplicationCommandRecord<TCommandKind> | null {
    const rows = this.getOrm()
      .select()
      .from(durableApplicationCommands)
      .where(
        and(
          eq(durableApplicationCommands.deploymentId, input.scope.deploymentId),
          eq(durableApplicationCommands.stableActorId, input.scope.stableActorId),
          eq(durableApplicationCommands.commandKind, input.scope.commandKind),
          eq(durableApplicationCommands.idempotencyKey, input.scope.idempotencyKey)
        )
      )
      .all() as DurableCommandRow[];
    return rows[0]
      ? (this.mapDurableRecord(rows[0]) as DurableApplicationCommandRecord<TCommandKind>)
      : null;
  }

  private mapDurableRecord(row: DurableCommandRow): DurableApplicationCommandRecord {
    assertKnownDurableCommandRow(row);
    const effects = (
      this.getOrm()
        .select()
        .from(durableApplicationCommandEffects)
        .where(eq(durableApplicationCommandEffects.commandId, row.commandId))
        .orderBy(asc(durableApplicationCommandEffects.ordinal))
        .all() as DurableEffectRow[]
    ).map((effect, ordinal) => {
      assertKnownDurableEffectRow(effect, row.commandId, ordinal);
      const evidence = this.readEffectEvidence(row.commandId, ordinal).map((item, index) =>
        mapEffectEvidence(item, effect, index + 1)
      );
      return {
        effectId: effect.effectId,
        effectVersion: effect.effectVersion,
        recoveryClass: effect.recoveryClass as EffectRecoveryClass,
        evidenceSchemaVersion: effect.evidenceSchemaVersion,
        ordinal: effect.ordinal,
        state: effect.state as DurableEffectState,
        updatedAt: effect.updatedAt,
        evidence,
      };
    });
    if (effects.length === 0) {
      throw new Error(`Durable application command has an empty effect plan: ${row.commandId}`);
    }
    for (const effect of effects) {
      if (
        (effect.state === 'observed_succeeded' || effect.state === 'observed_absent') &&
        effect.evidence.at(-1)?.outcome !== effect.state
      ) {
        throw new Error(
          `Durable application command observed effect is missing matching evidence: ${row.commandId}:${effect.ordinal}`
        );
      }
    }

    const fingerprint: CommandFingerprintRecord = {
      descriptorId: row.descriptorId,
      descriptorVersion: row.descriptorVersion,
      schemaVersion: row.inputSchemaVersion,
      fingerprintVersion: HMAC_SHA256_LD_V1,
      effectPlanVersion: row.effectPlanVersion,
      keyVersion: row.fingerprintKeyVersion,
      digest: row.fingerprintDigest,
    };
    const claim: CommandClaimRecord = {
      scope: createCommandClaimScope({
        deploymentId: row.deploymentId,
        stableActorId: row.stableActorId,
        commandKind: row.commandKind,
        idempotencyKey: row.idempotencyKey,
      }),
      fingerprint,
    };
    // Reuse the accepted contract validator for every status read. This is
    // intentionally not a permissive cast: future algorithms fail closed.
    resolveCommandClaim(null, claim);
    const descriptor = createDurableCommandDescriptorIdentity({
      descriptorId: row.descriptorId,
      descriptorVersion: row.descriptorVersion,
      commandKind: row.commandKind,
      inputSchemaVersion: row.inputSchemaVersion,
      fingerprintVersion: HMAC_SHA256_LD_V1,
      effectPlanVersion: row.effectPlanVersion,
    });
    return {
      commandId: row.commandId,
      claim,
      descriptor,
      attempt: {
        generation: row.attemptGeneration,
        attemptId: row.attemptId,
        ownerId: row.attemptOwnerId,
        leaseToken: row.attemptLeaseToken,
        claimedAt: row.attemptClaimedAt,
        leaseExpiresAt: row.attemptLeaseExpiresAt,
      },
      state: row.state as DurableCommandState,
      retentionClass: row.retentionClass,
      auditSessionId: row.auditSessionId,
      outcomeJson: row.outcomeJson,
      errorCode: row.errorCode,
      errorJson: row.errorJson,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      committedAt: row.committedAt,
      effects,
    };
  }

  private readEffectEvidence(commandId: string, ordinal: number): DurableEffectEvidenceRow[] {
    return this.getOrm()
      .select()
      .from(durableApplicationCommandEffectEvidence)
      .where(
        and(
          eq(durableApplicationCommandEffectEvidence.commandId, commandId),
          eq(durableApplicationCommandEffectEvidence.ordinal, ordinal)
        )
      )
      .orderBy(asc(durableApplicationCommandEffectEvidence.sequence))
      .all() as DurableEffectEvidenceRow[];
  }

  private readOutboxByCommandId(commandId: string): DurableApplicationCommandOutboxRecord | null {
    const rows = this.getOrm()
      .select()
      .from(durableApplicationCommandOutbox)
      .where(eq(durableApplicationCommandOutbox.commandId, commandId))
      .all();
    return rows[0] ? mapOutboxRow(rows[0]) : null;
  }

  private beginExistingCommand(
    current: AppCommandRecord,
    input: AppCommandBeginRequest
  ): AppCommandBeginResult {
    const conflict =
      current.idempotencyKey !== input.idempotencyKey
        ? ApplicationCommandConflictReason.CommandIdReused
        : this.findSemanticConflict(current, input);
    if (conflict) {
      return {
        outcome: ApplicationCommandBeginOutcome.Conflict,
        reason: conflict,
        existing: current,
        requested: input,
      };
    }

    return this.beginExistingMatchingCommand(current, input);
  }

  private beginExistingIdempotencyKey(
    current: AppCommandRecord,
    input: AppCommandBeginRequest
  ): AppCommandBeginResult {
    const conflict = this.findSemanticConflict(current, input);
    if (conflict) {
      return {
        outcome: ApplicationCommandBeginOutcome.Conflict,
        reason: conflict,
        existing: current,
        requested: input,
      };
    }

    return this.beginExistingMatchingCommand(current, input);
  }

  private beginExistingMatchingCommand(
    current: AppCommandRecord,
    input: AppCommandBeginRequest
  ): AppCommandBeginResult {
    switch (current.status) {
      case ApplicationCommandLedgerStatus.Started:
        if (isStartedStale(current, input)) {
          const next: AppCommandRecord = {
            ...current,
            status: ApplicationCommandLedgerStatus.UnknownAfterTimeout,
            failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
            retryable: false,
            updatedAt: input.nowIso,
            completedAt: null,
            lastError: `Started attempt ${current.attemptCount} exceeded ${input.startedStaleAfterMs}ms and requires reconciliation`,
          };
          this.replaceRow(next);
          return {
            outcome: ApplicationCommandBeginOutcome.UnknownAfterTimeout,
            record: next,
          };
        }
        return { outcome: ApplicationCommandBeginOutcome.AlreadyStarted, record: current };
      case ApplicationCommandLedgerStatus.Completed:
        return { outcome: ApplicationCommandBeginOutcome.DuplicateCompleted, record: current };
      case ApplicationCommandLedgerStatus.FailedRetryable:
        return this.restartRetryable(current, input);
      case ApplicationCommandLedgerStatus.FailedTerminal:
        return { outcome: ApplicationCommandBeginOutcome.FailedTerminal, record: current };
      case ApplicationCommandLedgerStatus.UnknownAfterTimeout:
        return { outcome: ApplicationCommandBeginOutcome.UnknownAfterTimeout, record: current };
      default:
        return {
          outcome: ApplicationCommandBeginOutcome.Conflict,
          reason: ApplicationCommandConflictReason.OperationMismatch,
          existing: current,
          requested: input,
        };
    }
  }

  private restartRetryable(
    current: AppCommandRecord,
    input: AppCommandBeginRequest
  ): AppCommandBeginResult {
    const next: AppCommandRecord = {
      ...current,
      operation: input.operation,
      payloadHash: input.payloadHash,
      status: ApplicationCommandLedgerStatus.Started,
      failureKind: null,
      retryable: false,
      attemptCount: current.attemptCount + 1,
      resultHash: null,
      resultJson: null,
      metadataJson: input.metadataJson,
      updatedAt: input.nowIso,
      completedAt: null,
      lastError: null,
    };
    this.replaceRow(next);
    return { outcome: ApplicationCommandBeginOutcome.RetryStarted, record: next };
  }

  private findSemanticConflict(
    current: AppCommandRecord,
    input: AppCommandBeginRequest
  ): ApplicationCommandConflictReason | null {
    if (current.operation !== input.operation) {
      return ApplicationCommandConflictReason.OperationMismatch;
    }
    if (current.payloadHash !== input.payloadHash) {
      return ApplicationCommandConflictReason.PayloadHashMismatch;
    }
    return null;
  }

  private readByCommandId(input: {
    namespace: string;
    scopeKey: string;
    commandId: string;
  }): AppCommandRecord | null {
    const rows = this.getOrm()
      .select()
      .from(applicationCommandLedger)
      .where(
        and(
          eq(applicationCommandLedger.namespace, input.namespace),
          eq(applicationCommandLedger.scopeKey, input.scopeKey),
          eq(applicationCommandLedger.commandId, input.commandId)
        )
      )
      .all() as AppCommandRecord[];
    return rows[0] ?? null;
  }

  private readByIdempotencyKey(input: {
    namespace: string;
    scopeKey: string;
    idempotencyKey: string;
  }): AppCommandRecord | null {
    const rows = this.getOrm()
      .select()
      .from(applicationCommandLedger)
      .where(
        and(
          eq(applicationCommandLedger.namespace, input.namespace),
          eq(applicationCommandLedger.scopeKey, input.scopeKey),
          eq(applicationCommandLedger.idempotencyKey, input.idempotencyKey)
        )
      )
      .all() as AppCommandRecord[];
    return rows[0] ?? null;
  }

  private replaceRow(row: AppCommandRecord): void {
    this.getOrm()
      .update(applicationCommandLedger)
      .set({
        idempotencyKey: row.idempotencyKey,
        operation: row.operation,
        payloadHash: row.payloadHash,
        status: row.status,
        failureKind: row.failureKind,
        retryable: row.retryable,
        attemptCount: row.attemptCount,
        resultHash: row.resultHash,
        resultJson: row.resultJson,
        metadataJson: row.metadataJson,
        startedAt: row.startedAt,
        updatedAt: row.updatedAt,
        completedAt: row.completedAt,
        lastError: row.lastError,
      })
      .where(
        and(
          eq(applicationCommandLedger.namespace, row.namespace),
          eq(applicationCommandLedger.scopeKey, row.scopeKey),
          eq(applicationCommandLedger.commandId, row.commandId)
        )
      )
      .run();
  }
}

function validateDurableClaim<TCommandKind extends string>(
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

function validateDurableAttemptClaim(input: DurableApplicationCommandAttemptClaim): void {
  assertIdentifier('attempt.attemptId', input.attemptId);
  assertIdentifier('attempt.ownerId', input.ownerId);
  assertIdentifier('attempt.leaseToken', input.leaseToken);
  assertLeaseWindow(input.claimedAtIso, input.leaseExpiresAtIso, 'attempt');
}

function validateDurableAttemptReference(input: DurableApplicationCommandAttemptReference): void {
  assertPositiveVersion('attempt.generation', input.generation);
  assertIdentifier('attempt.attemptId', input.attemptId);
  assertIdentifier('attempt.ownerId', input.ownerId);
  assertIdentifier('attempt.leaseToken', input.leaseToken);
}

function validateDurableAttemptLease(input: DurableApplicationCommandAttemptLeaseRequest): void {
  assertIdentifier('deploymentId', input.deploymentId);
  assertIdentifier('commandId', input.commandId);
  validateDurableAttemptReference(input.attempt);
  assertLeaseWindow(input.renewedAtIso, input.leaseExpiresAtIso, 'attempt renewal');
}

function validateDurableCommandTransition(input: DurableApplicationCommandTransitionRequest): void {
  assertIdentifier('deploymentId', input.deploymentId);
  assertIdentifier('commandId', input.commandId);
  validateDurableAttemptReference(input.attempt);
  assertKnownCommandState(input.expectedState);
  assertKnownCommandState(input.nextState);
  if (input.errorCode !== null) assertIdentifier('errorCode', input.errorCode);
  if (input.errorJson !== null) assertSafeJson('errorJson', input.errorJson);
  assertIsoTimestamp('transitionedAtIso', input.transitionedAtIso);
}

function validateDurableEffectTransition(
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

function validateDurableCommit(input: DurableApplicationCommandCommitRequest): void {
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

function validateDurableOutboxClaim(input: DurableApplicationCommandOutboxClaimRequest): void {
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

function validateDurableOutboxDeliveryAcknowledgement(
  input: DurableApplicationCommandOutboxDeliveryAcknowledgementRequest
): void {
  assertIdentifier('outbox.eventId', input.eventId);
  assertPositiveVersion('outbox.deliveryGeneration', input.deliveryGeneration);
  assertIdentifier('outbox.ownerId', input.ownerId);
  assertIdentifier('outbox.leaseToken', input.leaseToken);
  assertIsoTimestamp('outbox.acknowledgedAtIso', input.acknowledgedAtIso);
}

function validateDurableConsumerProjectionRequest(
  input: DurableApplicationCommandConsumerProjectionRequest
): void {
  assertIdentifier('consumer.consumerId', input.consumerId);
  assertIdentifier('consumer.projectionKey', input.projectionKey);
}

function validateDurableConsumerApply(input: DurableApplicationCommandConsumerApplyRequest): void {
  validateDurableConsumerProjectionRequest(input);
  assertIdentifier('consumer.eventId', input.eventId);
  assertPositiveVersion('consumer.semanticRevision', input.semanticRevision);
  assertSafeJson('consumer.stateJson', input.stateJson);
  assertIsoTimestamp('consumer.appliedAtIso', input.appliedAtIso);
}

function assertKnownDurableCommandRow(row: DurableCommandRow): void {
  assertIdentifier('commandId', row.commandId);
  assertIdentifier('deploymentId', row.deploymentId);
  assertIdentifier('stableActorId', row.stableActorId);
  assertIdentifier('commandKind', row.commandKind);
  assertIdentifier('idempotencyKey', row.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  assertIdentifier('descriptorId', row.descriptorId);
  assertPositiveVersion('descriptorVersion', row.descriptorVersion);
  assertPositiveVersion('inputSchemaVersion', row.inputSchemaVersion);
  if (row.fingerprintVersion !== HMAC_SHA256_LD_V1) {
    throw new Error(
      `Unsupported durable application command fingerprint version: ${row.fingerprintVersion}`
    );
  }
  assertPositiveVersion('effectPlanVersion', row.effectPlanVersion);
  assertIdentifier('fingerprintKeyVersion', row.fingerprintKeyVersion);
  if (!/^[a-f0-9]{64}$/.test(row.fingerprintDigest)) {
    throw new Error('Invalid persisted durable application command fingerprint digest');
  }
  assertPositiveVersion('attemptGeneration', row.attemptGeneration);
  assertIdentifier('attemptId', row.attemptId);
  assertIdentifier('attemptOwnerId', row.attemptOwnerId);
  assertIdentifier('attemptLeaseToken', row.attemptLeaseToken);
  assertLeaseWindow(row.attemptClaimedAt, row.attemptLeaseExpiresAt, 'persisted attempt');
  assertKnownCommandState(row.state);
  assertIdentifier('retentionClass', row.retentionClass);
  if (row.auditSessionId !== null) assertIdentifier('auditSessionId', row.auditSessionId);
  if (row.outcomeJson !== null) assertSafeJson('outcomeJson', row.outcomeJson);
  if (row.errorCode !== null) assertIdentifier('errorCode', row.errorCode);
  if (row.errorJson !== null) assertSafeJson('errorJson', row.errorJson);
  assertIsoTimestamp('createdAt', row.createdAt);
  assertIsoTimestamp('updatedAt', row.updatedAt);
  if (row.committedAt !== null) assertIsoTimestamp('committedAt', row.committedAt);
  if (row.state === 'committed') {
    if (
      row.committedAt === null ||
      row.outcomeJson === null ||
      row.errorCode !== null ||
      row.errorJson !== null
    ) {
      throw new Error(
        `Invalid persisted durable application command terminal shape: ${row.commandId}`
      );
    }
    return;
  }
  if (row.committedAt !== null || row.outcomeJson !== null) {
    throw new Error(
      `Invalid persisted durable application command terminal shape: ${row.commandId}`
    );
  }
  const requiresError = row.state === 'failed' || row.state === 'operator_required';
  if (requiresError !== (row.errorCode !== null)) {
    throw new Error(`Invalid persisted durable application command error shape: ${row.commandId}`);
  }
  if (!requiresError && row.errorJson !== null) {
    throw new Error(`Invalid persisted durable application command error shape: ${row.commandId}`);
  }
}

function assertKnownDurableEffectRow(
  row: DurableEffectRow,
  commandId: string,
  expectedOrdinal: number
): void {
  if (row.commandId !== commandId || row.ordinal !== expectedOrdinal) {
    throw new Error(`Invalid persisted durable application command effect order: ${commandId}`);
  }
  assertIdentifier('effectId', row.effectId);
  assertPositiveVersion('effectVersion', row.effectVersion);
  if (!EFFECT_RECOVERY_CLASSES.includes(row.recoveryClass as EffectRecoveryClass)) {
    throw new Error(
      `Unsupported durable application command effect recovery class: ${row.recoveryClass}`
    );
  }
  assertPositiveVersion('evidenceSchemaVersion', row.evidenceSchemaVersion);
  assertKnownEffectState(row.state);
  assertIsoTimestamp('effect.updatedAt', row.updatedAt);
}

function mapEffectEvidence(
  row: DurableEffectEvidenceRow,
  effect: DurableEffectRow,
  expectedSequence: number
): DurableApplicationCommandEffectEvidenceRecord {
  if (
    row.commandId !== effect.commandId ||
    row.ordinal !== effect.ordinal ||
    row.sequence !== expectedSequence
  ) {
    throw new Error('Invalid persisted durable application command effect evidence identity');
  }
  if (row.outcome !== 'observed_succeeded' && row.outcome !== 'observed_absent') {
    throw new Error(
      `Unsupported durable application command effect evidence outcome: ${row.outcome}`
    );
  }
  if (row.evidenceSchemaVersion !== effect.evidenceSchemaVersion) {
    throw new Error(
      `Unsupported durable application command effect evidence schema: ${row.evidenceSchemaVersion}`
    );
  }
  assertSafeJson('evidenceJson', row.evidenceJson);
  assertIsoTimestamp('evidence.recordedAt', row.recordedAt);
  return {
    sequence: row.sequence,
    effectId: effect.effectId,
    effectVersion: effect.effectVersion,
    recoveryClass: effect.recoveryClass as EffectRecoveryClass,
    evidenceSchemaVersion: row.evidenceSchemaVersion,
    outcome: row.outcome,
    evidenceJson: row.evidenceJson,
    recordedAt: row.recordedAt,
  };
}

function mapOutboxRow(row: DurableOutboxRow): DurableApplicationCommandOutboxRecord {
  if (!Number.isSafeInteger(row.sequence) || row.sequence <= 0) {
    throw new Error('Invalid durable application command outbox sequence');
  }
  assertIdentifier('outbox.eventId', row.eventId);
  assertIdentifier('outbox.commandId', row.commandId);
  assertIdentifier('outbox.deploymentId', row.deploymentId);
  assertIdentifier('outbox.eventType', row.eventType);
  assertIdentifier('outbox.scopeKind', row.scopeKind);
  assertIdentifier('outbox.scopeId', row.scopeId);
  assertPositiveVersion('outbox.schemaVersion', row.schemaVersion);
  assertPositiveVersion('outbox.semanticRevision', row.semanticRevision);
  assertSafeJson('outbox.payloadJson', row.payloadJson);
  assertIsoTimestamp('outbox.createdAt', row.createdAt);
  let deliveryLease: DurableApplicationCommandOutboxRecord['deliveryLease'] = null;
  if (row.deliveryGeneration === 0) {
    if (
      row.deliveryOwnerId !== null ||
      row.deliveryLeaseToken !== null ||
      row.deliveryClaimedAt !== null ||
      row.deliveryLeaseExpiresAt !== null
    ) {
      throw new Error('Invalid durable application command outbox delivery lease shape');
    }
  } else {
    assertPositiveVersion('outbox.deliveryGeneration', row.deliveryGeneration);
    assertIdentifier('outbox.deliveryOwnerId', row.deliveryOwnerId);
    assertIdentifier('outbox.deliveryLeaseToken', row.deliveryLeaseToken);
    if (row.deliveryClaimedAt === null || row.deliveryLeaseExpiresAt === null) {
      throw new Error('Invalid durable application command outbox delivery lease shape');
    }
    assertLeaseWindow(row.deliveryClaimedAt, row.deliveryLeaseExpiresAt, 'outbox delivery');
    deliveryLease = {
      generation: row.deliveryGeneration,
      ownerId: row.deliveryOwnerId,
      leaseToken: row.deliveryLeaseToken,
      claimedAt: row.deliveryClaimedAt,
      leaseExpiresAt: row.deliveryLeaseExpiresAt,
    };
  }
  if (row.deliveryAcknowledgedAt !== null) {
    assertIsoTimestamp('outbox.deliveryAcknowledgedAt', row.deliveryAcknowledgedAt);
  }
  if (row.deliveryAcknowledgedAt !== null && deliveryLease === null) {
    throw new Error('Acknowledged durable application command outbox event has no delivery lease');
  }
  if (
    row.deliveryAcknowledgedAt !== null &&
    deliveryLease !== null &&
    (Date.parse(row.deliveryAcknowledgedAt) < Date.parse(deliveryLease.claimedAt) ||
      Date.parse(row.deliveryAcknowledgedAt) >= Date.parse(deliveryLease.leaseExpiresAt))
  ) {
    throw new Error(
      'Acknowledged durable application command outbox event is outside its delivery lease'
    );
  }
  return {
    sequence: row.sequence,
    eventId: row.eventId,
    commandId: row.commandId,
    deploymentId: row.deploymentId,
    eventType: row.eventType,
    scopeKind: row.scopeKind,
    scopeId: row.scopeId,
    schemaVersion: row.schemaVersion,
    semanticRevision: row.semanticRevision,
    payloadJson: row.payloadJson,
    createdAt: row.createdAt,
    deliveryLease,
    deliveryAcknowledgedAt: row.deliveryAcknowledgedAt,
  };
}

function sameOutboxInput(
  row: DurableApplicationCommandOutboxRecord,
  input: DurableApplicationCommandCommitRequest['outbox']
): boolean {
  return (
    row.eventId === input.eventId &&
    row.eventType === input.eventType &&
    row.scopeKind === input.scopeKind &&
    row.scopeId === input.scopeId &&
    row.schemaVersion === input.schemaVersion &&
    row.semanticRevision === input.semanticRevision &&
    row.payloadJson === input.payloadJson &&
    row.createdAt === input.createdAtIso
  );
}

function mapConsumerApplicationRow(
  row: DurableConsumerApplicationRow
): DurableApplicationCommandConsumerApplicationRecord {
  assertIdentifier('consumer.consumerId', row.consumerId);
  assertIdentifier('consumer.eventId', row.eventId);
  assertPositiveVersion('consumer.semanticRevision', row.semanticRevision);
  assertIdentifier('consumer.projectionKey', row.projectionKey);
  assertSafeJson('consumer.stateJson', row.stateJson);
  assertIsoTimestamp('consumer.appliedAt', row.appliedAt);
  return { ...row };
}

function mapConsumerProjectionRow(
  row: DurableConsumerProjectionRow
): DurableApplicationCommandConsumerProjectionRecord {
  assertIdentifier('consumer.consumerId', row.consumerId);
  assertIdentifier('consumer.projectionKey', row.projectionKey);
  assertPositiveVersion('consumer.semanticRevision', row.semanticRevision);
  assertIdentifier('consumer.lastEventId', row.lastEventId);
  assertSafeJson('consumer.stateJson', row.stateJson);
  assertPositiveVersion('consumer.applicationCount', row.applicationCount);
  assertIsoTimestamp('consumer.updatedAt', row.updatedAt);
  return { ...row };
}

function effectDescriptor(
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

function sameEffectIdentity(left: EffectDescriptor, right: EffectDescriptor): boolean {
  return (
    left.effectId === right.effectId &&
    left.effectVersion === right.effectVersion &&
    left.recoveryClass === right.recoveryClass &&
    left.evidenceSchemaVersion === right.evidenceSchemaVersion
  );
}

function assertEvidenceMatchesEffect(
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

function sameClaimScope(left: CommandClaimRecord, right: CommandClaimRecord): boolean {
  return (
    left.scope.deploymentId === right.scope.deploymentId &&
    left.scope.stableActorId === right.scope.stableActorId &&
    left.scope.commandKind === right.scope.commandKind &&
    left.scope.idempotencyKey === right.scope.idempotencyKey
  );
}

function sameAttemptClaim(
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

function assertDurableAttemptFence(
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

function isDurableCommandTerminal(state: DurableCommandState): boolean {
  return state === 'committed' || state === 'failed' || state === 'operator_required';
}

function sameOutboxDeliveryClaim(
  current: DurableApplicationCommandOutboxRecord,
  requested: DurableApplicationCommandOutboxClaimRequest
): boolean {
  return (
    current.deliveryLease?.ownerId === requested.ownerId &&
    current.deliveryLease.leaseToken === requested.leaseToken
  );
}

function assertOutboxDeliveryFence(
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

function staleDurableCommandState(
  current: DurableApplicationCommandRecord,
  requested: DurableCommandState
): Error {
  return new Error(
    `Durable application command state is stale: ${current.commandId} expected=${requested} actual=${current.state}`
  );
}

function assertKnownCommandState(value: string): asserts value is DurableCommandState {
  if (!DURABLE_COMMAND_STATES.includes(value as DurableCommandState)) {
    throw new Error(`Unsupported durable application command state: ${value}`);
  }
}

function assertKnownEffectState(value: string): asserts value is DurableEffectState {
  if (!DURABLE_EFFECT_STATES.includes(value as DurableEffectState)) {
    throw new Error(`Unsupported durable application command effect state: ${value}`);
  }
}

function assertIdentifier(
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

function assertPositiveVersion(field: string, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Durable application command ${field} must be a positive safe integer`);
  }
}

function assertIsoTimestamp(field: string, value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Durable application command ${field} must be an ISO timestamp`);
  }
}

function assertLeaseWindow(claimedAtIso: string, leaseExpiresAtIso: string, field: string): void {
  assertIsoTimestamp(`${field}.claimedAt`, claimedAtIso);
  assertIsoTimestamp(`${field}.leaseExpiresAt`, leaseExpiresAtIso);
  if (Date.parse(leaseExpiresAtIso) <= Date.parse(claimedAtIso)) {
    throw new Error(`Durable application command ${field} lease must expire after it is claimed`);
  }
}

function assertSafeJson(field: string, value: string): void {
  if (new TextEncoder().encode(value).byteLength > MAX_SAFE_JSON_BYTES) {
    throw new Error(`Durable application command ${field} exceeds the storage budget`);
  }
  try {
    JSON.parse(value);
  } catch {
    throw new Error(`Durable application command ${field} must be valid JSON`);
  }
}

function canFinalize(status: ApplicationCommandLedgerStatus): boolean {
  return (
    status === ApplicationCommandLedgerStatus.Started ||
    status === ApplicationCommandLedgerStatus.UnknownAfterTimeout
  );
}

function assertAttemptMatches(current: AppCommandRecord, requestedAttemptCount: number): void {
  if (current.attemptCount !== requestedAttemptCount) {
    throw new Error(
      `Application command attempt is stale: ${current.commandId} expected=${current.attemptCount} actual=${requestedAttemptCount}`
    );
  }
}

function assertValidBeginTiming(input: AppCommandBeginRequest): void {
  if (!Number.isSafeInteger(input.startedStaleAfterMs) || input.startedStaleAfterMs <= 0) {
    throw new Error('Application command startedStaleAfterMs must be a positive integer');
  }
  if (!Number.isFinite(Date.parse(input.nowIso))) {
    throw new Error('Application command nowIso must be a valid ISO timestamp');
  }
}

function isStartedStale(current: AppCommandRecord, input: AppCommandBeginRequest): boolean {
  const attemptStartedAtMs = Date.parse(current.updatedAt);
  if (!Number.isFinite(attemptStartedAtMs)) {
    return true;
  }
  return Date.parse(input.nowIso) - attemptStartedAtMs >= input.startedStaleAfterMs;
}

function statusForFailure(
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

import {
  classifyAmbiguousEffect,
  commitDurableCommand as assertDurableCommandCommit,
  createCommandClaimScope,
  resolveAmbiguousDurableEffect,
  resolveCommandClaim,
  retryDurableEffectAfterObservedAbsent,
  transitionDurableCommandState,
  transitionDurableEffectState,
} from '@features/application-command-ledger';
import { and, eq } from 'drizzle-orm';

import * as mapping from './applicationCommandLedgerMapping';
import * as validation from './applicationCommandLedgerValidation';
import {
  appendCommandOutboxEventToJournal,
  assertCoordinationMutationAdmissionOpen,
  canonicalCoordinationStorageJson,
  createLegacyCommandCoordinationAttribution,
  materializeCommandCoordinationAttribution,
} from './coordinationDurabilityWorkerOps';
import {
  durableApplicationCommandEffectEvidence,
  durableApplicationCommandEffects,
  durableApplicationCommandOutbox,
  durableApplicationCommands,
} from './internalStorageSchema';

import type { StoredCommandCoordinationAttribution } from './internalStorageWorkerProtocol';
import type {
  DurableApplicationCommandAttemptClaim,
  DurableApplicationCommandAttemptLeaseRequest,
  DurableApplicationCommandClaimResult,
  DurableApplicationCommandClaimStatusRequest,
  DurableApplicationCommandCommitRequest,
  DurableApplicationCommandEffectTransitionRequest,
  DurableApplicationCommandPersistClaimRequest,
  DurableApplicationCommandRecord,
  DurableApplicationCommandStatusRequest,
  DurableApplicationCommandTransitionRequest,
} from '@features/application-command-ledger';
import type {
  CommandClaimRecord,
  DurableCommandState,
  DurableEffectState,
  EffectDescriptor,
} from '@features/application-command-ledger/contracts';
import type DatabaseConstructor from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

import type { ApplicationCommandLedgerRecordRepository } from './applicationCommandLedgerRecordRepository';

export class DurableApplicationCommandWorkerOps {
  constructor(
    private readonly getOrm: () => BetterSQLite3Database,
    private readonly getDb: () => SqliteDatabase,
    private readonly repository: ApplicationCommandLedgerRecordRepository
  ) {}

  durableClaim<TCommandKind extends string>(
    input: DurableApplicationCommandPersistClaimRequest<TCommandKind> & {
      readonly coordinationAttribution?: StoredCommandCoordinationAttribution;
    }
  ): DurableApplicationCommandClaimResult<TCommandKind> {
    const validated = validation.validateDurableClaim(input);
    const attribution = materializeCommandCoordinationAttribution(
      input.coordinationAttribution ??
        createLegacyCommandCoordinationAttribution(validated.scope.stableActorId)
    );
    const attributionJson = canonicalCoordinationStorageJson(attribution);
    const orm = this.getOrm();

    return orm.transaction(
      () => {
        const preexistingClaim = this.repository.readDurableRecordByClaim({
          scope: validated.scope,
        });
        if (!preexistingClaim) {
          assertCoordinationMutationAdmissionOpen(this.getDb(), validated.scope.deploymentId);
        }
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
            coordinationAttributionJson: attributionJson,
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

        const byCommandId = this.repository.readDurableRecord({
          deploymentId: validated.scope.deploymentId,
          commandId: validated.commandId,
        });
        const byClaim = this.repository.readDurableRecordByClaim({ scope: validated.scope });
        if (byCommandId && byClaim && byCommandId.commandId !== byClaim.commandId) {
          throw new Error(
            'Durable application command claim conflicts with both an existing command id and claim scope'
          );
        }
        let command = byClaim ?? byCommandId;
        if (!command) {
          throw new Error('Durable application command claim did not converge to a stored record');
        }
        if (
          this.repository.requireCoordinationAttributionJson(command.commandId) !== attributionJson
        ) {
          throw new Error('Durable application command coordination attribution conflicts');
        }

        const incoming: CommandClaimRecord<TCommandKind> = {
          scope: validated.scope,
          fingerprint: validated.fingerprint,
        };
        if (!validation.sameClaimScope(command.claim, incoming)) {
          throw new Error(
            `Durable application command id is already in use: ${validated.commandId}`
          );
        }

        const resolution = created
          ? resolveCommandClaim<TCommandKind>(null, incoming)
          : resolveCommandClaim(command.claim as CommandClaimRecord<TCommandKind>, incoming);
        let attemptAcquired =
          resolution.outcome !== 'idempotency_mismatch' &&
          !validation.isDurableCommandTerminal(command.state) &&
          (created || validation.sameAttemptClaim(command, validated.attempt));
        if (!created && resolution.outcome === 'same_intent' && !attemptAcquired) {
          attemptAcquired = this.tryAcquireExpiredDurableAttempt(command, validated.attempt);
          if (attemptAcquired) {
            command = this.repository.requireDurableRecord({
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
    validation.assertIdentifier('deploymentId', input.deploymentId);
    validation.assertIdentifier('commandId', input.commandId);
    const orm = this.getOrm();
    return orm.transaction(
      () =>
        this.repository.readDurableRecord(
          input
        ) as DurableApplicationCommandRecord<TCommandKind> | null
    );
  }

  durableGetByClaim<TCommandKind extends string>(
    input: DurableApplicationCommandClaimStatusRequest<TCommandKind>
  ): DurableApplicationCommandRecord<TCommandKind> | null {
    const scope = createCommandClaimScope(input.scope);
    const orm = this.getOrm();
    return orm.transaction(() => this.repository.readDurableRecordByClaim({ scope }));
  }

  durableRenewAttemptLease(
    input: DurableApplicationCommandAttemptLeaseRequest
  ): DurableApplicationCommandRecord {
    validation.validateDurableAttemptLease(input);
    const orm = this.getOrm();
    return orm.transaction(
      () => {
        const current = this.repository.requireDurableRecord(input);
        validation.assertDurableAttemptFence(current, input.attempt, input.renewedAtIso);
        if (validation.isDurableCommandTerminal(current.state)) {
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
        return this.repository.requireDurableRecord(input);
      },
      { behavior: 'immediate' }
    );
  }

  durableTransitionCommand(
    input: DurableApplicationCommandTransitionRequest
  ): DurableApplicationCommandRecord {
    validation.validateDurableCommandTransition(input);
    const orm = this.getOrm();
    return orm.transaction(
      () => {
        const current = this.repository.requireDurableRecord(input);
        validation.assertDurableAttemptFence(current, input.attempt, input.transitionedAtIso);
        if (current.state !== input.expectedState) {
          throw validation.staleDurableCommandState(current, input.expectedState);
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
        return this.repository.requireDurableRecord(input);
      },
      { behavior: 'immediate' }
    );
  }

  durableTransitionEffect(
    input: DurableApplicationCommandEffectTransitionRequest
  ): DurableApplicationCommandRecord {
    validation.validateDurableEffectTransition(input);
    const orm = this.getOrm();
    return orm.transaction(
      () => {
        const current = this.repository.requireDurableRecord(input);
        validation.assertDurableAttemptFence(current, input.attempt, input.transitionedAtIso);
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

        const descriptor = validation.effectDescriptor(effect);
        let nextState: DurableEffectState;
        const isObserved =
          input.nextState === 'observed_succeeded' || input.nextState === 'observed_absent';
        if (isObserved) {
          if (!input.evidence || input.evidenceJson === null) {
            throw new Error('Observed durable effect state requires validated evidence');
          }
          validation.assertEvidenceMatchesEffect(input.evidence, descriptor, input.nextState);
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
          const evidenceRows = this.repository.readEffectEvidence(current.commandId, input.ordinal);
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
        return this.repository.requireDurableRecord(input);
      },
      { behavior: 'immediate' }
    );
  }

  durableCommit(input: DurableApplicationCommandCommitRequest): DurableApplicationCommandRecord {
    validation.validateDurableCommit(input);
    const orm = this.getOrm();
    return orm.transaction(
      () => {
        const current = this.repository.requireDurableRecord(input);
        validation.assertDurableAttemptFence(current, input.attempt, input.committedAtIso);
        if (current.state === 'committed') {
          const storedOutbox = this.repository.readOutboxByCommandId(current.commandId);
          if (
            current.outcomeJson === input.outcomeJson &&
            storedOutbox &&
            mapping.sameOutboxInput(storedOutbox, input.outbox)
          ) {
            return current;
          }
          throw new Error(`Durable application command commit conflicts: ${current.commandId}`);
        }
        if (current.state !== input.expectedState) {
          throw validation.staleDurableCommandState(current, input.expectedState);
        }

        const descriptor = {
          ...current.descriptor,
          effects: current.effects.map(validation.effectDescriptor) as [
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
        appendCommandOutboxEventToJournal(this.getDb(), {
          commandId: current.commandId,
          deploymentId: current.claim.scope.deploymentId,
          attribution: this.repository.readCoordinationAttribution(current.commandId),
          outbox: input.outbox,
        });
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
        return this.repository.requireDurableRecord(input);
      },
      { behavior: 'immediate' }
    );
  }

  tryAcquireExpiredDurableAttempt(
    current: DurableApplicationCommandRecord,
    attempt: DurableApplicationCommandAttemptClaim
  ): boolean {
    if (
      validation.isDurableCommandTerminal(current.state) ||
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
      transitionDurableEffectState(validation.effectDescriptor(effect), effect.state, 'ambiguous');
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
}

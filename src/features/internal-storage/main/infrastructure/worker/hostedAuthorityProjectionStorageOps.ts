import { resolveCommandClaim, stableJsonStringify } from '@features/application-command-ledger';

import {
  encodeHostedAuthorityProjectionReceiptEnvelope,
  HOSTED_AUTHORITY_PROJECTION_RECEIPT_CODEC_VERSION,
  parseHostedAuthorityProjectionPersistRequest,
  parseHostedAuthorityProjectionReadRequest,
  parseHostedAuthorityProjectionReceiptEnvelope,
  parseHostedAuthorityProjectionRecord,
} from '../../application/hostedAuthorityProjectionStorage';

import * as validation from './applicationCommandLedgerValidation';
import {
  appendCommandOutboxEventToJournal,
  assertInternalStorageMutationAdmissionOpen,
  canonicalCoordinationStorageJson,
  materializeCommandCoordinationAttribution,
} from './coordinationDurabilityWorkerOps';

import type { ApplicationCommandLedgerRecordRepository } from './applicationCommandLedgerRecordRepository';
import type {
  DurableApplicationCommandPersistClaimRequest,
  HostedAuthorityProjectionCommitResult,
  HostedAuthorityProjectionPersistRequest,
  HostedAuthorityProjectionReadRequest,
  HostedAuthorityProjectionReceiptRecord,
  HostedAuthorityProjectionRecord,
} from '@features/application-command-ledger';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

interface ProjectionRow {
  readonly deploymentId: string;
  readonly projectionKind: string;
  readonly projectionKey: string;
  readonly generation: number;
  readonly revision: number;
  readonly stateJson: string;
  readonly lastCommandId: string;
  readonly updatedAt: string;
  readonly commandState: string;
  readonly commandDeploymentId: string;
  readonly commandOutcomeJson: string | null;
  readonly commandCommittedAt: string | null;
}

interface JournalBindingRow {
  readonly deploymentId: string;
  readonly eventId: string;
  readonly bodyJson: string;
  readonly emittedAt: string;
  readonly originCommandId: string | null;
  readonly createdAt: string;
}

const ATOMIC_ATTEMPT_OWNER = 'hosted-authority-projection-atomic-v1';
const ATOMIC_ATTEMPT_EXPIRY = '9999-12-31T23:59:59.999Z';

export class HostedAuthorityProjectionStorageOps {
  constructor(
    private readonly getDb: () => SqliteDatabase,
    private readonly repository: ApplicationCommandLedgerRecordRepository
  ) {}

  commit(value: unknown): HostedAuthorityProjectionCommitResult {
    const input = parseHostedAuthorityProjectionPersistRequest(value);
    const attempt = {
      attemptId: `atomic:${input.commandId}`,
      ownerId: ATOMIC_ATTEMPT_OWNER,
      leaseToken: `atomic:${input.commandId}`,
      claimedAtIso: input.committedAtIso,
      leaseExpiresAtIso: ATOMIC_ATTEMPT_EXPIRY,
    };
    const validated = validation.validateDurableClaim({
      ...input,
      createdAtIso: input.committedAtIso,
      attempt,
    });
    if (validated.effectPlan.some((effect) => effect.recoveryClass !== 'transactional_local')) {
      throw new Error('hosted-authority-projection-effect-must-be-transactional-local');
    }
    const envelopeJson = encodeHostedAuthorityProjectionReceiptEnvelope({
      codecVersion: HOSTED_AUTHORITY_PROJECTION_RECEIPT_CODEC_VERSION,
      deploymentId: validated.scope.deploymentId,
      commandId: input.commandId,
      projectionKind: input.projection.projectionKind,
      projectionKey: input.projection.projectionKey,
      expectedGeneration: input.projection.expectedGeneration,
      expectedRevision: input.projection.expectedRevision,
      generation: input.projection.nextGeneration,
      revision: input.projection.nextRevision,
      stateJson: input.projection.stateJson,
      eventId: input.outbox.eventId,
      receiptJson: input.receiptJson,
      committedAt: input.committedAtIso,
    });
    validation.validateDurableCommit({
      deploymentId: validated.scope.deploymentId,
      commandId: validated.commandId,
      attempt: {
        generation: 1,
        attemptId: attempt.attemptId,
        ownerId: attempt.ownerId,
        leaseToken: attempt.leaseToken,
      },
      expectedState: 'running',
      outcomeJson: envelopeJson,
      committedAtIso: input.committedAtIso,
      outbox: input.outbox,
    });
    if (Date.parse(input.committedAtIso) > input.deadlineAtMs) {
      throw new Error('hosted-authority-projection-deadline-invalid');
    }

    const attribution = materializeCommandCoordinationAttribution({
      actor: input.attribution.actor,
      ...(input.attribution.actor.kind === 'verified_runtime'
        ? { runId: input.attribution.actor.runId }
        : {}),
      provenance: 'trusted_context_v1',
    });
    const attributionJson = canonicalCoordinationStorageJson(attribution);
    const db = this.getDb();

    // better-sqlite3's immediate() issues BEGIN IMMEDIATE before the first read.
    return db
      .transaction(() => {
        assertDeadlineOpen(input.deadlineAtMs);
        assertInternalStorageMutationAdmissionOpen(db, null);
        const current = this.readProjectionRow({
          deploymentId: validated.scope.deploymentId,
          projectionKind: input.projection.projectionKind,
          projectionKey: input.projection.projectionKey,
          deadlineAtMs: input.deadlineAtMs,
        });

        // Generation is the authority-incarnation fence and must win even over
        // an otherwise matching idempotency receipt from an older incarnation.
        if (current && current.generation !== input.projection.expectedGeneration) {
          return staleResult('stale_generation', current);
        }

        const byClaim = this.repository.readDurableRecordByClaim({ scope: validated.scope });
        const byCommandId = this.repository.readDurableRecord({
          deploymentId: validated.scope.deploymentId,
          commandId: validated.commandId,
        });
        if (byCommandId && byClaim && byCommandId.commandId !== byClaim.commandId) {
          throw new Error('hosted-authority-projection-command-identity-ambiguous');
        }
        if (byCommandId && !byClaim) {
          throw new Error('hosted-authority-projection-command-id-reused');
        }
        if (byClaim) {
          const resolution = resolveCommandClaim(byClaim.claim, {
            scope: validated.scope,
            fingerprint: validated.fingerprint,
          });
          if (resolution.outcome === 'idempotency_mismatch') {
            return Object.freeze({ outcome: 'fingerprint_conflict' as const });
          }
          if (!current) {
            throw new Error('hosted-authority-projection-replay-projection-missing');
          }
          return this.replay(input, validated, attributionJson, byClaim.commandId);
        }

        const currentGeneration = current?.generation ?? input.projection.expectedGeneration;
        const currentRevision = current?.revision ?? 0;
        if (currentRevision !== input.projection.expectedRevision) {
          return {
            outcome: 'stale_revision' as const,
            currentGeneration,
            currentRevision,
          };
        }

        this.insertCommittedCommand(input, validated, attributionJson, envelopeJson, attempt);
        this.writeProjection(input, validated.scope.deploymentId, current);
        this.insertOutbox(input, validated.scope.deploymentId);
        appendCommandOutboxEventToJournal(db, {
          commandId: validated.commandId,
          deploymentId: validated.scope.deploymentId,
          attribution,
          outbox: input.outbox,
        });
        assertDeadlineOpen(input.deadlineAtMs);

        const projection = this.requireProjection({
          deploymentId: validated.scope.deploymentId,
          projectionKind: input.projection.projectionKind,
          projectionKey: input.projection.projectionKey,
          deadlineAtMs: input.deadlineAtMs,
        });
        return Object.freeze({
          outcome: 'committed' as const,
          projection,
          receipt: receiptFromEnvelope(validated.scope.deploymentId, envelopeJson),
        });
      })
      .immediate();
  }

  get(value: unknown): HostedAuthorityProjectionRecord | null {
    const input = parseHostedAuthorityProjectionReadRequest(value);
    assertDeadlineOpen(input.deadlineAtMs);
    const db = this.getDb();
    return db.transaction(() => {
      assertDeadlineOpen(input.deadlineAtMs);
      return this.readProjectionRow(input);
    })();
  }

  private replay(
    input: HostedAuthorityProjectionPersistRequest,
    validated: DurableApplicationCommandPersistClaimRequest,
    attributionJson: string,
    existingCommandId: string
  ): HostedAuthorityProjectionCommitResult {
    const command = this.repository.requireDurableRecord({
      deploymentId: validated.scope.deploymentId,
      commandId: existingCommandId,
    });
    if (
      command.state !== 'committed' ||
      command.retentionClass !== validated.retentionClass ||
      command.descriptor.descriptorId !== validated.descriptor.descriptorId ||
      command.descriptor.descriptorVersion !== validated.descriptor.descriptorVersion ||
      command.descriptor.commandKind !== validated.descriptor.commandKind ||
      command.descriptor.inputSchemaVersion !== validated.descriptor.inputSchemaVersion ||
      command.descriptor.fingerprintVersion !== validated.descriptor.fingerprintVersion ||
      command.descriptor.effectPlanVersion !== validated.descriptor.effectPlanVersion ||
      command.effects.length !== validated.effectPlan.length ||
      command.effects.some(
        (effect, ordinal) =>
          effect.state !== 'observed_succeeded' ||
          effect.effectId !== validated.effectPlan[ordinal]?.effectId ||
          effect.effectVersion !== validated.effectPlan[ordinal]?.effectVersion ||
          effect.recoveryClass !== 'transactional_local' ||
          effect.evidenceSchemaVersion !== validated.effectPlan[ordinal]?.evidenceSchemaVersion
      ) ||
      this.repository.requireCoordinationAttributionJson(existingCommandId) !== attributionJson ||
      command.outcomeJson === null ||
      command.committedAt === null
    ) {
      throw new Error('hosted-authority-projection-replay-command-invalid');
    }
    const envelope = parseHostedAuthorityProjectionReceiptEnvelope(command.outcomeJson);
    const storedOutbox = this.repository.readOutboxByCommandId(existingCommandId);
    if (
      envelope.deploymentId !== validated.scope.deploymentId ||
      envelope.commandId !== existingCommandId ||
      envelope.projectionKind !== input.projection.projectionKind ||
      envelope.projectionKey !== input.projection.projectionKey ||
      envelope.expectedGeneration !== input.projection.expectedGeneration ||
      envelope.expectedRevision !== input.projection.expectedRevision ||
      envelope.committedAt !== command.committedAt ||
      !storedOutbox ||
      storedOutbox.commandId !== envelope.commandId ||
      storedOutbox.deploymentId !== envelope.deploymentId ||
      storedOutbox.eventId !== envelope.eventId ||
      storedOutbox.semanticRevision !== envelope.revision ||
      storedOutbox.createdAt !== envelope.committedAt
    ) {
      throw new Error('hosted-authority-projection-replay-binding-conflict');
    }
    const journal = this.getDb()
      .prepare(
        `SELECT deployment_id AS deploymentId, event_id AS eventId, body_json AS bodyJson,
                emitted_at AS emittedAt, origin_command_id AS originCommandId,
                created_at AS createdAt
         FROM coordination_event_journal
         WHERE origin_command_id = ? AND event_id = ?`
      )
      .all(existingCommandId, envelope.eventId) as JournalBindingRow[];
    const journalRow = journal[0];
    if (
      journal.length !== 1 ||
      !journalRow ||
      journalRow.deploymentId !== envelope.deploymentId ||
      journalRow.eventId !== envelope.eventId ||
      journalRow.originCommandId !== envelope.commandId ||
      journalRow.emittedAt !== envelope.committedAt ||
      journalRow.createdAt !== envelope.committedAt ||
      journalRow.bodyJson !==
        expectedJournalBodyJson(
          storedOutbox,
          this.repository.readCoordinationAttribution(existingCommandId)
        )
    ) {
      throw new Error('hosted-authority-projection-replay-journal-binding-invalid');
    }
    return Object.freeze({
      outcome: 'idempotent_replay' as const,
      projection: projectionFromEnvelope(command.outcomeJson),
      receipt: receiptFromEnvelope(validated.scope.deploymentId, command.outcomeJson),
    });
  }

  private insertCommittedCommand(
    input: HostedAuthorityProjectionPersistRequest,
    validated: DurableApplicationCommandPersistClaimRequest,
    attributionJson: string,
    envelopeJson: string,
    attempt: {
      readonly attemptId: string;
      readonly ownerId: string;
      readonly leaseToken: string;
      readonly claimedAtIso: string;
      readonly leaseExpiresAtIso: string;
    }
  ): void {
    const db = this.getDb();
    db.prepare(
      `INSERT INTO durable_application_commands (
         command_id, deployment_id, stable_actor_id, command_kind, idempotency_key,
         descriptor_id, descriptor_version, input_schema_version, fingerprint_version,
         effect_plan_version, fingerprint_key_version, fingerprint_digest,
         attempt_generation, attempt_id, attempt_owner_id, attempt_lease_token,
         attempt_claimed_at, attempt_lease_expires_at, state, retention_class,
         audit_session_id, coordination_attribution_json, outcome_json, error_code, error_json,
         created_at, updated_at, committed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
    ).run(
      validated.commandId,
      validated.scope.deploymentId,
      validated.scope.stableActorId,
      validated.scope.commandKind,
      validated.scope.idempotencyKey,
      validated.descriptor.descriptorId,
      validated.descriptor.descriptorVersion,
      validated.descriptor.inputSchemaVersion,
      validated.descriptor.fingerprintVersion,
      validated.descriptor.effectPlanVersion,
      validated.fingerprint.keyVersion,
      validated.fingerprint.digest,
      attempt.attemptId,
      attempt.ownerId,
      attempt.leaseToken,
      attempt.claimedAtIso,
      attempt.leaseExpiresAtIso,
      validated.retentionClass,
      validated.auditSessionId,
      attributionJson,
      envelopeJson,
      input.committedAtIso,
      input.committedAtIso,
      input.committedAtIso
    );
    for (const effect of validated.effectPlan) {
      db.prepare(
        `INSERT INTO durable_application_command_effects (
           command_id, ordinal, effect_id, effect_version, recovery_class,
           evidence_schema_version, state, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'observed_succeeded', ?)`
      ).run(
        validated.commandId,
        effect.ordinal,
        effect.effectId,
        effect.effectVersion,
        effect.recoveryClass,
        effect.evidenceSchemaVersion,
        input.committedAtIso
      );
      db.prepare(
        `INSERT INTO durable_application_command_effect_evidence (
           command_id, ordinal, sequence, outcome, evidence_schema_version,
           evidence_json, recorded_at
         ) VALUES (?, ?, 1, 'observed_succeeded', ?, ?, ?)`
      ).run(
        validated.commandId,
        effect.ordinal,
        effect.evidenceSchemaVersion,
        stableJsonStringify({
          kind: 'atomic_hosted_authority_projection',
          projectionKey: input.projection.projectionKey,
          projectionKind: input.projection.projectionKind,
          revision: input.projection.nextRevision,
        }),
        input.committedAtIso
      );
    }
  }

  private writeProjection(
    input: HostedAuthorityProjectionPersistRequest,
    deploymentId: string,
    current: HostedAuthorityProjectionRecord | null
  ): void {
    const db = this.getDb();
    if (!current) {
      db.prepare(
        `INSERT INTO hosted_authority_projections (
           deployment_id, projection_kind, projection_key, generation, revision,
           state_json, last_command_id, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        deploymentId,
        input.projection.projectionKind,
        input.projection.projectionKey,
        input.projection.nextGeneration,
        input.projection.nextRevision,
        input.projection.stateJson,
        input.commandId,
        input.committedAtIso
      );
      return;
    }
    const changed = db
      .prepare(
        `UPDATE hosted_authority_projections
         SET generation = ?, revision = ?, state_json = ?, last_command_id = ?, updated_at = ?
         WHERE deployment_id = ? AND projection_kind = ? AND projection_key = ?
           AND generation = ? AND revision = ?`
      )
      .run(
        input.projection.nextGeneration,
        input.projection.nextRevision,
        input.projection.stateJson,
        input.commandId,
        input.committedAtIso,
        deploymentId,
        input.projection.projectionKind,
        input.projection.projectionKey,
        input.projection.expectedGeneration,
        input.projection.expectedRevision
      );
    if (changed.changes !== 1) {
      throw new Error('hosted-authority-projection-cas-did-not-converge');
    }
  }

  private insertOutbox(input: HostedAuthorityProjectionPersistRequest, deploymentId: string): void {
    this.getDb()
      .prepare(
        `INSERT INTO durable_application_command_outbox (
           event_id, command_id, deployment_id, event_type, scope_kind, scope_id,
           schema_version, semantic_revision, payload_json, created_at,
           delivery_generation, delivery_owner_id, delivery_lease_token,
           delivery_claimed_at, delivery_lease_expires_at, delivery_acknowledged_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL)`
      )
      .run(
        input.outbox.eventId,
        input.commandId,
        deploymentId,
        input.outbox.eventType,
        input.outbox.scopeKind,
        input.outbox.scopeId,
        input.outbox.schemaVersion,
        input.outbox.semanticRevision,
        input.outbox.payloadJson,
        input.outbox.createdAtIso
      );
  }

  private requireProjection(
    input: HostedAuthorityProjectionReadRequest
  ): HostedAuthorityProjectionRecord {
    const projection = this.readProjectionRow(input);
    if (!projection) throw new Error('hosted-authority-projection-commit-missing');
    return projection;
  }

  private readProjectionRow(
    input: HostedAuthorityProjectionReadRequest
  ): HostedAuthorityProjectionRecord | null {
    const row = this.getDb()
      .prepare(
        `SELECT p.deployment_id AS deploymentId, p.projection_kind AS projectionKind,
                p.projection_key AS projectionKey, p.generation, p.revision,
                p.state_json AS stateJson, p.last_command_id AS lastCommandId,
                p.updated_at AS updatedAt, c.state AS commandState,
                c.deployment_id AS commandDeploymentId, c.outcome_json AS commandOutcomeJson,
                c.committed_at AS commandCommittedAt
         FROM hosted_authority_projections AS p
         JOIN durable_application_commands AS c ON c.command_id = p.last_command_id
         WHERE p.deployment_id = ? AND p.projection_kind = ? AND p.projection_key = ?`
      )
      .get(input.deploymentId, input.projectionKind, input.projectionKey) as
      | ProjectionRow
      | undefined;
    if (!row) return null;
    if (
      row.commandState !== 'committed' ||
      row.commandDeploymentId !== row.deploymentId ||
      row.commandOutcomeJson === null ||
      row.commandCommittedAt === null
    ) {
      throw new Error('hosted-authority-projection-command-not-committed');
    }
    const envelope = parseHostedAuthorityProjectionReceiptEnvelope(row.commandOutcomeJson);
    if (
      envelope.commandId !== row.lastCommandId ||
      envelope.deploymentId !== row.deploymentId ||
      envelope.projectionKind !== row.projectionKind ||
      envelope.projectionKey !== row.projectionKey ||
      envelope.generation !== row.generation ||
      envelope.revision !== row.revision ||
      envelope.stateJson !== row.stateJson ||
      envelope.committedAt !== row.updatedAt ||
      envelope.committedAt !== row.commandCommittedAt
    ) {
      throw new Error('hosted-authority-projection-command-binding-invalid');
    }
    const {
      commandState: _commandState,
      commandDeploymentId: _commandDeploymentId,
      commandOutcomeJson: _commandOutcomeJson,
      commandCommittedAt: _commandCommittedAt,
      ...projection
    } = row;
    return parseHostedAuthorityProjectionRecord(projection);
  }
}

function staleResult(
  outcome: 'stale_generation' | 'stale_revision',
  current: HostedAuthorityProjectionRecord
): HostedAuthorityProjectionCommitResult {
  return {
    outcome,
    currentGeneration: current.generation,
    currentRevision: current.revision,
  };
}

function receiptFromEnvelope(
  deploymentId: string,
  envelopeJson: string
): HostedAuthorityProjectionReceiptRecord {
  const envelope = parseHostedAuthorityProjectionReceiptEnvelope(envelopeJson);
  if (deploymentId !== envelope.deploymentId) {
    throw new Error('hosted-authority-projection-receipt-deployment-binding-invalid');
  }
  return Object.freeze({
    deploymentId,
    projectionKind: envelope.projectionKind,
    projectionKey: envelope.projectionKey,
    commandId: envelope.commandId,
    generation: envelope.generation,
    revision: envelope.revision,
    eventId: envelope.eventId,
    receiptJson: envelope.receiptJson,
    committedAt: envelope.committedAt,
  });
}

function projectionFromEnvelope(envelopeJson: string): HostedAuthorityProjectionRecord {
  const envelope = parseHostedAuthorityProjectionReceiptEnvelope(envelopeJson);
  return parseHostedAuthorityProjectionRecord({
    deploymentId: envelope.deploymentId,
    projectionKind: envelope.projectionKind,
    projectionKey: envelope.projectionKey,
    generation: envelope.generation,
    revision: envelope.revision,
    stateJson: envelope.stateJson,
    lastCommandId: envelope.commandId,
    updatedAt: envelope.committedAt,
  });
}

function expectedJournalBodyJson(
  outbox: {
    readonly eventId: string;
    readonly eventType: string;
    readonly scopeKind: string;
    readonly scopeId: string;
    readonly schemaVersion: number;
    readonly payloadJson: string;
    readonly createdAt: string;
  },
  attribution: {
    readonly actor: unknown;
    readonly runId?: string;
  }
): string {
  const runId = attribution.runId ?? (outbox.scopeKind === 'run' ? outbox.scopeId : undefined);
  return canonicalCoordinationStorageJson({
    schemaVersion: outbox.schemaVersion,
    eventId: outbox.eventId,
    scope: { kind: outbox.scopeKind, scopeId: outbox.scopeId },
    ...(outbox.scopeKind === 'workspace' ? { workspaceId: outbox.scopeId } : {}),
    ...(outbox.scopeKind === 'team' ? { teamId: outbox.scopeId } : {}),
    ...(runId === undefined ? {} : { runId }),
    actor: attribution.actor,
    eventType: outbox.eventType,
    emittedAt: outbox.createdAt,
    payload: JSON.parse(outbox.payloadJson) as unknown,
  });
}

function assertDeadlineOpen(deadlineAtMs: number): void {
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 1 || Date.now() >= deadlineAtMs) {
    throw new Error('hosted-authority-projection-deadline-expired');
  }
}

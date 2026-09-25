import {
  createCommandClaimScope,
  createDurableCommandDescriptorIdentity,
  resolveCommandClaim,
} from '@features/application-command-ledger';
import { HMAC_SHA256_LD_V1 } from '@features/application-command-ledger/contracts';
import { and, asc, eq } from 'drizzle-orm';

import * as mapping from './applicationCommandLedgerMapping';
import {
  canonicalCoordinationStorageJson,
  materializeCommandCoordinationAttribution,
} from './coordinationDurabilityWorkerOps';
import {
  applicationCommandLedger,
  durableApplicationCommandEffectEvidence,
  durableApplicationCommandEffects,
  durableApplicationCommandOutbox,
  durableApplicationCommands,
} from './internalStorageSchema';

import type { StoredCommandCoordinationAttribution } from './internalStorageWorkerProtocol';
import type {
  DurableApplicationCommandOutboxRecord,
  DurableApplicationCommandRecord,
} from '@features/application-command-ledger';
import type {
  CommandClaimRecord,
  CommandFingerprintRecord,
  DurableCommandState,
  DurableEffectState,
  EffectRecoveryClass,
} from '@features/application-command-ledger/contracts';
import type DatabaseConstructor from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

import type {
  AppCommandRecord,
  DurableCommandRow,
  DurableEffectEvidenceRow,
  DurableEffectRow,
} from './applicationCommandLedgerWorkerTypes';

export class ApplicationCommandLedgerRecordRepository {
  constructor(
    private readonly getOrm: () => BetterSQLite3Database,
    private readonly getDb: () => SqliteDatabase
  ) {}

  requireDurableRecord(input: {
    deploymentId: string;
    commandId: string;
  }): DurableApplicationCommandRecord {
    const record = this.readDurableRecord(input);
    if (!record) {
      throw new Error(`Durable application command not found: ${input.commandId}`);
    }
    return record;
  }

  readDurableRecord(input: {
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

  readDurableRecordByClaim<TCommandKind extends string>(input: {
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

  mapDurableRecord(row: DurableCommandRow): DurableApplicationCommandRecord {
    mapping.assertKnownDurableCommandRow(row);
    const effects = (
      this.getOrm()
        .select()
        .from(durableApplicationCommandEffects)
        .where(eq(durableApplicationCommandEffects.commandId, row.commandId))
        .orderBy(asc(durableApplicationCommandEffects.ordinal))
        .all() as DurableEffectRow[]
    ).map((effect, ordinal) => {
      mapping.assertKnownDurableEffectRow(effect, row.commandId, ordinal);
      const evidence = this.readEffectEvidence(row.commandId, ordinal).map((item, index) =>
        mapping.mapEffectEvidence(item, effect, index + 1)
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

  readEffectEvidence(commandId: string, ordinal: number): DurableEffectEvidenceRow[] {
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

  readOutboxByCommandId(commandId: string): DurableApplicationCommandOutboxRecord | null {
    const rows = this.getOrm()
      .select()
      .from(durableApplicationCommandOutbox)
      .where(eq(durableApplicationCommandOutbox.commandId, commandId))
      .all();
    return rows[0] ? mapping.mapOutboxRow(rows[0]) : null;
  }

  requireCoordinationAttributionJson(commandId: string): string {
    const row = this.getOrm()
      .select({ value: durableApplicationCommands.coordinationAttributionJson })
      .from(durableApplicationCommands)
      .where(eq(durableApplicationCommands.commandId, commandId))
      .all()[0];
    if (!row) throw new Error(`Durable application command not found: ${commandId}`);
    return row.value;
  }

  readCoordinationAttribution(commandId: string): StoredCommandCoordinationAttribution {
    const value = this.requireCoordinationAttributionJson(commandId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw new Error('Durable application command coordination attribution is corrupt', {
        cause: error,
      });
    }
    const attribution = materializeCommandCoordinationAttribution(
      parsed as StoredCommandCoordinationAttribution
    );
    if (canonicalCoordinationStorageJson(attribution) !== value) {
      throw new Error('Durable application command coordination attribution is not canonical');
    }
    return attribution;
  }

  readByCommandId(input: {
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

  readByIdempotencyKey(input: {
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

  replaceRow(row: AppCommandRecord): void {
    const { namespace, scopeKey, commandId, ...values } = row;
    this.getOrm()
      .update(applicationCommandLedger)
      .set(values)
      .where(
        and(
          eq(applicationCommandLedger.namespace, namespace),
          eq(applicationCommandLedger.scopeKey, scopeKey),
          eq(applicationCommandLedger.commandId, commandId)
        )
      )
      .run();
  }
}

import {
  ApplicationCommandBeginOutcome,
  ApplicationCommandConflictReason,
  type ApplicationCommandLedgerBeginRequest,
  type ApplicationCommandLedgerBeginResult,
  type ApplicationCommandLedgerRecord,
  ApplicationCommandLedgerStatus,
  type ApplicationCommandMutationFenceClaim,
} from '@features/application-command-ledger/contracts';

import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;
type AppCommandRecord = ApplicationCommandLedgerRecord<string>;
type AppCommandBeginRequest = ApplicationCommandLedgerBeginRequest<string>;
type AppCommandBeginResult = ApplicationCommandLedgerBeginResult<string>;

interface MutationFenceRow {
  namespace: string;
  scopeKey: string;
  laneId: string;
  backend: string;
  effectKind: string;
  payloadHash: string;
  operationId: string;
  leaseToken: string;
  leaseOwnerId: string;
  leaseFence: number;
  claimedAt: string;
  expiresAt: string;
  commandId: string;
}

export type ApplicationCommandMutationFenceCommandReader = (input: {
  namespace: string;
  scopeKey: string;
  commandId: string;
}) => AppCommandRecord | null;

const MAX_IDENTIFIER_LENGTH = 512;

export class ApplicationCommandMutationFenceOps {
  constructor(
    private readonly getDatabase: () => SqliteDatabase,
    private readonly readCommandById: ApplicationCommandMutationFenceCommandReader
  ) {}

  ensureSchema(): void {
    this.getDatabase().exec(`
      CREATE TABLE IF NOT EXISTS application_command_mutation_fences (
        namespace TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        lane_id TEXT NOT NULL,
        backend TEXT NOT NULL,
        effect_kind TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        lease_owner_id TEXT NOT NULL,
        lease_fence INTEGER NOT NULL CHECK (lease_fence > 0),
        claimed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        command_id TEXT NOT NULL,
        PRIMARY KEY (namespace, scope_key, operation_id),
        FOREIGN KEY (namespace, scope_key, command_id)
          REFERENCES application_command_ledger(namespace, scope_key, command_id)
          DEFERRABLE INITIALLY DEFERRED
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_cmd_mutation_token
        ON application_command_mutation_fences(namespace, scope_key, lease_token);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_cmd_mutation_lane_fence
        ON application_command_mutation_fences(namespace, scope_key, lane_id, lease_fence);
      CREATE INDEX IF NOT EXISTS idx_app_cmd_mutation_lane_max
        ON application_command_mutation_fences(namespace, scope_key, lane_id, lease_fence DESC);
    `);
  }

  claim(
    input: AppCommandBeginRequest,
    current: AppCommandRecord | null
  ): AppCommandBeginResult | null {
    const claim = input.mutationFence;
    if (!claim) {
      if (!current) return null;
      const storedClaim = this.readMutationFence(
        `namespace = ? AND scope_key = ? AND command_id = ?`,
        current.namespace,
        current.scopeKey,
        current.commandId
      );
      return storedClaim
        ? mutationConflict(
            ApplicationCommandConflictReason.MutationOperationRebound,
            current,
            input
          )
        : null;
    }
    validateMutationFenceClaim(claim, input);

    const existingOperation = this.readMutationFence(
      `namespace = ? AND scope_key = ? AND operation_id = ?`,
      input.namespace,
      input.scopeKey,
      claim.operationId
    );
    if (existingOperation) {
      if (
        current?.commandId === existingOperation.commandId &&
        sameMutationFence(existingOperation, input)
      ) {
        return null;
      }
      const reason =
        existingOperation.payloadHash !== input.payloadHash
          ? ApplicationCommandConflictReason.PayloadHashMismatch
          : ApplicationCommandConflictReason.MutationOperationRebound;
      return mutationConflict(reason, current, input);
    }

    if (current) {
      return mutationConflict(
        ApplicationCommandConflictReason.MutationOperationRebound,
        current,
        input
      );
    }

    const existingToken = this.readMutationFence(
      `namespace = ? AND scope_key = ? AND lease_token = ?`,
      input.namespace,
      input.scopeKey,
      claim.leaseToken
    );
    if (existingToken) {
      return mutationConflict(
        ApplicationCommandConflictReason.MutationTokenRebound,
        this.readCommandById({
          namespace: existingToken.namespace,
          scopeKey: existingToken.scopeKey,
          commandId: existingToken.commandId,
        }),
        input
      );
    }

    const now = Date.parse(input.nowIso);
    if (now < Date.parse(claim.claimedAtIso) || now >= Date.parse(claim.expiresAtIso)) {
      return mutationConflict(ApplicationCommandConflictReason.MutationFenceExpired, null, input);
    }

    const maximum = this.readMaximumMutationFence(input.namespace, input.scopeKey, claim.laneId);
    if (maximum) {
      const maximumCommand = this.readCommandById({
        namespace: maximum.namespace,
        scopeKey: maximum.scopeKey,
        commandId: maximum.commandId,
      });
      if (!maximumCommand) {
        throw new Error('Application command mutation fence refers to a missing command');
      }
      if (
        maximumCommand.status === ApplicationCommandLedgerStatus.Started ||
        maximumCommand.status === ApplicationCommandLedgerStatus.UnknownAfterTimeout
      ) {
        return mutationConflict(
          ApplicationCommandConflictReason.MutationSuccessorBlocked,
          maximumCommand,
          input
        );
      }
      if (claim.leaseFence <= maximum.leaseFence) {
        return mutationConflict(
          ApplicationCommandConflictReason.MutationFenceStale,
          maximumCommand,
          input
        );
      }
    }

    this.getDatabase()
      .prepare(
        `INSERT INTO application_command_mutation_fences (
          namespace, scope_key, lane_id, backend, effect_kind, payload_hash,
          operation_id, lease_token, lease_owner_id, lease_fence, claimed_at,
          expires_at, command_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.namespace,
        input.scopeKey,
        claim.laneId,
        claim.backend,
        claim.effectKind,
        input.payloadHash,
        claim.operationId,
        claim.leaseToken,
        claim.leaseOwnerId,
        claim.leaseFence,
        claim.claimedAtIso,
        claim.expiresAtIso,
        input.commandId
      );
    return null;
  }

  private readMaximumMutationFence(
    namespace: string,
    scopeKey: string,
    laneId: string
  ): MutationFenceRow | null {
    return this.readMutationFence(
      `namespace = ? AND scope_key = ? AND lane_id = ?
       ORDER BY lease_fence DESC LIMIT 1`,
      namespace,
      scopeKey,
      laneId
    );
  }

  private readMutationFence(where: string, ...parameters: unknown[]): MutationFenceRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT
          namespace,
          scope_key AS scopeKey,
          lane_id AS laneId,
          backend,
          effect_kind AS effectKind,
          payload_hash AS payloadHash,
          operation_id AS operationId,
          lease_token AS leaseToken,
          lease_owner_id AS leaseOwnerId,
          lease_fence AS leaseFence,
          claimed_at AS claimedAt,
          expires_at AS expiresAt,
          command_id AS commandId
        FROM application_command_mutation_fences
        WHERE ${where}`
      )
      .get(...parameters) as MutationFenceRow | undefined;
    return row ?? null;
  }
}

function validateMutationFenceClaim(
  claim: ApplicationCommandMutationFenceClaim,
  input: AppCommandBeginRequest
): void {
  for (const [field, value] of Object.entries({
    laneId: claim.laneId,
    backend: claim.backend,
    effectKind: claim.effectKind,
    operationId: claim.operationId,
    leaseToken: claim.leaseToken,
    leaseOwnerId: claim.leaseOwnerId,
  })) {
    assertIdentifier(`mutationFence.${field}`, value);
  }
  assertPositiveVersion('mutationFence.leaseFence', claim.leaseFence);
  assertCanonicalIsoTimestamp('mutationFence.claimedAtIso', claim.claimedAtIso);
  assertCanonicalIsoTimestamp('mutationFence.expiresAtIso', claim.expiresAtIso);
  if (Date.parse(claim.expiresAtIso) <= Date.parse(claim.claimedAtIso)) {
    throw new Error('Application command mutation fence must expire after it is claimed');
  }
  if (claim.operationId !== input.commandId || claim.operationId !== input.idempotencyKey) {
    throw new Error(
      'Application command mutation fence operationId must match command and idempotency identity'
    );
  }
}

function assertIdentifier(field: string, value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
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

function assertCanonicalIsoTimestamp(field: string, value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Durable application command ${field} must be an ISO timestamp`);
  }
  if (new Date(value).toISOString() !== value) {
    throw new Error(`Durable application command ${field} must be a canonical ISO timestamp`);
  }
}

function sameMutationFence(row: MutationFenceRow, input: AppCommandBeginRequest): boolean {
  const claim = input.mutationFence;
  return (
    claim !== undefined &&
    row.laneId === claim.laneId &&
    row.backend === claim.backend &&
    row.effectKind === claim.effectKind &&
    row.payloadHash === input.payloadHash &&
    row.operationId === claim.operationId &&
    row.leaseToken === claim.leaseToken &&
    row.leaseOwnerId === claim.leaseOwnerId &&
    row.leaseFence === claim.leaseFence &&
    row.claimedAt === claim.claimedAtIso &&
    row.expiresAt === claim.expiresAtIso &&
    row.commandId === input.commandId
  );
}

function mutationConflict(
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

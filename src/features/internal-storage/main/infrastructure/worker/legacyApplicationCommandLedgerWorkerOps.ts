import {
  ApplicationCommandBeginOutcome,
  ApplicationCommandConflictReason,
  ApplicationCommandFailureKind,
  type ApplicationCommandLedgerCompleteRequest,
  type ApplicationCommandLedgerFailRequest,
  type ApplicationCommandLedgerListScopeRequest,
  type ApplicationCommandLedgerReadByCommandIdRequest,
  type ApplicationCommandLedgerReadByIdempotencyKeyRequest,
  ApplicationCommandLedgerStatus,
} from '@features/application-command-ledger/contracts';
import { and, asc, eq } from 'drizzle-orm';

import * as validation from './applicationCommandLedgerValidation';
import { ApplicationCommandMutationFenceOps } from './applicationCommandMutationFenceOps';
import { applicationCommandLedger } from './internalStorageSchema';

import type DatabaseConstructor from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

import type { ApplicationCommandLedgerRecordRepository } from './applicationCommandLedgerRecordRepository';
import type {
  AppCommandBeginRequest,
  AppCommandBeginResult,
  AppCommandRecord,
} from './applicationCommandLedgerWorkerTypes';

export class LegacyApplicationCommandLedgerWorkerOps {
  private readonly mutationFenceOps: ApplicationCommandMutationFenceOps;

  constructor(
    private readonly getOrm: () => BetterSQLite3Database,
    private readonly repository: ApplicationCommandLedgerRecordRepository,
    getDb: () => SqliteDatabase
  ) {
    this.mutationFenceOps = new ApplicationCommandMutationFenceOps(getDb, (input) =>
      this.repository.readByCommandId(input)
    );
  }

  begin(input: AppCommandBeginRequest): AppCommandBeginResult {
    validation.assertValidBeginTiming(input);
    this.ensureMutationFenceSchema();
    const orm = this.getOrm();
    return orm.transaction(
      (): AppCommandBeginResult => {
        const currentByCommand = this.repository.readByCommandId(input);
        if (currentByCommand) {
          return this.beginExistingCommand(currentByCommand, input, true);
        }

        const currentByIdempotencyKey = this.repository.readByIdempotencyKey(input);
        if (currentByIdempotencyKey) {
          return this.beginExistingCommand(currentByIdempotencyKey, input, false);
        }

        const fenceConflict = this.claimMutationFence(input, null);
        if (fenceConflict) return fenceConflict;
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
      },
      { behavior: 'immediate' }
    );
  }

  markCompleted(input: ApplicationCommandLedgerCompleteRequest): void {
    const orm = this.getOrm();
    orm.transaction(() => {
      const current = this.repository.readByCommandId(input);
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
      validation.assertAttemptMatches(current, input.attemptCount);
      if (!validation.canFinalize(current.status)) {
        throw new Error(
          `Application command cannot be completed from status ${current.status}: ${input.commandId}`
        );
      }
      this.repository.replaceRow({
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
      const current = this.repository.readByCommandId(input);
      if (!current) {
        throw new Error(`Application command ledger entry not found: ${input.commandId}`);
      }
      validation.assertAttemptMatches(current, input.attemptCount);
      const nextStatus = validation.statusForFailure(input.failureKind);
      if (
        current.status === nextStatus &&
        current.failureKind === input.failureKind &&
        current.lastError === input.errorMessage
      ) {
        return;
      }
      if (!validation.canFinalize(current.status)) {
        throw new Error(
          `Application command cannot be failed from status ${current.status}: ${input.commandId}`
        );
      }
      this.repository.replaceRow({
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
    return this.repository.readByCommandId(input);
  }

  getByIdempotencyKey(
    input: ApplicationCommandLedgerReadByIdempotencyKeyRequest
  ): AppCommandRecord | null {
    return this.repository.readByIdempotencyKey(input);
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

  ensureMutationFenceSchema(): void {
    this.mutationFenceOps.ensureSchema();
  }

  claimMutationFence(
    input: AppCommandBeginRequest,
    current: AppCommandRecord | null
  ): AppCommandBeginResult | null {
    return this.mutationFenceOps.claim(input, current);
  }

  beginExistingCommand(
    current: AppCommandRecord,
    input: AppCommandBeginRequest,
    matchedCommandId: boolean
  ): AppCommandBeginResult {
    const conflict =
      matchedCommandId && current.idempotencyKey !== input.idempotencyKey
        ? ApplicationCommandConflictReason.CommandIdReused
        : this.findSemanticConflict(current, input);
    if (conflict) return validation.mutationConflict(conflict, current, input);
    const fenceConflict = this.claimMutationFence(input, current);
    if (fenceConflict) return fenceConflict;
    return this.beginExistingMatchingCommand(current, input);
  }

  beginExistingMatchingCommand(
    current: AppCommandRecord,
    input: AppCommandBeginRequest
  ): AppCommandBeginResult {
    switch (current.status) {
      case ApplicationCommandLedgerStatus.Started:
        if (validation.isStartedStale(current, input)) {
          const next: AppCommandRecord = {
            ...current,
            status: ApplicationCommandLedgerStatus.UnknownAfterTimeout,
            failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
            retryable: false,
            updatedAt: input.nowIso,
            completedAt: null,
            lastError: `Started attempt ${current.attemptCount} exceeded ${input.startedStaleAfterMs}ms and requires reconciliation`,
          };
          this.repository.replaceRow(next);
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

  restartRetryable(
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
    this.repository.replaceRow(next);
    return { outcome: ApplicationCommandBeginOutcome.RetryStarted, record: next };
  }

  findSemanticConflict(
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
}

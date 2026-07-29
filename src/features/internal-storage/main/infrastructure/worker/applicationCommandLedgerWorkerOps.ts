import {
  type ApplicationCommandLedgerCompleteRequest,
  type ApplicationCommandLedgerFailRequest,
  type ApplicationCommandLedgerListScopeRequest,
  type ApplicationCommandLedgerReadByCommandIdRequest,
  type ApplicationCommandLedgerReadByIdempotencyKeyRequest,
} from '@features/application-command-ledger/contracts';

import { ApplicationCommandLedgerRecordRepository } from './applicationCommandLedgerRecordRepository';
import { DurableApplicationCommandOutboxWorkerOps } from './durableApplicationCommandOutboxWorkerOps';
import { DurableApplicationCommandWorkerOps } from './durableApplicationCommandWorkerOps';
import { LegacyApplicationCommandLedgerWorkerOps } from './legacyApplicationCommandLedgerWorkerOps';

import type {
  ApplicationCommandLedgerWorkerPayloadByOp,
  StoredCommandCoordinationAttribution,
} from './internalStorageWorkerProtocol';
import type {
  DurableApplicationCommandAttemptLeaseRequest,
  DurableApplicationCommandClaimResult,
  DurableApplicationCommandClaimStatusRequest,
  DurableApplicationCommandCommitRequest,
  DurableApplicationCommandConsumerApplyRequest,
  DurableApplicationCommandConsumerApplyResult,
  DurableApplicationCommandConsumerProjectionRecord,
  DurableApplicationCommandConsumerProjectionRequest,
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
import type { ApplicationCommandJsonValue } from '@features/application-command-ledger/core/domain';
import type DatabaseConstructor from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

import type {
  AppCommandBeginRequest,
  AppCommandBeginResult,
  AppCommandRecord,
} from './applicationCommandLedgerWorkerTypes';

export function handleApplicationCommandLedgerOp(
  ops: ApplicationCommandLedgerWorkerOps,
  op: string,
  payload: unknown
): unknown {
  switch (op) {
    case 'appCommandLedger.begin':
      // Keep the existing JSON-domain boundary explicit while the legacy
      // cross-feature edge remains pinned by the architecture ratchet.
      return ops.begin(payload as AppCommandBeginRequest & ApplicationCommandJsonValue);
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
      return ops.durableClaim(
        payload as ApplicationCommandLedgerWorkerPayloadByOp['appCommandLedger.durable.claim']
      );
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
  private readonly durableCommands: DurableApplicationCommandWorkerOps;
  private readonly durableOutbox: DurableApplicationCommandOutboxWorkerOps;
  private readonly legacy: LegacyApplicationCommandLedgerWorkerOps;

  constructor(getOrm: () => BetterSQLite3Database, getDb: () => SqliteDatabase) {
    const repository = new ApplicationCommandLedgerRecordRepository(getOrm, getDb);
    this.durableCommands = new DurableApplicationCommandWorkerOps(getOrm, getDb, repository);
    this.durableOutbox = new DurableApplicationCommandOutboxWorkerOps(getOrm, repository);
    this.legacy = new LegacyApplicationCommandLedgerWorkerOps(getOrm, repository, getDb);
  }

  durableClaim<TCommandKind extends string>(
    input: DurableApplicationCommandPersistClaimRequest<TCommandKind> & {
      readonly coordinationAttribution?: StoredCommandCoordinationAttribution;
    }
  ): DurableApplicationCommandClaimResult<TCommandKind> {
    return this.durableCommands.durableClaim(input);
  }

  durableGetStatus<TCommandKind extends string>(
    input: DurableApplicationCommandStatusRequest
  ): DurableApplicationCommandRecord<TCommandKind> | null {
    return this.durableCommands.durableGetStatus(input);
  }

  durableGetByClaim<TCommandKind extends string>(
    input: DurableApplicationCommandClaimStatusRequest<TCommandKind>
  ): DurableApplicationCommandRecord<TCommandKind> | null {
    return this.durableCommands.durableGetByClaim(input);
  }

  durableRenewAttemptLease(
    input: DurableApplicationCommandAttemptLeaseRequest
  ): DurableApplicationCommandRecord {
    return this.durableCommands.durableRenewAttemptLease(input);
  }

  durableTransitionCommand(
    input: DurableApplicationCommandTransitionRequest
  ): DurableApplicationCommandRecord {
    return this.durableCommands.durableTransitionCommand(input);
  }

  durableTransitionEffect(
    input: DurableApplicationCommandEffectTransitionRequest
  ): DurableApplicationCommandRecord {
    return this.durableCommands.durableTransitionEffect(input);
  }

  durableCommit(input: DurableApplicationCommandCommitRequest): DurableApplicationCommandRecord {
    return this.durableCommands.durableCommit(input);
  }

  durableListOutbox(
    input: DurableApplicationCommandOutboxListRequest
  ): DurableApplicationCommandOutboxRecord[] {
    return this.durableOutbox.durableListOutbox(input);
  }

  durableClaimOutbox(
    input: DurableApplicationCommandOutboxClaimRequest
  ): DurableApplicationCommandOutboxRecord[] {
    return this.durableOutbox.durableClaimOutbox(input);
  }

  durableAcknowledgeOutboxDelivery(
    input: DurableApplicationCommandOutboxDeliveryAcknowledgementRequest
  ): void {
    this.durableOutbox.durableAcknowledgeOutboxDelivery(input);
  }

  durableApplyConsumerEvent(
    input: DurableApplicationCommandConsumerApplyRequest
  ): DurableApplicationCommandConsumerApplyResult {
    return this.durableOutbox.durableApplyConsumerEvent(input);
  }

  durableGetConsumerProjection(
    input: DurableApplicationCommandConsumerProjectionRequest
  ): DurableApplicationCommandConsumerProjectionRecord | null {
    return this.durableOutbox.durableGetConsumerProjection(input);
  }

  begin(input: AppCommandBeginRequest): AppCommandBeginResult {
    return this.legacy.begin(input);
  }

  markCompleted(input: ApplicationCommandLedgerCompleteRequest): void {
    this.legacy.markCompleted(input);
  }

  markFailed(input: ApplicationCommandLedgerFailRequest): void {
    this.legacy.markFailed(input);
  }

  getByCommandId(input: ApplicationCommandLedgerReadByCommandIdRequest): AppCommandRecord | null {
    return this.legacy.getByCommandId(input);
  }

  getByIdempotencyKey(
    input: ApplicationCommandLedgerReadByIdempotencyKeyRequest
  ): AppCommandRecord | null {
    return this.legacy.getByIdempotencyKey(input);
  }

  listByScope(input: ApplicationCommandLedgerListScopeRequest): AppCommandRecord[] {
    return this.legacy.listByScope(input);
  }
}

import { createHash } from 'node:crypto';

import { parseRevision, type QueryContext } from '@shared/contracts/hosted';

import {
  type HostedTaskMutationCommand,
  type HostedTaskMutationConflictReason,
  type HostedTaskMutationReceipt,
  parseHostedTaskBoardSourceGeneration,
} from '../../../contracts/hosted';
import {
  normalizeHostedTaskMutationReceipt,
  parseHostedTaskMutationCommand,
} from '../../../core/domain/policies/hostedTaskBoardPolicy';

import type {
  HostedTaskMutationAdmissionPort,
  HostedTaskMutationAdmissionResult,
} from '../../../core/application/ports/HostedTeamTaskBoardPorts';
import type { HostedTaskBoardAuthorityPort } from '../../ports/HostedTaskBoardAuthorityPort';

type MutationAuthority = Pick<HostedTaskBoardAuthorityPort, 'admitTaskMutation'>;
type UnknownRecord = Record<PropertyKey, unknown>;

interface ReplayLedgerEntry {
  readonly payloadFingerprint: string;
  readonly receipt: HostedTaskMutationReceipt;
}

type CurrentGeneration =
  | { readonly kind: 'matches' }
  | {
      readonly kind: 'stale';
      readonly currentSourceGeneration: HostedTaskMutationCommand['expectedSourceGeneration'];
    }
  | { readonly kind: 'invalid' };

const CONFLICT_REASONS = new Set<HostedTaskMutationConflictReason>([
  'idempotency_mismatch',
  'relationship_conflict',
  'state_conflict',
]);
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_REPLAY_LEDGER_ENTRIES = 512;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function unavailable(retryAfterMs?: number): HostedTaskMutationAdmissionResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function normalizeRetryAfterMs(value: unknown): number | undefined {
  return Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_RETRY_AFTER_MS
    ? (value as number)
    : undefined;
}

function isContextOpen(context: QueryContext, now: () => number): boolean {
  try {
    const nowMs = now();
    return (
      context.signal instanceof AbortSignal &&
      !context.signal.aborted &&
      Number.isSafeInteger(context.deadlineAtMs) &&
      context.deadlineAtMs >= 0 &&
      Number.isSafeInteger(nowMs) &&
      nowMs >= 0 &&
      nowMs < context.deadlineAtMs
    );
  } catch {
    return false;
  }
}

function mutationPayloadFingerprint(command: HostedTaskMutationCommand): string {
  const common = [
    command.schemaVersion,
    command.commandId,
    command.idempotencyKey,
    command.teamId,
    command.expectedSourceGeneration,
    command.expectedRevision,
    command.kind,
  ];
  const payload = (() => {
    switch (command.kind) {
      case 'create_task':
        return [
          ...common,
          command.subject,
          command.description,
          command.status,
          command.ownerId,
          command.column,
          command.order,
        ];
      case 'update_details':
        return [
          ...common,
          command.taskId,
          Object.hasOwn(command, 'subject'),
          command.subject ?? null,
          Object.hasOwn(command, 'description'),
          command.description ?? null,
        ];
      case 'update_status':
        return [...common, command.taskId, command.status];
      case 'update_owner':
        return [...common, command.taskId, command.ownerId];
      case 'move_task':
        return [...common, command.taskId, command.column, command.order];
      case 'reorder_column':
        return [...common, command.column, command.orderedTaskIds];
      case 'update_relationship':
        return [
          ...common,
          command.action,
          command.taskId,
          command.otherTaskId,
          command.relationship,
        ];
    }
  })();
  return createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
}

function replayLedgerKey(command: HostedTaskMutationCommand): string {
  return `${command.teamId}\u0000${command.expectedSourceGeneration}\u0000${command.idempotencyKey}`;
}

function sameReceipt(left: HostedTaskMutationReceipt, right: HostedTaskMutationReceipt): boolean {
  return (
    left.commandId === right.commandId &&
    left.teamId === right.teamId &&
    left.sourceGeneration === right.sourceGeneration &&
    left.revision === right.revision &&
    left.affectedTaskIds.length === right.affectedTaskIds.length &&
    left.affectedTaskIds.every((taskId, index) => taskId === right.affectedTaskIds[index])
  );
}

function compareCurrentGeneration(
  value: unknown,
  command: HostedTaskMutationCommand
): CurrentGeneration {
  try {
    const currentSourceGeneration = parseHostedTaskBoardSourceGeneration(value);
    return currentSourceGeneration === command.expectedSourceGeneration
      ? Object.freeze({ kind: 'matches' })
      : Object.freeze({ kind: 'stale', currentSourceGeneration });
  } catch {
    return Object.freeze({ kind: 'invalid' });
  }
}

function resultForCurrentGeneration(
  currentGeneration: CurrentGeneration
): HostedTaskMutationAdmissionResult | null {
  if (currentGeneration.kind === 'matches') return null;
  return currentGeneration.kind === 'stale'
    ? Object.freeze({
        kind: 'stale_generation',
        currentSourceGeneration: currentGeneration.currentSourceGeneration,
      })
    : unavailable();
}

function normalizeReceipt(
  value: UnknownRecord,
  outcome: 'committed' | 'idempotent_replay',
  command: HostedTaskMutationCommand
): HostedTaskMutationAdmissionResult {
  const receipt = normalizeHostedTaskMutationReceipt(
    value.receipt,
    outcome,
    command.commandId,
    command.teamId,
    command.expectedSourceGeneration
  );
  if (!receipt.ok) return unavailable();
  if (outcome === 'committed') {
    return receipt.value.outcome === 'committed'
      ? Object.freeze({ kind: 'committed', receipt: receipt.value })
      : unavailable();
  }
  return receipt.value.outcome === 'idempotent_replay'
    ? Object.freeze({ kind: 'idempotent_replay', receipt: receipt.value })
    : unavailable();
}

function normalizeGenerationCheckedResult(
  value: UnknownRecord,
  command: HostedTaskMutationCommand
): HostedTaskMutationAdmissionResult | null {
  return resultForCurrentGeneration(
    compareCurrentGeneration(value.currentSourceGeneration, command)
  );
}

/**
 * Maps a host's atomic mutation transaction to the application admission port. Each admission is
 * serialized by team locally so the verified replay ledger cannot race concurrent browser retries;
 * the host transaction remains the durable cross-process authority. Its required ordering is:
 * generation comparison, idempotency-key/fingerprint comparison, expected-revision comparison,
 * local write, then durable receipt persistence.
 */
export class HostedTaskBoardMutationAuthorityAdapter implements HostedTaskMutationAdmissionPort {
  private readonly replayLedger = new Map<string, ReplayLedgerEntry>();
  private readonly pendingAdmissionsByTeam = new Map<string, Promise<void>>();

  constructor(
    private readonly authority: MutationAuthority,
    private readonly now: () => number = Date.now
  ) {}

  async admit(
    commandValue: HostedTaskMutationCommand,
    context: QueryContext
  ): Promise<HostedTaskMutationAdmissionResult> {
    const command = parseHostedTaskMutationCommand(commandValue);
    if (!command.ok || !isContextOpen(context, this.now)) return unavailable();

    return this.serializeByTeam(command.value.teamId, async () => {
      if (!isContextOpen(context, this.now)) return unavailable();
      const admitTaskMutation = this.authority.admitTaskMutation;
      if (typeof admitTaskMutation !== 'function') return unavailable();

      const payloadFingerprint = mutationPayloadFingerprint(command.value);
      try {
        const result = await admitTaskMutation.call(
          this.authority,
          Object.freeze({ command: command.value, payloadFingerprint }),
          context
        );
        return isContextOpen(context, this.now)
          ? this.normalizeAdmissionResult(result, command.value, payloadFingerprint)
          : unavailable();
      } catch {
        return unavailable();
      }
    });
  }

  private async serializeByTeam<T>(teamId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pendingAdmissionsByTeam.get(teamId) ?? Promise.resolve();
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => completion);
    this.pendingAdmissionsByTeam.set(teamId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.pendingAdmissionsByTeam.get(teamId) === tail) {
        this.pendingAdmissionsByTeam.delete(teamId);
      }
    }
  }

  private normalizeAdmissionResult(
    value: unknown,
    command: HostedTaskMutationCommand,
    payloadFingerprint: string
  ): HostedTaskMutationAdmissionResult {
    if (!isRecord(value) || typeof value.kind !== 'string') return unavailable();

    try {
      switch (value.kind) {
        case 'committed': {
          if (
            !hasExactKeys(value, [
              'kind',
              'currentSourceGeneration',
              'payloadFingerprint',
              'receipt',
            ])
          ) {
            return unavailable();
          }
          const currentGeneration = normalizeGenerationCheckedResult(value, command);
          if (currentGeneration !== null) return currentGeneration;
          if (value.payloadFingerprint !== payloadFingerprint) return unavailable();
          const result = normalizeReceipt(value, 'committed', command);
          return result.kind === 'committed'
            ? this.recordCommitted(command, payloadFingerprint, result)
            : result;
        }
        case 'idempotent_replay': {
          if (
            !hasExactKeys(value, [
              'kind',
              'currentSourceGeneration',
              'payloadFingerprint',
              'receipt',
            ])
          ) {
            return unavailable();
          }
          const currentGeneration = normalizeGenerationCheckedResult(value, command);
          if (currentGeneration !== null) return currentGeneration;
          if (value.payloadFingerprint !== payloadFingerprint) {
            return Object.freeze({ kind: 'conflict', reason: 'idempotency_mismatch' });
          }
          const result = normalizeReceipt(value, 'idempotent_replay', command);
          return result.kind === 'idempotent_replay'
            ? this.recordReplay(command, payloadFingerprint, result)
            : result;
        }
        case 'stale_generation': {
          if (!hasExactKeys(value, ['kind', 'currentSourceGeneration'])) return unavailable();
          const currentGeneration = compareCurrentGeneration(
            value.currentSourceGeneration,
            command
          );
          return currentGeneration.kind === 'stale'
            ? Object.freeze({
                kind: 'stale_generation',
                currentSourceGeneration: currentGeneration.currentSourceGeneration,
              })
            : unavailable();
        }
        case 'stale_revision': {
          if (!hasExactKeys(value, ['kind', 'currentSourceGeneration', 'currentRevision'])) {
            return unavailable();
          }
          const currentGeneration = normalizeGenerationCheckedResult(value, command);
          if (currentGeneration !== null) return currentGeneration;
          const currentRevision = parseRevision(value.currentRevision);
          return currentRevision === command.expectedRevision
            ? unavailable()
            : Object.freeze({ kind: 'stale_revision', currentRevision });
        }
        case 'conflict': {
          if (!CONFLICT_REASONS.has(value.reason as HostedTaskMutationConflictReason)) {
            return unavailable();
          }
          if (value.reason === 'idempotency_mismatch') {
            if (!hasExactKeys(value, ['kind', 'reason', 'currentSourceGeneration'])) {
              return unavailable();
            }
            const currentGeneration = normalizeGenerationCheckedResult(value, command);
            return currentGeneration === null
              ? Object.freeze({ kind: 'conflict', reason: 'idempotency_mismatch' })
              : currentGeneration;
          }
          if (value.reason === 'relationship_conflict') {
            const hasCurrentRevision = Object.hasOwn(value, 'currentRevision');
            if (
              !hasExactKeys(
                value,
                hasCurrentRevision
                  ? ['kind', 'reason', 'currentSourceGeneration', 'currentRevision']
                  : ['kind', 'reason', 'currentSourceGeneration']
              )
            ) {
              return unavailable();
            }
            const currentGeneration = normalizeGenerationCheckedResult(value, command);
            if (currentGeneration !== null) return currentGeneration;
            const currentRevision = hasCurrentRevision
              ? parseRevision(value.currentRevision)
              : undefined;
            return Object.freeze({
              kind: 'conflict',
              reason: 'relationship_conflict',
              ...(currentRevision === undefined ? {} : { currentRevision }),
            });
          }
          if (
            !hasExactKeys(value, ['kind', 'reason', 'currentSourceGeneration', 'currentRevision'])
          ) {
            return unavailable();
          }
          const currentGeneration = normalizeGenerationCheckedResult(value, command);
          if (currentGeneration !== null) return currentGeneration;
          const currentRevision = parseRevision(value.currentRevision);
          return currentRevision === command.expectedRevision
            ? unavailable()
            : Object.freeze({ kind: 'conflict', reason: 'state_conflict', currentRevision });
        }
        case 'not_found':
          return hasExactKeys(value, ['kind'])
            ? Object.freeze({ kind: 'not_found' })
            : unavailable();
        case 'unsafe_active':
          return hasExactKeys(value, ['kind'])
            ? Object.freeze({ kind: 'unsafe_active' })
            : unavailable();
        case 'unavailable':
          if (hasExactKeys(value, ['kind'])) return unavailable();
          if (!hasExactKeys(value, ['kind', 'retryAfterMs'])) return unavailable();
          return unavailable(normalizeRetryAfterMs(value.retryAfterMs));
        default:
          return unavailable();
      }
    } catch {
      return unavailable();
    }
  }

  private recordCommitted(
    command: HostedTaskMutationCommand,
    payloadFingerprint: string,
    result: Extract<HostedTaskMutationAdmissionResult, { kind: 'committed' }>
  ): HostedTaskMutationAdmissionResult {
    const key = replayLedgerKey(command);
    const existing = this.replayLedger.get(key);
    if (existing !== undefined) {
      return existing.payloadFingerprint === payloadFingerprint
        ? unavailable()
        : Object.freeze({ kind: 'conflict', reason: 'idempotency_mismatch' });
    }
    this.retainReplayLedgerEntry(key, {
      payloadFingerprint,
      receipt: result.receipt,
    });
    return result;
  }

  private recordReplay(
    command: HostedTaskMutationCommand,
    payloadFingerprint: string,
    result: Extract<HostedTaskMutationAdmissionResult, { kind: 'idempotent_replay' }>
  ): HostedTaskMutationAdmissionResult {
    const key = replayLedgerKey(command);
    const existing = this.replayLedger.get(key);
    if (existing !== undefined) {
      if (existing.payloadFingerprint !== payloadFingerprint) {
        return Object.freeze({ kind: 'conflict', reason: 'idempotency_mismatch' });
      }
      if (!sameReceipt(existing.receipt, result.receipt)) return unavailable();
      this.retainReplayLedgerEntry(key, existing);
      return result;
    }
    this.retainReplayLedgerEntry(key, {
      payloadFingerprint,
      receipt: result.receipt,
    });
    return result;
  }

  /**
   * The process-local ledger retains only the most recently verified entries. Exact replays refresh
   * their position; adding a new key above the fixed limit evicts the least-recently verified key.
   * The authority remains the durable source of idempotency and conflict decisions after eviction.
   */
  private retainReplayLedgerEntry(key: string, entry: ReplayLedgerEntry): void {
    this.replayLedger.delete(key);
    this.replayLedger.set(key, Object.freeze(entry));
    if (this.replayLedger.size <= MAX_REPLAY_LEDGER_ENTRIES) return;

    const oldestKey = this.replayLedger.keys().next().value;
    if (oldestKey !== undefined) this.replayLedger.delete(oldestKey);
  }
}

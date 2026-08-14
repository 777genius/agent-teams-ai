import { HostedTeamMessageOrchestratorAuthority } from './hostedTeamMessageOrchestratorAuthority';

// eslint-disable-next-line no-restricted-imports -- Hosted mutation fencing is exposed by the feature's hosted entrypoint.
import type { HostedMutationGrantFence } from '@features/team-message-delivery/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Hosted task mutation authority is main-process-only.
import type {
  HostedTaskBoardAuthorityMutationRequest,
  HostedTaskBoardAuthorityMutationResult,
  HostedTaskBoardAuthorityPort,
} from '@features/team-task-board/main/hosted';
import type { QueryContext, TeamId } from '@shared/contracts/hosted';

export interface HostedTaskBoardSelfWriteCoordinator {
  beginTaskSelfWrite(operationId: string, teamId: TeamId): Promise<void>;
  completeTaskSelfWrite(
    operationId: string,
    effects: readonly { readonly fileKey: string; readonly expectedChecksum: string }[]
  ): Promise<void>;
  abortTaskSelfWrite(operationId: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function unavailable(): HostedTaskBoardAuthorityMutationResult {
  return Object.freeze({ kind: 'unavailable' });
}

/**
 * Task-board adapter over the already acquired lifecycle-owner lease. The controller never opens a
 * second readiness channel and never writes task state; `task_mutate` is admitted and committed by
 * the lifecycle owner behind the same socket and trust anchor used by lifecycle and message work.
 */
export class HostedTaskBoardOrchestratorAuthority implements Pick<
  HostedTaskBoardAuthorityPort,
  'admitTaskMutation'
> {
  constructor(
    private readonly transport: HostedTeamMessageOrchestratorAuthority,
    private readonly selfWrites?: HostedTaskBoardSelfWriteCoordinator
  ) {}

  bindGrantFence(context: QueryContext, fence: HostedMutationGrantFence): void {
    this.transport.bindGrantFence(context, fence);
  }

  async admitTaskMutation(
    request: HostedTaskBoardAuthorityMutationRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityMutationResult> {
    const operationId = request.command.commandId;
    try {
      await this.selfWrites?.beginTaskSelfWrite(operationId, request.command.teamId);
      const payload = await this.transport.exchangeOwnerMutation(
        'task_mutate',
        request,
        request.command.teamId,
        context
      );
      const result = this.parse(payload, request);
      if (result.kind === 'committed') {
        const effects = this.parseSelfWriteEffects(payload);
        if (this.selfWrites && effects === null) throw new TypeError('hosted-task-self-write-missing');
        if (effects) await this.selfWrites?.completeTaskSelfWrite(operationId, effects);
      } else {
        await this.selfWrites?.abortTaskSelfWrite(operationId);
      }
      return result;
    } catch {
      await this.selfWrites?.abortTaskSelfWrite(operationId).catch(() => undefined);
      return unavailable();
    }
  }

  private parseSelfWriteEffects(
    payload: unknown
  ): readonly { readonly fileKey: string; readonly expectedChecksum: string }[] | null {
    if (!isRecord(payload) || !Array.isArray(payload.selfWriteEffects)) return null;
    const effects = payload.selfWriteEffects;
    if (
      effects.length > 512 ||
      effects.some(
        (effect) =>
          !isRecord(effect) ||
          !hasExactKeys(effect, ['fileKey', 'expectedChecksum']) ||
          typeof effect.fileKey !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(effect.fileKey) ||
          typeof effect.expectedChecksum !== 'string' ||
          !/^[0-9a-f]{64}$/u.test(effect.expectedChecksum)
      )
    ) {
      return null;
    }
    return Object.freeze(
      effects.map((effect) =>
        Object.freeze({
          fileKey: (effect as Record<string, unknown>).fileKey as string,
          expectedChecksum: (effect as Record<string, unknown>).expectedChecksum as string,
        })
      )
    );
  }

  private parse(
    payload: unknown,
    request: HostedTaskBoardAuthorityMutationRequest
  ): HostedTaskBoardAuthorityMutationResult {
    if (!isRecord(payload) || payload.schemaVersion !== 1 || typeof payload.kind !== 'string') {
      return unavailable();
    }
    if (
      (payload.kind === 'committed' || payload.kind === 'idempotent_replay') &&
      hasExactKeys(payload, [
        'schemaVersion',
        'kind',
        'currentSourceGeneration',
        'payloadFingerprint',
        'receipt',
        ...(payload.kind === 'committed' && Object.hasOwn(payload, 'selfWriteEffects')
          ? ['selfWriteEffects']
          : []),
      ]) &&
      payload.currentSourceGeneration === request.command.expectedSourceGeneration &&
      payload.payloadFingerprint === request.payloadFingerprint &&
      isRecord(payload.receipt) &&
      hasExactKeys(payload.receipt, [
        'schemaVersion',
        'outcome',
        'commandId',
        'teamId',
        'sourceGeneration',
        'revision',
        'affectedTaskIds',
      ]) &&
      payload.receipt.schemaVersion === 1 &&
      payload.receipt.outcome ===
        (payload.kind === 'committed' ? 'committed' : 'idempotent_replay') &&
      payload.receipt.commandId === request.command.commandId &&
      payload.receipt.teamId === request.command.teamId &&
      payload.receipt.sourceGeneration === request.command.expectedSourceGeneration &&
      typeof payload.receipt.revision === 'string' &&
      /^revision_[0-9a-f]{64}$/u.test(payload.receipt.revision) &&
      Array.isArray(payload.receipt.affectedTaskIds) &&
      payload.receipt.affectedTaskIds.every(
        (taskId) => typeof taskId === 'string' && /^task_[0-9a-f]{32}$/u.test(taskId)
      )
    ) {
      return Object.freeze({
        kind: payload.kind,
        currentSourceGeneration: request.command.expectedSourceGeneration,
        payloadFingerprint: request.payloadFingerprint,
        receipt: Object.freeze({
          schemaVersion: 1,
          outcome: payload.receipt.outcome,
          commandId: request.command.commandId,
          teamId: request.command.teamId,
          sourceGeneration: request.command.expectedSourceGeneration,
          revision: payload.receipt.revision,
          affectedTaskIds: Object.freeze([...payload.receipt.affectedTaskIds]),
        }),
      }) as HostedTaskBoardAuthorityMutationResult;
    }
    if (
      payload.kind === 'stale_generation' &&
      hasExactKeys(payload, ['schemaVersion', 'kind', 'currentSourceGeneration']) &&
      typeof payload.currentSourceGeneration === 'string' &&
      /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u.test(payload.currentSourceGeneration)
    ) {
      return Object.freeze({
        kind: 'stale_generation',
        currentSourceGeneration: payload.currentSourceGeneration,
      }) as HostedTaskBoardAuthorityMutationResult;
    }
    if (
      payload.kind === 'stale_revision' &&
      hasExactKeys(payload, [
        'schemaVersion',
        'kind',
        'currentSourceGeneration',
        'currentRevision',
      ]) &&
      payload.currentSourceGeneration === request.command.expectedSourceGeneration &&
      typeof payload.currentRevision === 'string' &&
      /^revision_[0-9a-f]{64}$/u.test(payload.currentRevision)
    ) {
      return Object.freeze({
        kind: 'stale_revision',
        currentSourceGeneration: request.command.expectedSourceGeneration,
        currentRevision: payload.currentRevision,
      }) as HostedTaskBoardAuthorityMutationResult;
    }
    if (
      payload.kind === 'conflict' &&
      payload.reason === 'idempotency_mismatch' &&
      hasExactKeys(payload, ['schemaVersion', 'kind', 'reason', 'currentSourceGeneration']) &&
      payload.currentSourceGeneration === request.command.expectedSourceGeneration
    ) {
      return Object.freeze({
        kind: 'conflict',
        reason: 'idempotency_mismatch',
        currentSourceGeneration: request.command.expectedSourceGeneration,
      });
    }
    if (
      payload.kind === 'conflict' &&
      payload.reason === 'relationship_conflict' &&
      hasExactKeys(
        payload,
        Object.hasOwn(payload, 'currentRevision')
          ? ['schemaVersion', 'kind', 'reason', 'currentSourceGeneration', 'currentRevision']
          : ['schemaVersion', 'kind', 'reason', 'currentSourceGeneration']
      ) &&
      payload.currentSourceGeneration === request.command.expectedSourceGeneration &&
      (!Object.hasOwn(payload, 'currentRevision') ||
        (typeof payload.currentRevision === 'string' &&
          /^revision_[0-9a-f]{64}$/u.test(payload.currentRevision)))
    ) {
      return Object.freeze({
        kind: 'conflict' as const,
        reason: 'relationship_conflict' as const,
        currentSourceGeneration: request.command.expectedSourceGeneration,
        ...(typeof payload.currentRevision === 'string'
          ? { currentRevision: payload.currentRevision }
          : {}),
      }) as HostedTaskBoardAuthorityMutationResult;
    }
    if (
      payload.kind === 'conflict' &&
      payload.reason === 'state_conflict' &&
      hasExactKeys(payload, [
        'schemaVersion',
        'kind',
        'reason',
        'currentSourceGeneration',
        'currentRevision',
      ]) &&
      payload.currentSourceGeneration === request.command.expectedSourceGeneration &&
      typeof payload.currentRevision === 'string' &&
      /^revision_[0-9a-f]{64}$/u.test(payload.currentRevision)
    ) {
      return Object.freeze({
        kind: 'conflict',
        reason: 'state_conflict',
        currentSourceGeneration: request.command.expectedSourceGeneration,
        currentRevision: payload.currentRevision,
      }) as HostedTaskBoardAuthorityMutationResult;
    }
    if (
      (payload.kind === 'not_found' || payload.kind === 'unsafe_active') &&
      hasExactKeys(payload, ['schemaVersion', 'kind'])
    ) {
      return Object.freeze({ kind: payload.kind });
    }
    if (
      payload.kind === 'unavailable' &&
      hasExactKeys(payload, ['schemaVersion', 'kind', 'retryAfterMs']) &&
      (payload.retryAfterMs === null ||
        (Number.isSafeInteger(payload.retryAfterMs) && (payload.retryAfterMs as number) > 0))
    ) {
      return payload.retryAfterMs === null
        ? unavailable()
        : Object.freeze({
            kind: 'unavailable',
            retryAfterMs: payload.retryAfterMs as number,
          });
    }
    return unavailable();
  }
}

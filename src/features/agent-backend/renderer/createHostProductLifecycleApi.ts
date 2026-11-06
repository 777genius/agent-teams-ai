import { HostTeamOperationError } from './createHostTeamMutations';

import type { BackendHandle } from '../contracts';
import type {
  AgentBackendApi,
  BackendOperationRequest,
  BackendOperationResult,
} from '../contracts/operations';
import type {
  BackendQueuedDiscardReceipt,
  BackendTeamLifecycleReceipt,
  BackendTeamPurgeReceipt,
} from '../contracts/teamLifecycle';
import type {
  DiscardQueuedUserMessagesResult,
  QueuedUserMessagesSnapshot,
} from '@shared/types/team';
type Mutation = Extract<
  BackendOperationRequest,
  { operation: 'team.lifecycle.change' | 'team.lifecycle.purge' | 'team.queue.discard' }
>;
/** Existing Team/queue controls preserve original command, handle and exact lookup after wire uncertainty. */
export function createHostProductLifecycleApi(options: {
  backend: AgentBackendApi;
  captureScope(): () => boolean;
  resolve(key: string, current: () => boolean): Promise<{ handle: BackendHandle }>;
  invalidateReads(handle: BackendHandle): void;
}) {
  function check(current: () => boolean, commandId: string, dispatched = false): void {
    if (!current())
      throw new HostTeamOperationError(
        'context-changed',
        dispatched ? 'unknown' : 'not-dispatched',
        commandId
      );
  }
  async function target(key: string) {
    const current = options.captureScope(),
      commandId = crypto.randomUUID();
    check(current, commandId);
    const selected = await options.resolve(key, current);
    check(current, commandId);
    return { current, commandId, handle: { ...selected.handle } };
  }
  function receipt(
    result: BackendOperationResult | undefined,
    request: Mutation
  ):
    | BackendTeamLifecycleReceipt
    | BackendTeamPurgeReceipt
    | BackendQueuedDiscardReceipt
    | undefined {
    if (
      !result?.ok ||
      !result.value ||
      !('kind' in result.value) ||
      !('commandId' in result.value) ||
      result.value.commandId !== request.commandId
    )
      return;
    if (
      request.operation === 'team.lifecycle.change' &&
      result.value.kind === 'team_lifecycle' &&
      typeof result.value.revision === 'string' &&
      /^[a-f0-9]{64}$/.test(result.value.revision) &&
      typeof result.value.cleanupPending === 'boolean' &&
      (request.payload.action === 'trash'
        ? typeof result.value.deletedAt === 'string' && !!result.value.deletedAt
        : result.value.deletedAt === null)
    )
      return result.value;
    if (
      request.operation === 'team.queue.discard' &&
      result.value.kind === 'queued_discard' &&
      result.value.phase === 'completed' &&
      Number.isSafeInteger(result.value.discarded) &&
      result.value.discarded >= 0 &&
      result.value.discarded <= request.payload.messageIds.length &&
      Number.isSafeInteger(result.value.remainingQueued) &&
      result.value.remainingQueued >= 0
    )
      return result.value;
    if (
      request.operation === 'team.lifecycle.purge' &&
      result.value.kind === 'team_purge' &&
      result.value.phase === 'deleted' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        result.value.transactionId
      )
    )
      return result.value;
  }
  async function mutate(request: Mutation, current: () => boolean) {
    check(current, request.commandId);
    options.invalidateReads(request.handle);
    try {
      let result: BackendOperationResult | undefined;
      try {
        result = await options.backend.invoke(request);
      } catch {
        /* Resolve only the same original receipt. */
      }
      check(current, request.commandId, true);
      const completed = receipt(result, request);
      if (completed) return completed;
      if (result && !result.ok && result.outcome !== 'unknown')
        throw new HostTeamOperationError(result.code, result.outcome, request.commandId);
      const lookup: BackendOperationRequest =
        request.operation === 'team.lifecycle.change'
          ? {
              handle: request.handle,
              commandId: request.commandId,
              operation: 'team.lifecycle.lookup',
              payload: { expected: request.payload },
            }
          : request.operation === 'team.lifecycle.purge'
            ? {
                handle: request.handle,
                commandId: request.commandId,
                operation: 'team.lifecycle.purge.lookup',
                payload: { expected: request.payload },
              }
            : {
                handle: request.handle,
                commandId: request.commandId,
                operation: 'team.queue.lookup',
                payload: { expected: request.payload },
              };
      try {
        result = await options.backend.invoke(lookup);
      } catch {
        result = undefined;
      }
      check(current, request.commandId, true);
      const resolved = receipt(result, request);
      if (resolved) return resolved;
      throw new HostTeamOperationError('original-receipt-unresolved', 'unknown', request.commandId);
    } finally {
      if (current()) options.invalidateReads(request.handle);
    }
  }
  async function lifecycle(key: string, action: 'trash' | 'restore' | 'purge'): Promise<void> {
    const original = await target(key);
    const result = await options.backend.invoke({
      handle: original.handle,
      commandId: crypto.randomUUID(),
      operation: 'team.lifecycle.read',
      payload: {},
    });
    check(original.current, original.commandId);
    if (!result.ok)
      throw new HostTeamOperationError(result.code, result.outcome, original.commandId);
    if (
      !result.value ||
      !('kind' in result.value) ||
      result.value.kind !== 'team_lifecycle' ||
      !/^[a-f0-9]{64}$/.test(result.value.revision)
    )
      throw new HostTeamOperationError(
        'invalid-lifecycle-view',
        'not-dispatched',
        original.commandId
      );
    const pending = action === 'purge' ? result.value.pendingPurge : undefined;
    if (
      pending &&
      (!pending.commandId ||
        pending.commandId.length > 256 ||
        pending.commandId.includes('\0') ||
        !/^[a-f0-9]{64}$/.test(pending.expectedRevision))
    )
      throw new HostTeamOperationError(
        'invalid-prepared-purge',
        'not-dispatched',
        original.commandId
      );
    const request: Mutation =
      action === 'purge'
        ? {
            handle: original.handle,
            commandId: pending?.commandId ?? original.commandId,
            operation: 'team.lifecycle.purge',
            payload: { expectedRevision: pending?.expectedRevision ?? result.value.revision },
          }
        : {
            handle: original.handle,
            commandId: original.commandId,
            operation: 'team.lifecycle.change',
            payload: { expectedRevision: result.value.revision, action },
          };
    await mutate(request, original.current);
  }
  return {
    deleteTeam: (key: string) => lifecycle(key, 'trash'),
    restoreTeam: (key: string) => lifecycle(key, 'restore'),
    permanentlyDeleteTeam: (key: string) => lifecycle(key, 'purge'),
    async getQueuedUserMessages(key: string, member: string): Promise<QueuedUserMessagesSnapshot> {
      const original = await target(key);
      const result = await options.backend.invoke({
        handle: original.handle,
        commandId: original.commandId,
        operation: 'team.queue.read',
        payload: { member },
      });
      check(original.current, original.commandId);
      if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
      if (
        !result.value ||
        !('kind' in result.value) ||
        result.value.kind !== 'queued_user_messages' ||
        result.value.member !== member ||
        !Array.isArray(result.value.messages)
      )
        throw new HostTeamOperationError('invalid-queue-view', 'unknown');
      return { member: result.value.member, messages: structuredClone(result.value.messages) };
    },
    async discardQueuedUserMessages(
      key: string,
      member: string,
      messageIds: readonly string[]
    ): Promise<DiscardQueuedUserMessagesResult> {
      const selectedIds = [...messageIds];
      const original = await target(key);
      const result = await mutate(
        {
          handle: original.handle,
          commandId: original.commandId,
          operation: 'team.queue.discard',
          payload: { member, messageIds: selectedIds },
        },
        original.current
      );
      if (result.kind !== 'queued_discard' || result.phase !== 'completed')
        throw new HostTeamOperationError('invalid-discard-receipt', 'unknown', original.commandId);
      return { discarded: result.discarded, remainingQueued: result.remainingQueued };
    },
  };
}

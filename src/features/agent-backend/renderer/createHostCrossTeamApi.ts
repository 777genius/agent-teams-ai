import { HostTeamOperationError } from './createHostTeamMutations';
import { hostTeamSelectionKey, isHostTeamSelectionKey } from './hostTeamRouting';
import {
  qualifyHostTaskReferenceTeam,
  translateHostTaskReferences,
} from './translateHostTaskReferences';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { BackendCrossTeamOutboxRow, CrossTeamReference } from '../contracts/crossTeam';
import type { BackendHandle } from '../contracts/index';
import type { AgentBackendApi } from '../contracts/operations';
import type { BackendTeamSnapshot } from '../contracts/teamSnapshot';
import type { CrossTeamSendRequest } from '@shared/types';
import type { CrossTeamAPI } from '@shared/types/api';

type Connection = BackendConnectionSnapshot['bindings'][number];

/** Existing CrossTeam UI; each send captures its immutable source and target once. */
export function createHostCrossTeamApi(
  legacy: CrossTeamAPI,
  backend: AgentBackendApi,
  captureScope: () => () => boolean
): CrossTeamAPI {
  const assertCurrent = (current: () => boolean, id?: string, afterDispatch = false) => {
    if (!current())
      throw new HostTeamOperationError(
        'context-changed',
        afterDispatch ? 'unknown' : 'not-dispatched',
        id
      );
  };
  async function connections(current: () => boolean) {
    const result = await backend.getConnections();
    assertCurrent(current);
    if (result.state !== 'ready') throw new HostTeamOperationError('unavailable', 'not-dispatched');
    return result.bindings;
  }
  function selected(bindings: Connection[], key: string) {
    const result = bindings.find((row) => hostTeamSelectionKey(row.handle.handleId) === key);
    if (!result) throw new HostTeamOperationError('unavailable', 'not-dispatched');
    return structuredClone(result);
  }
  async function snapshot(
    handle: BackendHandle,
    current: () => boolean
  ): Promise<BackendTeamSnapshot> {
    const result = await backend.invoke({
      handle,
      commandId: crypto.randomUUID(),
      operation: 'team.snapshot',
      payload: {},
    });
    assertCurrent(current);
    if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
    if (!result.value || !('revision' in result.value) || !('kanbanState' in result.value))
      throw new HostTeamOperationError('invalid-result', 'unknown');
    return result.value as BackendTeamSnapshot;
  }
  function references(request: CrossTeamSendRequest): CrossTeamReference[] | undefined {
    return request.taskRefs?.map((ref) => {
      if (ref.teamName !== request.fromTeam && ref.teamName !== request.toTeam)
        throw new HostTeamOperationError('unsupported', 'not-dispatched', request.messageId);
      return {
        taskId: ref.taskId,
        displayId: ref.displayId,
        team: ref.teamName === request.fromTeam ? 'source' : 'target',
      };
    });
  }
  return {
    async listTargets(excludeTeam) {
      // The caller supplies the originating selection before awaiting. Legacy callers retain their API.
      if (!isHostTeamSelectionKey(excludeTeam)) return legacy.listTargets(excludeTeam);
      const current = captureScope();
      const rows = await connections(current);
      const source = selected(rows, excludeTeam);
      if (!source.ownerResourceRef)
        throw new HostTeamOperationError('unavailable', 'not-dispatched');
      const targets = await Promise.all(
        rows
          .filter(
            (row) =>
              row.ownerResourceRef === source.ownerResourceRef &&
              hostTeamSelectionKey(row.handle.handleId) !== excludeTeam
          )
          .map(async (row) => {
            const product = await snapshot(row.handle, current);
            const lead = product.members.find((member) => member.role === 'lead');
            return {
              teamName: hostTeamSelectionKey(row.handle.handleId),
              displayName: row.label,
              ...(lead ? { leadName: lead.name } : {}),
              members: product.members.map((member) => ({ name: member.name })),
            };
          })
      );
      assertCurrent(current);
      return targets;
    },
    async send(input) {
      const request = structuredClone(input);
      const fromHost = isHostTeamSelectionKey(request.fromTeam),
        toHost = isHostTeamSelectionKey(request.toTeam);
      if (!fromHost && !toHost) return legacy.send(request);
      if (!fromHost || !toHost || request.requireRuntimeDelivery)
        throw new HostTeamOperationError('unsupported', 'not-dispatched', request.messageId);
      const current = captureScope();
      const commandId = request.messageId ?? crypto.randomUUID();
      const rows = await connections(current);
      const source = selected(rows, request.fromTeam),
        target = selected(rows, request.toTeam);
      if (!source.ownerResourceRef || source.ownerResourceRef !== target.ownerResourceRef)
        throw new HostTeamOperationError('unsupported', 'not-dispatched', commandId);
      if (source.handle.handleId === target.handle.handleId)
        throw new HostTeamOperationError('invalid', 'not-dispatched', commandId);
      const [sourceProduct, targetProduct] = await Promise.all([
        snapshot(source.handle, current),
        snapshot(target.handle, current),
      ]);
      const canonicalRef = (team?: string) => {
        if (team === undefined || team === request.fromTeam) return sourceProduct.teamName;
        if (team === request.toTeam) return targetProduct.teamName;
        throw new HostTeamOperationError('unsupported', 'not-dispatched', commandId);
      };
      const taskRefs = references(request);
      const payload = {
        target: target.handle,
        fromMember: request.fromMember,
        ...(request.toMember === undefined ? {} : { toMember: request.toMember }),
        text: translateHostTaskReferences(request.text, canonicalRef),
        messageId: commandId,
        ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
        ...(request.replyToConversationId === undefined
          ? {}
          : { replyToConversationId: request.replyToConversationId }),
        ...(request.timestamp === undefined ? {} : { timestamp: request.timestamp }),
        ...(request.summary === undefined
          ? {}
          : { summary: translateHostTaskReferences(request.summary, canonicalRef) }),
        ...(request.actionMode === undefined ? {} : { actionMode: request.actionMode }),
        ...(request.chainDepth === undefined ? {} : { chainDepth: request.chainDepth }),
        ...(taskRefs === undefined ? {} : { taskRefs }),
      };
      assertCurrent(current, commandId);
      let result;
      try {
        result = await backend.invoke({
          handle: source.handle,
          commandId,
          operation: 'crossTeam.send',
          payload,
        });
      } catch {
        throw new HostTeamOperationError('transport-unavailable', 'unknown', commandId);
      }
      assertCurrent(current, commandId, true);
      if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome, commandId);
      const receipt = result.value;
      if (
        !receipt ||
        !('kind' in receipt) ||
        receipt.kind !== 'cross-team-receipt' ||
        receipt.commandId !== commandId ||
        receipt.messageId !== commandId ||
        (payload.conversationId !== undefined && receipt.conversationId !== payload.conversationId)
      )
        throw new HostTeamOperationError('invalid-result', 'unknown', commandId);
      if (receipt.phase !== 'completed')
        throw new HostTeamOperationError('hold', 'unknown', commandId);
      return {
        messageId: commandId,
        deliveredToInbox: true,
        deduplicated: receipt.deduplicated,
        toTeam: request.toTeam,
        toMember: receipt.toMember,
      };
    },
    async getOutbox(teamName) {
      if (!isHostTeamSelectionKey(teamName)) return legacy.getOutbox(teamName);
      const current = captureScope();
      const rows = await connections(current);
      const source = selected(rows, teamName);
      const result = await backend.invoke({
        handle: source.handle,
        commandId: crypto.randomUUID(),
        operation: 'crossTeam.outbox.read',
        payload: {},
      });
      assertCurrent(current);
      if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
      if (!result.value || !('kind' in result.value) || result.value.kind !== 'cross-team-outbox')
        throw new HostTeamOperationError('invalid-result', 'unknown');
      return result.value.rows.map((row: BackendCrossTeamOutboxRow) => {
        const resolve = (handleId: string | undefined, resourceRef: string) => {
          const binding = rows.find((item) =>
            handleId !== undefined
              ? item.handle.handleId === handleId
              : item.teamResourceRef === resourceRef
          );
          if (!binding || binding.ownerResourceRef !== source.ownerResourceRef)
            throw new HostTeamOperationError('unavailable', 'unknown');
          return hostTeamSelectionKey(binding.handle.handleId);
        };
        const sourceKey = resolve(row.fromHandleId, row.fromTeamResourceRef),
          targetKey = resolve(row.toHandleId, row.toTeamResourceRef);
        const qualified = (team?: string) =>
          team === row.toTeamName
            ? targetKey
            : qualifyHostTaskReferenceTeam(team, row.fromTeamName, sourceKey);
        return {
          messageId: row.messageId,
          fromTeam: sourceKey,
          fromMember: row.fromMember,
          toTeam: targetKey,
          toMember: row.toMember,
          conversationId: row.conversationId,
          ...(row.replyToConversationId === undefined
            ? {}
            : { replyToConversationId: row.replyToConversationId }),
          text: translateHostTaskReferences(row.text, qualified),
          ...(row.summary === undefined
            ? {}
            : { summary: translateHostTaskReferences(row.summary, qualified) }),
          timestamp: row.timestamp,
          chainDepth: row.chainDepth,
          taskRefs: row.taskRefs?.map((ref) => ({
            taskId: ref.taskId,
            displayId: ref.displayId,
            teamName: ref.team === 'source' ? sourceKey : targetKey,
          })),
        };
      });
    },
  };
}

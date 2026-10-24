import {
  readGroupCommand,
  readGroupList,
  readGroupReaction,
} from '@agent-teams/legacy-agent-host/group-chats/public-values';

import { HostTeamOperationError } from './createHostTeamMutations';
import { hostTeamSelectionKey, isHostTeamSelectionKey } from './hostTeamRouting';
import { translateHostTaskReferences } from './translateHostTaskReferences';

import type { BackendGroupPayloads } from '../contracts/groupChats';
import type {
  AgentBackendApi,
  BackendOperationRequest,
  BackendOperationResult,
} from '../contracts/operations';
import type { TeamGroupChatsAPI } from '@features/team-group-chats/contracts';

/** Existing group UI; opaque Host selections never enter the legacy filesystem IPC. */
export function createHostGroupChatsApi(
  legacy: TeamGroupChatsAPI,
  backend: AgentBackendApi,
  captureScope: () => () => boolean
): TeamGroupChatsAPI {
  type GroupRequest = {
    [K in keyof BackendGroupPayloads]: { operation: K; payload: BackendGroupPayloads[K] };
  }[keyof BackendGroupPayloads];
  async function invoke(teamName: string, input: GroupRequest, commandId = crypto.randomUUID()) {
    const { operation } = input;
    const current = captureScope();
    const check = (dispatched = false) => {
      if (!current())
        throw new HostTeamOperationError(
          'context-changed',
          dispatched ? 'unknown' : 'not-dispatched',
          commandId
        );
    };
    check();
    const connections = await backend.getConnections();
    check();
    if (connections.state !== 'ready')
      throw new HostTeamOperationError('unavailable', 'not-dispatched', commandId);
    const selected = connections.bindings.find(
      (row) => hostTeamSelectionKey(row.handle.handleId) === teamName
    );
    if (!selected) throw new HostTeamOperationError('unavailable', 'not-dispatched', commandId);
    let request: BackendOperationRequest = { ...input, handle: selected.handle, commandId };
    if (request.operation === 'group.send') {
      const product = await backend.invoke({
        handle: selected.handle,
        commandId: crypto.randomUUID(),
        operation: 'team.snapshot',
        payload: {},
      });
      check();
      if (!product.ok || !product.value || !('kanbanState' in product.value))
        throw new HostTeamOperationError('unavailable', 'not-dispatched', commandId);
      const canonicalName = product.value.teamName;
      const canonical = (ref?: string) => {
        if (ref === undefined || ref === teamName) return canonicalName;
        throw new HostTeamOperationError('unsupported', 'not-dispatched', commandId);
      };
      request = {
        ...request,
        payload: {
          ...request.payload,
          text: translateHostTaskReferences(request.payload.text, canonical),
          ...(request.payload.summary === undefined
            ? {}
            : { summary: translateHostTaskReferences(request.payload.summary, canonical) }),
          ...(request.payload.taskRefs === undefined
            ? {}
            : {
                taskRefs: request.payload.taskRefs.map((ref) => ({
                  ...ref,
                  teamName: canonical(ref.teamName),
                })),
              }),
        },
      };
    }
    let result: BackendOperationResult;
    try {
      result = await backend.invoke(request);
    } catch {
      check(true);
      if (['group.list', 'group.reaction.read', 'group.lookup'].includes(operation))
        throw new HostTeamOperationError('transport-unavailable', 'unknown', commandId);
      // Lookup the original receipt only. No mutation retry or replacement command is issued.
      result = await backend.invoke({
        handle: selected.handle,
        commandId,
        operation: 'group.lookup',
        payload: {},
      });
    }
    check(true);
    if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome, commandId);
    return { value: result.value, commandId };
  }
  async function mutation(
    team: string,
    input: Exclude<
      GroupRequest,
      { operation: 'group.list' | 'group.reaction.read' | 'group.lookup' }
    >
  ) {
    const observed = await invoke(team, input);
    const receipt = readGroupCommand(observed.value, observed.commandId);
    if (
      receipt.phase !== 'completed' ||
      receipt.operation !== input.operation.slice('group.'.length) ||
      receipt.result === undefined
    )
      throw new HostTeamOperationError('hold', 'unknown', observed.commandId);
    return receipt.result;
  }
  return {
    async list(request) {
      if (!isHostTeamSelectionKey(request.teamName)) return legacy.list(request);
      return readGroupList(
        (await invoke(request.teamName, { operation: 'group.list', payload: {} })).value
      );
    },
    async create(request) {
      if (!isHostTeamSelectionKey(request.teamName)) return legacy.create(request);
      const { teamName, ...payload } = request;
      const result = await mutation(teamName, { operation: 'group.create', payload });
      if (!('membership' in result)) throw new Error('Invalid group result');
      return result;
    },
    async setArchived(request) {
      if (!isHostTeamSelectionKey(request.teamName)) return legacy.setArchived(request);
      const { teamName, ...payload } = request;
      const result = await mutation(teamName, { operation: 'group.archive', payload });
      if (!('membership' in result)) throw new Error('Invalid group result');
      return result;
    },
    async send(request) {
      if (!isHostTeamSelectionKey(request.teamName)) return legacy.send(request);
      const { teamName, ...payload } = request;
      const result = await mutation(teamName, { operation: 'group.send', payload });
      if (!('statusPersisted' in result)) throw new Error('Invalid group send result');
      return result;
    },
    async getReaction(request) {
      if (!isHostTeamSelectionKey(request.teamName)) return legacy.getReaction(request);
      const { teamName, ...payload } = request;
      return readGroupReaction(
        (await invoke(teamName, { operation: 'group.reaction.read', payload })).value
      );
    },
    async setReaction(request) {
      if (!isHostTeamSelectionKey(request.teamName)) return legacy.setReaction(request);
      const { teamName, ...payload } = request;
      const result = await mutation(teamName, { operation: 'group.reaction.set', payload });
      if (!('actorNames' in result)) throw new Error('Invalid group reaction');
      return result;
    },
  };
}

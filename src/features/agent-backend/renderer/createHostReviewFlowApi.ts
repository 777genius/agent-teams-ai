import { parseReviewFlowSettings } from '@features/review-flow';

import { HostTeamOperationError } from './createHostTeamMutations';
import { hostTeamSelectionKey, isHostTeamSelectionKey } from './hostTeamRouting';

import type { AgentBackendApi, BackendOperationResult } from '../contracts/operations';
import type { ReviewFlowOverview, ReviewFlowSettings } from '@features/review-flow';
import type { ReviewFlowElectronApi } from '@features/review-flow/contracts';

/** Global defaults retain their existing owner; each Host override stays with its captured Team. */
export function createHostReviewFlowApi(
  legacy: ReviewFlowElectronApi,
  backend: AgentBackendApi,
  captureScope: () => () => boolean
): ReviewFlowElectronApi {
  const capture = (commandId?: string) => {
    const current = captureScope();
    return (dispatched = false) => {
      if (!current()) throw new HostTeamOperationError('context-changed',
        dispatched ? 'unknown' : 'not-dispatched', commandId);
    };
  };
  const normalize = (settings: ReviewFlowSettings): ReviewFlowSettings => {
    const parsed = parseReviewFlowSettings(settings);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.settings;
  };
  return {
    async getOverview() {
      const check = capture();
      check();
      const [overview, connections] = await Promise.all([legacy.getOverview(), backend.getConnections()]);
      check();
      if (connections.state === 'unconfigured') return overview;
      if (connections.state !== 'ready') throw new HostTeamOperationError('unavailable', 'not-dispatched');
      const result: ReviewFlowOverview = {
        ...overview,
        overrides: { ...overview.overrides }, unreadableTeams: [...overview.unreadableTeams],
        unavailable: [...(overview.unavailable ?? []), ...(connections.unavailableOwners ?? [])],
      };
      await Promise.all(connections.bindings.map(async (binding) => {
        const teamName = hostTeamSelectionKey(binding.handle.handleId);
        let value: BackendOperationResult;
        try {
          value = await backend.invoke({ handle: binding.handle, commandId: crypto.randomUUID(),
            operation: 'team.review-flow.read', payload: {} });
        } catch {
          value = { ok: false, code: 'unavailable', outcome: 'unknown' };
        }
        check();
        if (!value.ok || !value.value || !('kind' in value.value) || value.value.kind !== 'review-flow') {
          result.unavailable!.push({ kind: 'team', teamName, displayName: binding.label,
            code: !value.ok && (value.code === 'busy' || value.code === 'shutting-down')
              ? value.code : 'unavailable', outcome: value.ok ? 'unknown' : value.outcome });
          return;
        }
        if (value.value.unreadable) result.unreadableTeams.push(teamName);
        else if (value.value.settings) result.overrides[teamName] = normalize(value.value.settings);
      }));
      check();
      return result;
    },
    async setDefaults(settings) {
      const check = capture();
      check();
      const saved = await legacy.setDefaults(normalize(settings));
      check(true);
      return saved;
    },
    async setTeamOverride(teamName, settings) {
      const commandId = crypto.randomUUID();
      const check = capture(commandId);
      check();
      const selectedSettings = settings === null ? null : normalize(settings);
      if (!isHostTeamSelectionKey(teamName)) {
        const saved = await legacy.setTeamOverride(teamName, selectedSettings);
        check(true);
        return saved;
      }
      const connections = await backend.getConnections();
      check();
      const selected = connections.state === 'ready' && connections.bindings.find(
        (binding) => hostTeamSelectionKey(binding.handle.handleId) === teamName
      );
      if (!selected) throw new HostTeamOperationError('unavailable', 'not-dispatched', commandId);
      const handle = Object.freeze({ ...selected.handle });
      let result: BackendOperationResult;
      try {
        result = await backend.invoke({ handle, commandId,
          operation: 'task.board.review-flow', payload: { settings: selectedSettings } });
      } catch {
        result = { ok: false, code: 'unavailable', outcome: 'unknown' };
      }
      check(true);
      const recovering = !result.ok && result.outcome === 'unknown';
      if (recovering) {
        // Observe only the original command; never retry a mutation with another identity.
        try {
          result = await backend.invoke({ handle, commandId,
            operation: 'command.lookup', payload: {} });
        } catch {
          throw new HostTeamOperationError('transport-unavailable', 'unknown', commandId);
        }
      }
      check(true);
      if (!result.ok) throw new HostTeamOperationError(result.code,
        recovering ? 'unknown' : result.outcome, commandId);
      const receipt = result.value;
      if (!receipt || !('commandId' in receipt) || receipt.commandId !== commandId ||
          !('operation' in receipt) || receipt.operation !== 'task.board.review-flow' ||
          !('phase' in receipt) || receipt.phase !== 'completed')
        throw new HostTeamOperationError('unavailable', 'unknown', commandId);
      return selectedSettings;
    },
  };
}

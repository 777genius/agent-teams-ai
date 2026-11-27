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
      if (!current())
        throw new HostTeamOperationError(
          'context-changed',
          dispatched ? 'unknown' : 'not-dispatched',
          commandId
        );
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
      const [overview, connections] = await Promise.all([
        legacy.getOverview(),
        backend.getConnections(),
      ]);
      check();
      if (connections.state === 'unconfigured') return overview;
      if (connections.state !== 'ready')
        throw new HostTeamOperationError('unavailable', 'not-dispatched');
      const bindings = structuredClone(connections.bindings);
      const result: ReviewFlowOverview = {
        ...overview,
        overrides: { ...overview.overrides },
        unreadableTeams: [...overview.unreadableTeams],
        unavailable: [...(overview.unavailable ?? []), ...(connections.unavailableOwners ?? [])],
        projectTeams: { ...overview.projectTeams },
      };
      const unavailable = (binding: (typeof bindings)[number], value?: BackendOperationResult) => {
        result.unavailable!.push({
          kind: 'team',
          teamName: hostTeamSelectionKey(binding.handle.handleId),
          displayName: binding.label,
          code:
            value && !value.ok && (value.code === 'busy' || value.code === 'shutting-down')
              ? value.code
              : 'unavailable',
          outcome: value && !value.ok ? value.outcome : 'unknown',
        });
      };
      // A family can have many histories; keep the original finite Host control lane available.
      for (const binding of bindings) {
        const teamName = hostTeamSelectionKey(binding.handle.handleId);
        let value: BackendOperationResult;
        try {
          value = await backend.invoke({
            handle: binding.handle,
            commandId: crypto.randomUUID(),
            operation: 'team.review-flow.read',
            payload: {},
          });
        } catch {
          value = { ok: false, code: 'unavailable', outcome: 'unknown' };
        }
        check();
        if (
          !value.ok ||
          !value.value ||
          !('kind' in value.value) ||
          value.value.kind !== 'review-flow'
        ) {
          unavailable(binding, value);
          continue;
        }
        if (value.value.unreadable) result.unreadableTeams.push(teamName);
        else if (value.value.settings) result.overrides[teamName] = normalize(value.value.settings);
        const project = value.value.projectTeam;
        if (project) {
          const projects: { executionTeamName: string; projectPath: string }[] = [];
          let invalid =
            !binding.ownerResourceRef ||
            !!binding.projectContext ||
            binding.projectContextMode !== 'per_project';
          for (const item of project.projects) {
            const children = bindings.filter(
              (child) => child.handle.handleId === item.executionHandleId
            );
            const child = children.length === 1 ? children[0] : undefined;
            if (
              !child ||
              child.ownerResourceRef !== binding.ownerResourceRef ||
              child.projectContext?.logicalHandleId !== binding.handle.handleId ||
              child.projectContext.projectPath !== item.projectPath
            ) {
              invalid = true;
              continue;
            }
            projects.push({
              executionTeamName: hostTeamSelectionKey(item.executionHandleId),
              projectPath: item.projectPath,
            });
          }
          if (invalid) unavailable(binding);
          else
            result.projectTeams[teamName] = {
              saved: project.saved,
              settings: project.settings === null ? null : normalize(project.settings),
              ...(project.unreadable ? { unreadable: true } : {}),
              projects,
            };
        } else if (binding.projectContextMode === 'per_project' && !binding.projectContext)
          unavailable(binding);
      }
      for (const binding of bindings) {
        if (!binding.projectContext) continue;
        const childKey = hostTeamSelectionKey(binding.handle.handleId);
        const parent = bindings.find(
          (row) =>
            row.handle.handleId === binding.projectContext!.logicalHandleId &&
            row.ownerResourceRef &&
            row.ownerResourceRef === binding.ownerResourceRef &&
            !row.projectContext
        );
        if (
          parent &&
          result.unavailable!.some((value) => value.kind === 'team' && value.teamName === childKey)
        )
          unavailable(parent);
      }
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
      let commandId: string = crypto.randomUUID();
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
      const selectedSettings = settings === null ? null : normalize(settings);
      if (!isHostTeamSelectionKey(teamName)) {
        const saved = await legacy.setTeamOverride(teamName, selectedSettings);
        check(true);
        return saved;
      }
      const connections = await backend.getConnections();
      check();
      const selected =
        connections.state === 'ready' &&
        structuredClone(connections.bindings).find(
          (binding) => hostTeamSelectionKey(binding.handle.handleId) === teamName
        );
      if (!selected) throw new HostTeamOperationError('unavailable', 'not-dispatched', commandId);
      if (selected.projectContext)
        throw new HostTeamOperationError('read-only-project-history', 'not-dispatched', commandId);
      const handle = Object.freeze({ ...selected.handle });
      if (selected.projectContextMode === 'per_project') {
        const observed = await backend.invoke({
          handle,
          commandId: crypto.randomUUID(),
          operation: 'team.review-flow.read',
          payload: {},
        });
        check();
        if (!observed.ok)
          throw new HostTeamOperationError(observed.code, observed.outcome, commandId);
        if (
          !observed.value ||
          !('kind' in observed.value) ||
          observed.value.kind !== 'review-flow' ||
          !observed.value.projectTeam
        )
          throw new HostTeamOperationError('unavailable', 'not-dispatched', commandId);
        const pending = observed.value.pending;
        if (pending) {
          if (JSON.stringify(pending.settings) !== JSON.stringify(selectedSettings))
            throw new HostTeamOperationError(
              'original-review-policy-pending',
              'not-dispatched',
              pending.commandId
            );
          commandId = pending.commandId;
        }
      }
      let result: BackendOperationResult;
      try {
        result = await backend.invoke({
          handle,
          commandId,
          operation: 'task.board.review-flow',
          payload: { settings: selectedSettings },
        });
      } catch {
        result = { ok: false, code: 'unavailable', outcome: 'unknown' };
      }
      check(true);
      const recovering = !result.ok && result.outcome === 'unknown';
      if (recovering) {
        // Observe only the original command; never retry a mutation with another identity.
        try {
          result = await backend.invoke({
            handle,
            commandId,
            operation: 'command.lookup',
            payload: {},
          });
        } catch {
          throw new HostTeamOperationError('transport-unavailable', 'unknown', commandId);
        }
      }
      check(true);
      if (!result.ok)
        throw new HostTeamOperationError(
          result.code,
          recovering ? 'unknown' : result.outcome,
          commandId
        );
      const receipt = result.value;
      if (
        !receipt ||
        !('commandId' in receipt) ||
        receipt.commandId !== commandId ||
        !('operation' in receipt) ||
        receipt.operation !== 'task.board.review-flow' ||
        !('phase' in receipt) ||
        receipt.phase !== 'completed'
      )
        throw new HostTeamOperationError('unavailable', 'unknown', commandId);
      return selectedSettings;
    },
  };
}

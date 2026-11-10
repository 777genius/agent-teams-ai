import { hostTeamRunId } from '../contracts/teamRunSelection';
import { parseHostTeamSelectionKey } from '../contracts/teamSelection';

import { createHostTeamLaunch } from './createHostTeamLaunch';
import { HostTeamOperationError } from './createHostTeamMutations';

import type { AgentBackendApi } from '../contracts/operations';
import type { TeamLaunchRequest, TeamLaunchResponse } from '@shared/types/team';

/** Ordinary launch consumes the exact confirmed roster intent; it never rereads newer defaults. */
export function createHostTeamLaunchSubmission(options: {
  backend: AgentBackendApi;
  captureScope(): () => boolean;
  invalidateReads(handleId: string, current: () => boolean): void;
}) {
  return async (raw: TeamLaunchRequest): Promise<TeamLaunchResponse> => {
    const request = structuredClone(raw),
      current = options.captureScope();
    const handleId = parseHostTeamSelectionKey(request.teamName);
    const command = request.command;
    if (
      !command ||
      command.commandId !== command.idempotencyKey ||
      typeof command.commandId !== 'string' ||
      !command.commandId.trim() ||
      command.commandId.length > 240 ||
      command.commandId.includes('\0') ||
      typeof request.savedRosterCommandId !== 'string' ||
      !request.savedRosterCommandId.trim() ||
      request.savedRosterCommandId.length > 256 ||
      request.savedRosterCommandId.includes('\0')
    )
      throw new HostTeamOperationError('launch-source-required', 'not-dispatched');
    if (!current())
      throw new HostTeamOperationError('context-changed', 'not-dispatched', command.commandId);
    const launch = createHostTeamLaunch(options.backend, request.teamName, current);
    options.invalidateReads(handleId, current);
    try {
      const view = await launch.capture(
        request.savedRosterCommandId,
        `capture:${command.commandId}`
      );
      if (!current())
        throw new HostTeamOperationError('context-changed', 'unknown', command.commandId);
      const result = await launch.start(view, undefined, command.commandId);
      if (!current())
        throw new HostTeamOperationError('context-changed', 'unknown', command.commandId);
      return {
        runId: hostTeamRunId(handleId, result.launchId, result.rosterRevision),
        launchStatus: 'started',
      };
    } finally {
      if (current()) options.invalidateReads(handleId, current);
    }
  };
}

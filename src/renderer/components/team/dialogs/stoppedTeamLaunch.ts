import {
  isHostTeamSelectionKey,
  parseHostTeamSelectionKey,
} from '@features/agent-backend/contracts';
import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import type { TeamLaunchDialogMode } from './LaunchTeamDialog.types';
import type { ResolvedTeamMember, TeamMemberSnapshot } from '@shared/types';

export function resolveLaunchDialogMembers(
  members: readonly TeamMemberSnapshot[]
): ResolvedTeamMember[] {
  return members.map((member) => ({
    ...member,
    status: member.currentTaskId ? 'active' : 'idle',
    messageCount: 0,
    lastActiveAt: null,
  }));
}

export class StoppedTeamLaunchHold extends Error {}
async function loadImportedDialog(teamName: string, projectPath: string) {
  try {
    const data = await api.teams.getData(teamName, { includeMemberBranches: false });
    return {
      teamName,
      mode: 'launch' as const,
      members: resolveLaunchDialogMembers(data.members ?? []),
      projectPath: data.config.projectPath ?? projectPath,
    };
  } catch {
    throw new StoppedTeamLaunchHold(
      'Imported Team configuration is unavailable. Reopen Launch to query the original import.'
    );
  }
}
/** Original list dialog hydration, including its draft fallback, with import refusal kept visible. */
export async function loadExistingTeamLaunchDialog(
  teamName: string,
  projectPath: string,
  mode: TeamLaunchDialogMode
) {
  try {
    let data;
    try {
      data = await api.teams.getData(teamName, { includeMemberBranches: false });
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('TEAM_DRAFT'))) throw error;
      const target = await stoppedTeamLaunchSelection(teamName, false);
      if (target !== teamName) return await loadImportedDialog(target, projectPath);
      return { teamName, mode, members: [] as ResolvedTeamMember[], projectPath };
    }
    const target = await stoppedTeamLaunchSelection(teamName, data.isAlive);
    if (target !== teamName) return await loadImportedDialog(target, projectPath);
    return {
      teamName,
      mode,
      members: resolveLaunchDialogMembers(data.members ?? []),
      projectPath: data.config.projectPath ?? projectPath,
    };
  } catch (error) {
    showStoppedTeamLaunchHold(error);
    return null;
  }
}
/** Original stopped action hands off to saved Host configuration; never dispatches Launch. */
export async function stoppedTeamLaunchSelection(
  teamName: string,
  isAlive: boolean | undefined
): Promise<string> {
  if (isHostTeamSelectionKey(teamName) || isAlive !== false || !api.agentBackend) return teamName;
  const epoch = captureContextScopedRequestEpoch();
  const current = () => isContextScopedRequestEpochCurrent(epoch);
  let state;
  try {
    state = await api.agentBackend.getConnections();
  } catch {
    throw new StoppedTeamLaunchHold(
      'Captured Host context is unavailable. Reopen Launch to query the original import.'
    );
  }
  if (!current()) throw new StoppedTeamLaunchHold('Team context changed. Reopen Launch.');
  if (state.state === 'unconfigured') return teamName;
  if (!api.agentBackend.stoppedImport)
    throw new StoppedTeamLaunchHold('Stopped Team import is unavailable in this context.');
  let result;
  try {
    result = await api.agentBackend.stoppedImport({ teamName, action: 'prepare' });
    if (
      !result.ok &&
      result.reason === 'held' &&
      result.outcome === 'not-dispatched' &&
      current()
    ) {
      const retry = await confirm({
        title: 'Stopped Team import held',
        message: 'Retry the original detached import? The legacy Team will remain unchanged.',
        confirmLabel: 'Retry original import',
        cancelLabel: 'Close',
      });
      if (retry && current())
        result = await api.agentBackend.stoppedImport({ teamName, action: 'retry' });
    }
  } catch {
    throw new StoppedTeamLaunchHold(
      'Import outcome unknown. Reopen Launch to query the original import; no launch was sent.'
    );
  }
  if (!current())
    throw new StoppedTeamLaunchHold(
      'Team context changed. Reopen Launch to recover the original import.'
    );
  if (!result.ok)
    throw new StoppedTeamLaunchHold(
      result.reason === 'native-custody-unverified'
        ? 'Legacy native ownership is not proven released. This Team cannot be imported yet.'
        : `Stopped Team import held: ${result.reason}. Reopen Launch to recover the original import.`
    );
  try {
    parseHostTeamSelectionKey(result.selection);
  } catch {
    throw new StoppedTeamLaunchHold('Imported Team selection is unavailable.');
  }
  return result.selection;
}
export function showStoppedTeamLaunchHold(error: unknown): void {
  void confirm({
    title: 'Team Launch unavailable',
    message: error instanceof Error ? error.message : 'Stopped Team import is unavailable.',
    confirmLabel: 'Close',
    variant: 'danger',
  });
}

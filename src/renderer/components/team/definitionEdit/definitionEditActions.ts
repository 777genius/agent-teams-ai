import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

import type { AddMemberRequest } from '@shared/types';

/**
 * A per-project team is edited through its logical team, but the screen shows
 * the native copy of the project that is open. These helpers write to the
 * logical team with the same IPC calls and then refresh the visible copy and
 * the team list (the main process refreshes the stopped copies).
 */
export async function refreshAfterDefinitionEdit(visibleTeamName: string): Promise<void> {
  const state = useStore.getState();
  await state.fetchTeams();
  await state.refreshTeamData(visibleTeamName);
}

export async function addDefinitionMember(
  logicalTeamName: string,
  visibleTeamName: string,
  request: AddMemberRequest
): Promise<void> {
  await api.teams.addMember(logicalTeamName, request);
  await refreshAfterDefinitionEdit(visibleTeamName);
}

export async function removeDefinitionMember(
  logicalTeamName: string,
  visibleTeamName: string,
  memberName: string
): Promise<void> {
  await api.teams.removeMember(logicalTeamName, memberName);
  await refreshAfterDefinitionEdit(visibleTeamName);
}

export async function restoreDefinitionMember(
  logicalTeamName: string,
  visibleTeamName: string,
  memberName: string
): Promise<void> {
  await api.teams.restoreMember(logicalTeamName, memberName);
  await refreshAfterDefinitionEdit(visibleTeamName);
}

interface NativeMemberActions {
  addMember: (teamName: string, request: AddMemberRequest) => Promise<void>;
  removeMember: (teamName: string, memberName: string) => Promise<void>;
  restoreMember: (teamName: string, memberName: string) => Promise<void>;
}

/** Add/remove/restore a member of the open team: a per-project team writes to its logical team. */
export function routeMemberActions(
  logicalTeamName: string | undefined,
  visibleTeamName: string,
  native: NativeMemberActions
): {
  add: (request: AddMemberRequest) => Promise<void>;
  remove: (name: string) => Promise<void>;
  restore: (name: string) => Promise<void>;
} {
  return {
    restore: (name) =>
      logicalTeamName
        ? restoreDefinitionMember(logicalTeamName, visibleTeamName, name)
        : native.restoreMember(visibleTeamName, name),
    add: (request) =>
      logicalTeamName
        ? addDefinitionMember(logicalTeamName, visibleTeamName, request)
        : native.addMember(visibleTeamName, request),
    remove: (name) =>
      logicalTeamName
        ? removeDefinitionMember(logicalTeamName, visibleTeamName, name)
        : native.removeMember(visibleTeamName, name),
  };
}

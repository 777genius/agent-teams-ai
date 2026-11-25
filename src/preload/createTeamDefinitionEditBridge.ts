import {
  TEAM_ADD_MEMBER,
  TEAM_REMOVE_MEMBER,
  TEAM_REPLACE_MEMBERS,
  TEAM_RESTORE_MEMBER,
  TEAM_UPDATE_CONFIG,
  TEAM_UPDATE_MEMBER_ROLE,
} from './constants/ipcChannels';

import type { TeamConfig } from '@shared/types';
import type { TeamDefinitionEditsTransport } from '@shared/types/teamDefinitionEdit';

type DefinitionEditInvoker<TRefusal> = <T>(
  channel: string,
  ...args: unknown[]
) => Promise<T | TRefusal>;

/** Keep raw and structured definition-edit transports on the same existing IPC channels. */
export function createTeamDefinitionEditBridge<TRefusal = never>(
  invoke: DefinitionEditInvoker<TRefusal>
): TeamDefinitionEditsTransport<TRefusal> {
  return {
    updateConfig: (teamName, updates) => invoke<TeamConfig>(TEAM_UPDATE_CONFIG, teamName, updates),
    addMember: (teamName, request) => invoke<void>(TEAM_ADD_MEMBER, teamName, request),
    replaceMembers: (teamName, request) => invoke<void>(TEAM_REPLACE_MEMBERS, teamName, request),
    removeMember: (teamName, memberName) => invoke<void>(TEAM_REMOVE_MEMBER, teamName, memberName),
    restoreMember: (teamName, memberName) =>
      invoke<void>(TEAM_RESTORE_MEMBER, teamName, memberName),
    updateMemberRole: (teamName, memberName, role) =>
      invoke<void>(TEAM_UPDATE_MEMBER_ROLE, teamName, memberName, role),
  };
}

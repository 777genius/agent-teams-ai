import {
  normalizeAddMemberInput,
  normalizeMemberMutationInput,
  normalizeReplaceMembersInput,
  normalizeUpdateMemberRoleInput,
} from './normalizeTeamRosterMutationInput';

import type { TeamRosterMutationFeature } from '../../../composition/createTeamRosterMutationFeature';
import type { IpcResult } from '@shared/types';

export function createTeamRosterMutationIpcHandlers(feature: TeamRosterMutationFeature): {
  addMember: (_event: unknown, teamName: unknown, payload: unknown) => Promise<IpcResult<void>>;
  replaceMembers: (
    _event: unknown,
    teamName: unknown,
    request: unknown
  ) => Promise<IpcResult<void>>;
  removeMember: (
    _event: unknown,
    teamName: unknown,
    memberName: unknown
  ) => Promise<IpcResult<void>>;
  restoreMember: (
    _event: unknown,
    teamName: unknown,
    memberName: unknown
  ) => Promise<IpcResult<void>>;
  updateMemberRole: (
    _event: unknown,
    teamName: unknown,
    memberName: unknown,
    role: unknown
  ) => Promise<IpcResult<void>>;
} {
  const execute = async (
    operation: string,
    action: () => Promise<void>
  ): Promise<IpcResult<void>> => {
    try {
      await action();
      return { success: true, data: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      feature.logger.error(`[teams:${operation}] ${message}`);
      return { success: false, error: message };
    }
  };

  return {
    addMember: async (_event, teamName, payload) => {
      const normalized = normalizeAddMemberInput(teamName, payload);
      if (!normalized.valid) return { success: false, error: normalized.error };
      return execute('addMember', () =>
        feature.addMember.execute(normalized.value.teamName, normalized.value.member)
      );
    },
    replaceMembers: async (_event, teamName, request) => {
      const normalized = normalizeReplaceMembersInput(teamName, request);
      if (!normalized.valid) return { success: false, error: normalized.error };
      return execute('replaceMembers', () =>
        feature.replaceMembers.execute(normalized.value.teamName, normalized.value.members)
      );
    },
    removeMember: async (_event, teamName, memberName) => {
      const normalized = normalizeMemberMutationInput(teamName, memberName);
      if (!normalized.valid) return { success: false, error: normalized.error };
      return execute('removeMember', () =>
        feature.removeMember.execute(normalized.value.teamName, normalized.value.memberName)
      );
    },
    restoreMember: async (_event, teamName, memberName) => {
      const normalized = normalizeMemberMutationInput(teamName, memberName);
      if (!normalized.valid) return { success: false, error: normalized.error };
      return execute('restoreMember', () =>
        feature.restoreMember.execute(normalized.value.teamName, normalized.value.memberName)
      );
    },
    updateMemberRole: async (_event, teamName, memberName, role) => {
      const normalized = normalizeUpdateMemberRoleInput(teamName, memberName, role);
      if (!normalized.valid) return { success: false, error: normalized.error };
      return execute('updateMemberRole', () =>
        feature.updateMemberRole.execute(
          normalized.value.teamName,
          normalized.value.memberName,
          normalized.value.role
        )
      );
    },
  };
}

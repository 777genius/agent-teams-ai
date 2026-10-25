import { isDesktopMcpControlAvailable } from '@features/external-agent-connection/main';
import { encodeTeamMemberStorageKey } from '@main/services/team/TeamMemberStoragePaths';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';

import type { GroupChatRun } from '../composition/createTeamGroupChatsFeature';
import type { TeamAgentRuntimeSnapshot } from '@shared/types';

interface GroupChatRuntimeDependencies {
  getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
  /** Bridge owner validates its actual live instance and protocol handshake. */
  getOpenCodeGroupChatRun?(teamName: string, memberName: string): Promise<GroupChatRun | null>;
  teamsBasePath?: string;
}

/** Read current evidence on every admission and physical delivery check. */
export function createGroupChatRuntimePorts(deps: GroupChatRuntimeDependencies): {
  getRun(teamName: string, memberName: string): Promise<GroupChatRun | null>;
} {
  async function readRun(
    teamName: string,
    memberName: string,
    allowOpenCode: boolean
  ): Promise<GroupChatRun | null> {
    try {
      if (!isDesktopMcpControlAvailable()) return null;
      const snapshot = await deps.getTeamAgentRuntimeSnapshot(teamName);
      const member = snapshot.members[memberName];
      if (!member?.alive) return null;
      if (member.providerId === 'opencode') {
        return allowOpenCode
          ? ((await deps.getOpenCodeGroupChatRun?.(teamName, memberName)) ?? null)
          : null;
      }
      const path = join(
        deps.teamsBasePath ?? getTeamsBasePath(),
        teamName,
        'members',
        encodeTeamMemberStorageKey(memberName),
        '.member-work-sync',
        'runtime-admission',
        'capability.json'
      );
      if ((await stat(path)).size > 64 * 1024) return null;
      const proof: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!proof || typeof proof !== 'object') return null;
      const capability = proof as Record<string, unknown>;
      if (
        capability.teamName !== teamName ||
        capability.memberName !== memberName ||
        capability.processorReady !== true ||
        capability.groupChatProtocolVersion !== 1 ||
        typeof capability.bootstrapRunId !== 'string' ||
        !capability.bootstrapRunId ||
        !Number.isSafeInteger(capability.pid) ||
        (capability.pid as number) <= 0 ||
        capability.groupRunKey !== `${capability.bootstrapRunId}:${String(capability.pid)}`
      ) {
        return null;
      }
      const pid = capability.pid as number;
      // runtimePid identifies the agent when the pane/process root differs.
      if (pid !== (member.runtimePid ?? member.pid)) return null;
      if (
        capability.bootstrapRunId !== snapshot.runId &&
        capability.bootstrapRunId !== member.runtimeSessionId
      )
        return null;
      process.kill(pid, 0);
      const current = await deps.getTeamAgentRuntimeSnapshot(teamName);
      const currentMember = current.members[memberName];
      if (
        !isDesktopMcpControlAvailable() ||
        !currentMember?.alive ||
        currentMember.providerId === 'opencode' ||
        (currentMember.runtimePid ?? currentMember.pid) !== pid ||
        (capability.bootstrapRunId !== current.runId &&
          capability.bootstrapRunId !== currentMember.runtimeSessionId)
      )
        return null;
      return {
        runKey: capability.groupRunKey,
        protocolVersion: 1,
        ...(capability.groupReactionProtocolVersion === 1
          ? { groupReactionProtocolVersion: 1 as const }
          : {}),
        provider: member.backendType === 'lead' ? 'lead' : 'native',
        // A provider switch must reject locally, never delegate under a commit/inbox lock.
        isCurrent: async () => {
          const current = await readRun(teamName, memberName, false);
          return (
            current !== null &&
            current.runKey === capability.groupRunKey &&
            current.groupReactionProtocolVersion ===
              (capability.groupReactionProtocolVersion === 1 ? 1 : undefined)
          );
        },
      };
    } catch {
      // Missing, stale, inaccessible, malformed, or stopped capabilities are unavailable.
      return null;
    }
  }
  return { getRun: (teamName, memberName) => readRun(teamName, memberName, true) };
}

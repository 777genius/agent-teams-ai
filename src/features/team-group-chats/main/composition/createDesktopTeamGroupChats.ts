import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamMemberResolver } from '@main/services/team/TeamMemberResolver';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { wrapAgentBlock } from '@shared/constants/agentBlocks';
import { protocols } from 'agent-teams-controller';

import { createGroupChatRuntimePorts } from '../infrastructure/groupChatRuntimePorts';

import { createTeamGroupChatsFeature } from './createTeamGroupChatsFeature';

import type { GroupChatRun, TeamGroupChatsPorts } from './createTeamGroupChatsFeature';
import type { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import type { TeamAgentRuntimeSnapshot } from '@shared/types';

/** Desktop composition owns roster reconciliation and the existing inbox transport. */
export function createDesktopTeamGroupChats(deps: {
  snapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
  openCodeRun(teamName: string, memberName: string): Promise<GroupChatRun | null>;
  leadName: NonNullable<TeamGroupChatsPorts['leadName']>;
  configurationOperation: TeamGroupChatsPorts['configurationOperation'];
  inboxWriter: Pick<TeamInboxWriter, 'sendMessage'>;
  changed: NonNullable<TeamGroupChatsPorts['changed']>;
  reactionChanged: NonNullable<TeamGroupChatsPorts['reactionChanged']>;
}) {
  const configReader = new TeamConfigReader();
  const membersMeta = new TeamMembersMetaStore();
  const memberResolver = new TeamMemberResolver();
  const runtime = createGroupChatRuntimePorts({
    getTeamAgentRuntimeSnapshot: deps.snapshot,
    getOpenCodeGroupChatRun: deps.openCodeRun,
  });
  return createTeamGroupChatsFeature({
    roster: async (teamName) => {
      const [config, metadata] = await Promise.all([
        configReader.getConfig(teamName),
        membersMeta.getMembers(teamName),
      ]);
      if (!config || config.deletedAt) throw new Error('Team not found');
      return [
        ...new Set(
          memberResolver
            .resolveMembers(config, metadata, [], [])
            .filter((member) => !member.removedAt && member.agentType !== 'subagent')
            .map((member) => member.name)
        ),
      ];
    },
    leadName: deps.leadName,
    getRun: runtime.getRun,
    configurationOperation: deps.configurationOperation,
    deliver: async (teamName, message, run, shouldStillWrite) => {
      const sent = await deps.inboxWriter.sendMessage(
        teamName,
        {
          ...message,
          // Keep the canonical group post unchanged; OpenCode adds its reminder at runtime.
          text:
            message.from === 'user' && run.provider !== 'opencode'
              ? `${wrapAgentBlock(protocols.buildChatVisualizationRefreshInstruction())}\n\n${message.text}`
              : message.text,
          attachments: undefined,
          member: message.to,
        },
        { shouldStillWrite }
      );
      return sent.deliveredToInbox
        ? run.provider === 'native'
          ? 'accepted'
          : 'queued'
        : 'skipped';
    },
    changed: deps.changed,
    reactionChanged: deps.reactionChanged,
  });
}

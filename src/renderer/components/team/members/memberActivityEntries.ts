import { buildInlineActivityEntries } from '@features/agent-graph/renderer';
import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';
import { isLeadMember } from '@shared/utils/leadDetection';

import type { InlineActivityEntry } from '@features/agent-graph/renderer';
import type { InboxMessage, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

export function buildMemberActivityEntries({
  teamName,
  memberName,
  members,
  tasks,
  messages,
}: {
  teamName: string;
  memberName: string;
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  messages: InboxMessage[];
}): InlineActivityEntry[] {
  const leadName = members.find((candidate) => isLeadMember(candidate))?.name ?? `${teamName}-lead`;
  const filteredMessages = filterTeamMessages(messages, {
    leadNames: [leadName],
    timeWindow: null,
    filter: { from: new Set(), to: new Set(), showNoise: true },
    searchQuery: '',
  });
  const leadId = `lead:${teamName}`;
  const ownerNodeId = memberName === leadName ? leadId : `member:${teamName}:${memberName}`;
  const ownerNodeIds = new Set([leadId, ownerNodeId]);
  const entriesByOwner = buildInlineActivityEntries({
    data: {
      members,
      tasks,
      messages: filteredMessages,
    },
    teamName,
    leadId,
    leadName,
    ownerNodeIds,
  });
  return entriesByOwner.get(ownerNodeId) ?? [];
}

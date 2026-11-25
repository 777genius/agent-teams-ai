import { wrapAgentBlock } from '@shared/constants/agentBlocks';

import { TeamMembersMetaStore } from '../../services/team/TeamMembersMetaStore';

import type { TeamDataService } from '../../services/team/TeamDataService';
import type { AgentActionMode, TeamProviderId } from '@shared/types';
import type { createLogger } from '@shared/utils/logger';

type VisibleDirectReplyProtocol = 'send_message' | 'agent_teams_message_send';
export function resolveVisibleDirectReplyProtocol(input: {
  providerId?: TeamProviderId;
  isLeadRecipient: boolean;
  replyRecipient: string;
}): VisibleDirectReplyProtocol {
  if (
    !input.isLeadRecipient &&
    input.replyRecipient.trim().toLowerCase() === 'user' &&
    input.providerId === 'codex'
  ) {
    return 'agent_teams_message_send';
  }

  return 'send_message';
}

export async function getDurableLeadTeammateRoster(
  teamName: string,
  leadName: string,
  getTeamDataService: () => Pick<TeamDataService, 'getTeamData'>,
  logger: ReturnType<typeof createLogger>
): Promise<{ name: string; role?: string }[]> {
  const normalize = (name: string | undefined | null): string => name?.trim().toLowerCase() ?? '';
  const leadLower = normalize(leadName);
  const reserved = new Set(['team-lead', 'user', leadLower].filter((value) => value.length > 0));

  try {
    const members = await new TeamMembersMetaStore().getMembers(teamName);
    const teammates = members
      .filter((member) => !member.removedAt)
      .filter((member) => {
        const lower = normalize(member.name);
        return lower.length > 0 && !reserved.has(lower);
      })
      .map((member) => ({
        name: member.name.trim(),
        role:
          typeof member.role === 'string' && member.role.trim().length > 0
            ? member.role.trim()
            : undefined,
      }));
    if (teammates.length > 0) return teammates;
  } catch (error) {
    logger.debug(
      `[teams:sendMessage] Failed to read members.meta roster for "${teamName}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    const data = await getTeamDataService().getTeamData(teamName);
    return data.members
      .filter((member) => !member.removedAt)
      .filter((member) => {
        const lower = normalize(member.name);
        return lower.length > 0 && !reserved.has(lower);
      })
      .map((member) => ({
        name: member.name.trim(),
        role:
          typeof member.role === 'string' && member.role.trim().length > 0
            ? member.role.trim()
            : undefined,
      }));
  } catch (error) {
    logger.debug(
      `[teams:sendMessage] Failed to read fallback team roster for "${teamName}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
}

export function buildLeadRosterContextBlock(
  teamName: string,
  leadName: string,
  teammates: { name: string; role?: string }[]
): string | null {
  if (teammates.length === 0) return null;

  const summary = teammates
    .map((member) => (member.role ? `${member.name} (${member.role})` : member.name))
    .join(', ');

  return [
    `Current durable team context:`,
    `- Team name: ${teamName}`,
    `- You are the live team lead "${leadName}"`,
    `- Persistent teammates currently configured: ${summary}`,
    `- This team is NOT in solo mode`,
    `- If the user asks who is on the team, answer from this durable roster unless newer durable state explicitly says otherwise.`,
  ].join('\n');
}

export function buildLeadDirectDelegateAckBlock(actionMode?: AgentActionMode): string | null {
  if (actionMode !== 'delegate') return null;

  return wrapAgentBlock(
    [
      'DELEGATE MODE USER ACK CONTRACT:',
      'Before any task creation, delegation, or other tool use, begin your next assistant response with one short human-readable acknowledgement to the user.',
      'That acknowledgement must be visible plain text, not only an agent-only block.',
      'Make the acknowledgement at least 40 characters so it is preserved in the Messages panel.',
      'After that visible acknowledgement, continue with delegation/orchestration in the same turn.',
    ].join('\n')
  );
}

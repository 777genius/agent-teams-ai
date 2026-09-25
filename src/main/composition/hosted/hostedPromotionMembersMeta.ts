import {
  HOSTED_TEAM_LEAD_NAME,
  parseHostedRosterConfiguration,
} from '@features/team-configuration/contracts';
import { parseTeamId } from '@shared/contracts/hosted';

import { hostedTaskBoardRosterMemberId } from './hostedTaskBoardRosterAuthority';

/**
 * The durable roster of a promoted hosted team, as desktop keeps it in
 * members.meta.json. Product task authority, the Owner and the agent-teams MCP
 * controller all read this file; the draft config.json stays byte-exact.
 *
 * Bytes must be deterministic so that a replayed promotion republishes the
 * exact same file. The member ID uses the Owner's formula over agentId (no
 * joinedAt), and is also written explicitly.
 */
export function buildHostedPromotionMembersMeta(input: {
  teamId: string;
  legacyKey: string;
  frozenDraftJson: string;
}): string {
  const teamId = parseTeamId(input.teamId);
  const draft: unknown = JSON.parse(input.frozenDraftJson);
  const configuration = parseHostedRosterConfiguration(
    draft && typeof draft === 'object' ? (draft as { configuration?: unknown }).configuration : null
  );
  const members = configuration.lanes.flatMap((lane) =>
    lane.members.map((member) => {
      const agentId = `${member.name}@${input.legacyKey}`;
      const model = member.model ?? (lane.kind === 'opencode' ? lane.selectedModel : undefined);
      const effort = member.effort ?? (lane.kind === 'opencode' ? lane.effort : undefined);
      return {
        name: member.name,
        memberId: hostedTaskBoardRosterMemberId(teamId, agentId),
        agentId,
        agentType: member.name === HOSTED_TEAM_LEAD_NAME ? 'team-lead' : 'general-purpose',
        providerId: lane.provider,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      };
    })
  );
  if (!members.some((member) => member.name === HOSTED_TEAM_LEAD_NAME)) {
    throw new TypeError('hosted-promotion-roster-lead-missing');
  }
  return `${JSON.stringify({ version: 1, members }, null, 2)}\n`;
}

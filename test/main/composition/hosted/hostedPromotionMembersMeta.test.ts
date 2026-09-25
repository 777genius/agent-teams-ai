import { createHash } from 'node:crypto';

import { buildHostedPromotionMembersMeta } from '@main/composition/hosted/hostedPromotionMembersMeta';
import { hostedTaskBoardRosterMemberId } from '@main/composition/hosted/hostedTaskBoardRosterAuthority';
import { parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

const teamId = `team_${'b'.repeat(32)}`;
const legacyKey = `draft-${'a'.repeat(32)}`;
const frozenDraftJson = JSON.stringify({
  configuration: {
    schemaVersion: 1,
    toolApprovalMode: 'auto',
    lanes: [
      {
        kind: 'opencode',
        provider: 'opencode',
        selectedModel: 'openrouter/minimax-m2.5',
        effort: 'medium',
        members: [
          { name: 'team-lead', prompt: 'Lead the team.' },
          { name: 'alice', prompt: 'Write code.', model: 'openrouter/glm-5' },
        ],
      },
      {
        kind: 'native',
        provider: 'codex',
        members: [{ name: 'bob', prompt: 'Review.', model: 'gpt-5.3-codex' }],
      },
    ],
  },
});

/** Owner HostedTaskMutationService / HostedTeamRecipientRoster formula, kept verbatim. */
function ownerMemberId(member: {
  memberId?: string;
  joinedAt?: number;
  agentId?: string;
  name: string;
}) {
  let immutableIdentity = member.name;
  if (typeof member.agentId === 'string') immutableIdentity = member.agentId;
  if (typeof member.joinedAt === 'number') immutableIdentity = `${member.name}\0${member.joinedAt}`;
  const derived = `member_${createHash('sha256')
    .update(
      JSON.stringify({
        domain: 'hosted-task-board-member/v1',
        teamId,
        rawMemberName: immutableIdentity,
      })
    )
    .digest('hex')
    .slice(0, 32)}`;
  return { explicit: member.memberId, derived };
}

describe('hosted promotion roster materialization', () => {
  it('writes every lane member, including the lead, with IDs every reader derives identically', () => {
    const bytes = buildHostedPromotionMembersMeta({ teamId, legacyKey, frozenDraftJson });
    // Deterministic bytes: a replayed promotion republishes the exact same file.
    expect(buildHostedPromotionMembersMeta({ teamId, legacyKey, frozenDraftJson })).toBe(bytes);
    const meta = JSON.parse(bytes) as {
      version: number;
      members: ({ name: string } & Record<string, string>)[];
    };
    expect(meta.version).toBe(1);
    expect(
      meta.members.map((member) => [
        member.name,
        member.agentType,
        member.providerId,
        member.model,
        member.effort,
      ])
    ).toEqual([
      ['team-lead', 'team-lead', 'opencode', 'openrouter/minimax-m2.5', 'medium'],
      ['alice', 'general-purpose', 'opencode', 'openrouter/glm-5', 'medium'],
      ['bob', 'general-purpose', 'codex', 'gpt-5.3-codex', undefined],
    ]);
    for (const member of meta.members) {
      expect(member.agentId).toBe(`${member.name}@${legacyKey}`);
      const owner = ownerMemberId(member);
      expect(owner.explicit).toBe(owner.derived);
      expect(hostedTaskBoardRosterMemberId(parseTeamId(teamId), member.agentId)).toBe(
        owner.derived
      );
    }
  });

  it('refuses a frozen roster without the fixed lead', () => {
    const withoutLead = JSON.parse(frozenDraftJson) as {
      configuration: { lanes: { members: { name: string }[] }[] };
    };
    withoutLead.configuration.lanes[0].members.shift();
    expect(() =>
      buildHostedPromotionMembersMeta({
        teamId,
        legacyKey,
        frozenDraftJson: JSON.stringify(withoutLead),
      })
    ).toThrow();
  });
});

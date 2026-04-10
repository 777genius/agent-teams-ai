import { describe, expect, it } from 'vitest';

import {
  createMemberDraftsFromInputs,
  filterEditableMemberInputs,
} from '@renderer/components/team/members/MembersEditorSection';
import type { ResolvedTeamMember } from '@shared/types';

describe('members editor editable input filtering', () => {
  it('filters the canonical team lead out of editable member inputs', () => {
    const members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
      },
      {
        name: 'alice',
        agentType: 'reviewer',
      },
      {
        name: 'bob',
        agentType: 'developer',
      },
    ] satisfies Array<Pick<ResolvedTeamMember, 'name' | 'agentType'>>;

    expect(filterEditableMemberInputs(members).map(member => member.name)).toEqual([
      'alice',
      'bob',
    ]);
  });

  it('keeps teammate runtime overrides intact after filtering out the lead', () => {
    const members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        providerId: 'codex',
        model: 'gpt-5.4',
      },
      {
        name: 'alice',
        agentType: 'reviewer',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    ] satisfies Array<
      Pick<
        ResolvedTeamMember,
        'name' | 'agentType' | 'providerId' | 'model' | 'effort'
      >
    >;

    const drafts = createMemberDraftsFromInputs(filterEditableMemberInputs(members));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      name: 'alice',
      providerId: 'codex',
      model: 'gpt-5.4-mini',
      effort: 'medium',
    });
  });
});

import { describe, expect, it } from 'vitest';

import {
  buildMemberDraftColorMap,
  buildMembersFromDrafts,
  createMemberDraft,
  createMemberDraftsFromInputs,
  filterEditableMemberInputs,
} from '@renderer/components/team/members/MembersEditorSection';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { getMemberColorByName } from '@shared/constants/memberColors';
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

  it('preserves explicit codex models when exporting member inputs', () => {
    const drafts = createMemberDraftsFromInputs(
      filterEditableMemberInputs([
        {
          name: 'alice',
          agentType: 'reviewer',
          providerId: 'codex',
          model: 'gpt-5.4-mini',
          effort: 'medium',
        },
      ] satisfies Array<
        Pick<ResolvedTeamMember, 'name' | 'agentType' | 'providerId' | 'model' | 'effort'>
      >)
    );

    expect(buildMembersFromDrafts(drafts)).toEqual([
      expect.objectContaining({
        name: 'alice',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      }),
    ]);
  });

  it('reuses existing member colors for matching draft names', () => {
    const existingMembers = [{ name: 'alice' }, { name: 'tom' }, { name: 'bob' }];
    const drafts = existingMembers.map((member) => createMemberDraft({ name: member.name }));

    const expectedColors = buildMemberColorMap(
      existingMembers.map((member) => ({
        ...member,
        color: getMemberColorByName(member.name),
      }))
    );
    const draftColors = buildMemberDraftColorMap(drafts, existingMembers);

    expect(draftColors.get('alice')).toBe(expectedColors.get('alice'));
    expect(draftColors.get('tom')).toBe(expectedColors.get('tom'));
    expect(draftColors.get('bob')).toBe(expectedColors.get('bob'));
  });

  it('assigns new draft members after reserving existing team colors', () => {
    const existingMembers = [{ name: 'alice' }, { name: 'tom' }];
    const drafts = [
      createMemberDraft({ name: 'alice' }),
      createMemberDraft({ name: 'tom' }),
      createMemberDraft({ name: 'bob' }),
    ];

    const expectedColors = buildMemberColorMap(
      [...existingMembers, { name: 'bob' }].map((member) => ({
        ...member,
        color: getMemberColorByName(member.name),
      }))
    );
    const draftColors = buildMemberDraftColorMap(drafts, existingMembers);

    expect(draftColors.get('alice')).toBe(expectedColors.get('alice'));
    expect(draftColors.get('tom')).toBe(expectedColors.get('tom'));
    expect(draftColors.get('bob')).toBe(expectedColors.get('bob'));
  });

  it('predicts the same colors as the team page for brand-new draft members', () => {
    const drafts = ['alice', 'tom', 'bob'].map((name) => createMemberDraft({ name }));

    const expectedColors = buildMemberColorMap(
      drafts.map((draft) => ({
        name: draft.name,
        color: getMemberColorByName(draft.name),
      }))
    );
    const draftColors = buildMemberDraftColorMap(drafts);

    expect(draftColors.get('alice')).toBe(expectedColors.get('alice'));
    expect(draftColors.get('tom')).toBe(expectedColors.get('tom'));
    expect(draftColors.get('bob')).toBe(expectedColors.get('bob'));
  });

  it('preserves explicit existing colors in edit and launch dialogs', () => {
    const existingMembers = [
      { name: 'alice', color: 'blue' },
      { name: 'bob', color: 'pink' },
    ];
    const drafts = existingMembers.map((member) => createMemberDraft({ name: member.name }));

    const draftColors = buildMemberDraftColorMap(drafts, existingMembers);

    expect(draftColors.get('alice')).toBe('blue');
    expect(draftColors.get('bob')).toBe('pink');
  });
});

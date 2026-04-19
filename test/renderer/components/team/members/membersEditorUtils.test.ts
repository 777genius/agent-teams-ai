import { describe, expect, it } from 'vitest';

import {
  buildMemberDraftColorMap,
  buildMembersFromDrafts,
  createMemberDraft,
  createMemberDraftsFromInputs,
  filterEditableMemberInputs,
} from '@renderer/components/team/members/MembersEditorSection';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';
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
      originalName: 'alice',
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

    const expectedColors = buildTeamMemberColorMap(existingMembers, {
      preferProvidedColors: false,
    });
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

    const expectedColors = buildTeamMemberColorMap([...existingMembers, { name: 'bob' }], {
      preferProvidedColors: false,
    });
    const draftColors = buildMemberDraftColorMap(drafts, existingMembers);

    expect(draftColors.get('alice')).toBe(expectedColors.get('alice'));
    expect(draftColors.get('tom')).toBe(expectedColors.get('tom'));
    expect(draftColors.get('bob')).toBe(expectedColors.get('bob'));
  });

  it('predicts the same colors as the team page for brand-new draft members', () => {
    const drafts = ['alice', 'tom', 'bob'].map((name) => createMemberDraft({ name }));

    const expectedColors = buildTeamMemberColorMap(
      drafts.map((draft) => ({
        name: draft.name,
      })),
      { preferProvidedColors: false }
    );
    const draftColors = buildMemberDraftColorMap(drafts);

    expect(draftColors.get('alice')).toBe(expectedColors.get('alice'));
    expect(draftColors.get('tom')).toBe(expectedColors.get('tom'));
    expect(draftColors.get('bob')).toBe(expectedColors.get('bob'));
  });

  it('preserves the resolved team colors in edit and launch dialogs', () => {
    const existingMembers = [
      { name: 'alice', color: getMemberColorByName('alice') },
      { name: 'bob', color: getMemberColorByName('bob') },
      { name: 'tom', color: getMemberColorByName('tom') },
    ];
    const drafts = existingMembers.map((member) => createMemberDraft({ name: member.name }));

    const draftColors = buildMemberDraftColorMap(drafts, existingMembers);

    expect(draftColors.get('alice')).toBe(existingMembers[0].color);
    expect(draftColors.get('bob')).toBe(existingMembers[1].color);
    expect(draftColors.get('tom')).toBe(existingMembers[2].color);
  });

  it('prefers an explicit resolved member color map from the team screen', () => {
    const existingMembers = [{ name: 'alice', color: 'brick' }, { name: 'tom', color: 'forest' }];
    const drafts = existingMembers.map((member) => createMemberDraft({ name: member.name }));
    const resolvedColorMap = new Map<string, string>([
      ['alice', 'blue'],
      ['tom', 'saffron'],
    ]);

    const draftColors = buildMemberDraftColorMap(drafts, existingMembers, resolvedColorMap);

    expect(draftColors.get('alice')).toBe('blue');
    expect(draftColors.get('tom')).toBe('saffron');
  });
});

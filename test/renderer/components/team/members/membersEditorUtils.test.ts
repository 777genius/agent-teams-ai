import {
  buildMemberDraftColorMap,
  buildMembersFromDrafts,
  createMemberDraft,
  createMemberDraftsFromInputs,
  filterEditableMemberInputs,
  normalizeLeadProviderForMode,
} from '@renderer/components/team/members/MembersEditorSection';
import { getTeammateParticipantIdentityColor } from '@shared/constants/memberColors';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';
import { describe, expect, it } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

describe('members editor editable input filtering', () => {
  it('keeps OpenCode available for the team lead only when multimodel is enabled', () => {
    expect(normalizeLeadProviderForMode('opencode', true)).toBe('opencode');
    expect(normalizeLeadProviderForMode('codex', true)).toBe('codex');
    expect(normalizeLeadProviderForMode('anthropic', true)).toBe('anthropic');
    expect(normalizeLeadProviderForMode('opencode', false)).toBe('anthropic');
  });

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
    ] satisfies Pick<ResolvedTeamMember, 'name' | 'agentType'>[];

    expect(filterEditableMemberInputs(members).map((member) => member.name)).toEqual([
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
    ] satisfies Pick<
      ResolvedTeamMember,
      'name' | 'agentType' | 'providerId' | 'model' | 'effort'
    >[];

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

  it('round-trips hidden teammate backend and fast mode metadata', () => {
    const drafts = createMemberDraftsFromInputs(
      filterEditableMemberInputs([
        {
          name: 'alice',
          agentType: 'reviewer',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          effort: 'medium',
          fastMode: 'on',
        },
      ] as any)
    );

    expect(drafts[0]).toMatchObject({
      providerBackendId: 'codex-native',
      fastMode: 'on',
    });
    expect(buildMembersFromDrafts(drafts)).toEqual([
      expect.objectContaining({
        name: 'alice',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4-mini',
        effort: 'medium',
        fastMode: 'on',
      }),
    ]);
  });

  it('drops hidden stale teammate backend when exporting against a new inherited provider', () => {
    const drafts = createMemberDraftsFromInputs(
      filterEditableMemberInputs([
        {
          name: 'alice',
          agentType: 'reviewer',
          providerBackendId: 'codex-native',
          model: 'haiku',
        },
      ] as any)
    );

    const exported = buildMembersFromDrafts(drafts, {
      inheritedProviderId: 'anthropic',
    });

    expect(exported).toEqual([
      expect.objectContaining({
        name: 'alice',
        model: 'haiku',
      }),
    ]);
    expect(exported[0]).not.toHaveProperty('providerId');
    expect(exported[0]).not.toHaveProperty('providerBackendId');
  });

  it('keeps hidden teammate backend when it matches the inherited provider', () => {
    const drafts = createMemberDraftsFromInputs(
      filterEditableMemberInputs([
        {
          name: 'alice',
          agentType: 'reviewer',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
        },
      ] as any)
    );

    const exported = buildMembersFromDrafts(drafts, {
      inheritedProviderId: 'codex',
    });

    expect(exported).toEqual([
      expect.objectContaining({
        name: 'alice',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4-mini',
      }),
    ]);
    expect(exported[0]).not.toHaveProperty('providerId');
  });

  it('does not synthesize hidden teammate backend from inherited provider defaults', () => {
    const drafts = createMemberDraftsFromInputs(
      filterEditableMemberInputs([
        {
          name: 'alice',
          agentType: 'reviewer',
          model: 'gpt-5.4-mini',
        },
      ] as any)
    );

    const exported = buildMembersFromDrafts(drafts, {
      inheritedProviderId: 'codex',
    });

    expect(exported).toEqual([
      expect.objectContaining({
        name: 'alice',
        model: 'gpt-5.4-mini',
      }),
    ]);
    expect(exported[0]).not.toHaveProperty('providerId');
    expect(exported[0]).not.toHaveProperty('providerBackendId');
  });

  it('drops inherited teammate model when its inferred provider conflicts', () => {
    const drafts = createMemberDraftsFromInputs(
      filterEditableMemberInputs([
        {
          name: 'alice',
          agentType: 'reviewer',
          model: 'gpt-5.4-mini',
          effort: 'max',
        },
      ] as any)
    );

    const exported = buildMembersFromDrafts(drafts, {
      inheritedProviderId: 'anthropic',
    });

    expect(exported).toEqual([
      expect.objectContaining({
        name: 'alice',
        effort: 'max',
      }),
    ]);
    expect(exported[0]).not.toHaveProperty('model');
  });

  it('drops inherited teammate effort when selected provider does not support it', () => {
    const drafts = createMemberDraftsFromInputs(
      filterEditableMemberInputs([
        {
          name: 'alice',
          agentType: 'reviewer',
          model: 'gpt-5.4-mini',
          effort: 'none',
        },
      ] as any)
    );

    const exported = buildMembersFromDrafts(drafts, {
      inheritedProviderId: 'codex',
    });

    expect(exported).toEqual([
      expect.objectContaining({
        name: 'alice',
        model: 'gpt-5.4-mini',
      }),
    ]);
    expect(exported[0]).not.toHaveProperty('effort');
  });

  it.each(['max', 'ultra'] as const)(
    'preserves Codex %s effort while exporting teammate overrides',
    (effort) => {
      const drafts = createMemberDraftsFromInputs(
        filterEditableMemberInputs([
          {
            name: 'alice',
            agentType: 'reviewer',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.6-sol',
            effort,
          },
        ] as any)
      );

      expect(buildMembersFromDrafts(drafts)).toEqual([
        expect.objectContaining({
          name: 'alice',
          providerId: 'codex',
          model: 'gpt-5.6-sol',
          effort,
        }),
      ]);
    }
  );

  it('preserves legacy no-context effort export for callers without inherited provider', () => {
    const drafts = createMemberDraftsFromInputs(
      filterEditableMemberInputs([
        {
          name: 'alice',
          agentType: 'reviewer',
          effort: 'max',
        },
      ] as any)
    );

    expect(buildMembersFromDrafts(drafts)).toEqual([
      expect.objectContaining({
        name: 'alice',
        effort: 'max',
      }),
    ]);
  });

  it('uses explicit teammate provider before inherited provider while sanitizing export', () => {
    const drafts = createMemberDraftsFromInputs(
      filterEditableMemberInputs([
        {
          name: 'alice',
          agentType: 'reviewer',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          effort: 'none',
        },
      ] as any)
    );

    const exported = buildMembersFromDrafts(drafts, {
      inheritedProviderId: 'anthropic',
    });

    expect(exported).toEqual([
      expect.objectContaining({
        name: 'alice',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4-mini',
      }),
    ]);
    expect(exported[0]).not.toHaveProperty('effort');
  });

  it('keeps OpenCode custom teammate models that are not inferred as another provider', () => {
    const drafts = createMemberDraftsFromInputs(
      filterEditableMemberInputs([
        {
          name: 'alice',
          agentType: 'reviewer',
          providerId: 'opencode',
          providerBackendId: 'opencode-cli',
          model: 'qwen3-coder',
          effort: 'medium',
        },
      ] as any)
    );

    const exported = buildMembersFromDrafts(drafts, {
      inheritedProviderId: 'anthropic',
    });

    expect(exported).toEqual([
      expect.objectContaining({
        name: 'alice',
        providerId: 'opencode',
        providerBackendId: 'opencode-cli',
        model: 'qwen3-coder',
        effort: 'medium',
      }),
    ]);
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
      ] satisfies Pick<
        ResolvedTeamMember,
        'name' | 'agentType' | 'providerId' | 'model' | 'effort'
      >[])
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

  it('preserves worktree isolation when importing and exporting member drafts', () => {
    const drafts = createMemberDraftsFromInputs(
      filterEditableMemberInputs([
        {
          name: 'alice',
          agentType: 'developer',
          isolation: 'worktree',
        },
        {
          name: 'bob',
          agentType: 'reviewer',
        },
      ] satisfies Pick<ResolvedTeamMember, 'name' | 'agentType' | 'isolation'>[])
    );

    const exported = buildMembersFromDrafts(drafts);

    expect(drafts[0]).toMatchObject({ name: 'alice', isolation: 'worktree' });
    expect(exported[0]).toMatchObject({ name: 'alice', isolation: 'worktree' });
    expect(exported[1]).toMatchObject({ name: 'bob' });
    expect(exported[1]).not.toHaveProperty('isolation');
  });

  it('reuses existing member colors for matching draft names', () => {
    const existingMembers = [{ name: 'alice' }, { name: 'tom' }, { name: 'bob' }];
    const drafts = existingMembers.map((member) => createMemberDraft({ name: member.name }));

    const expectedColors = buildTeamMemberColorMap(existingMembers, {
      preferProvidedColors: false,
    });
    const draftColors = buildMemberDraftColorMap(drafts, existingMembers);

    expect(draftColors.get(drafts[0].id)).toBe(expectedColors.get('alice'));
    expect(draftColors.get(drafts[1].id)).toBe(expectedColors.get('tom'));
    expect(draftColors.get(drafts[2].id)).toBe(expectedColors.get('bob'));
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

    expect(draftColors.get(drafts[0].id)).toBe(expectedColors.get('alice'));
    expect(draftColors.get(drafts[1].id)).toBe(expectedColors.get('tom'));
    expect(draftColors.get(drafts[2].id)).toBe(expectedColors.get('bob'));
  });

  it('predicts the same colors as the team page for brand-new draft members', () => {
    const drafts = ['alice', 'tom', 'bob'].map((name) => createMemberDraft({ name }));

    const expectedColors = buildTeamMemberColorMap(
      drafts.map((draft) => ({
        name: `draft:${draft.id}`,
      })),
      { preferProvidedColors: false }
    );
    const draftColors = buildMemberDraftColorMap(drafts);

    expect(draftColors.get(drafts[0].id)).toBe(expectedColors.get(`draft:${drafts[0].id}`));
    expect(draftColors.get(drafts[1].id)).toBe(expectedColors.get(`draft:${drafts[1].id}`));
    expect(draftColors.get(drafts[2].id)).toBe(expectedColors.get(`draft:${drafts[2].id}`));
  });

  it('replaces stale stored colors with avatar-aligned colors in edit and launch dialogs', () => {
    const existingMembers = [
      { name: 'alice', color: 'pink' },
      { name: 'bob', color: 'pink' },
      { name: 'tom', color: 'pink' },
    ];
    const drafts = existingMembers.map((member) => createMemberDraft({ name: member.name }));

    const draftColors = buildMemberDraftColorMap(drafts, existingMembers);

    expect(draftColors.get(drafts[0].id)).toBe(getTeammateParticipantIdentityColor(0));
    expect(draftColors.get(drafts[1].id)).toBe(getTeammateParticipantIdentityColor(1));
    expect(draftColors.get(drafts[2].id)).toBe(getTeammateParticipantIdentityColor(2));
  });

  it('keeps avatar identity canonical over an outdated resolved color map', () => {
    const existingMembers = [
      { name: 'alice', color: 'brick' },
      { name: 'tom', color: 'forest' },
    ];
    const drafts = existingMembers.map((member) => createMemberDraft({ name: member.name }));
    const resolvedColorMap = new Map<string, string>([
      ['alice', 'blue'],
      ['tom', 'saffron'],
    ]);

    const draftColors = buildMemberDraftColorMap(drafts, existingMembers, resolvedColorMap);

    expect(draftColors.get(drafts[0].id)).toBe(getTeammateParticipantIdentityColor(0));
    expect(draftColors.get(drafts[1].id)).toBe(getTeammateParticipantIdentityColor(1));
  });

  it('keeps an existing teammate color stable while the name is being edited', () => {
    const existingMembers = [
      { name: 'alice', color: 'blue' },
      { name: 'tom', color: 'saffron' },
    ];
    const renamedAliceDraft = createMemberDraft({
      id: 'draft-alice',
      name: 'alice-renamed',
      originalName: 'alice',
    });
    const tomDraft = createMemberDraft({
      id: 'draft-tom',
      name: 'tom',
      originalName: 'tom',
    });

    const draftColors = buildMemberDraftColorMap([renamedAliceDraft, tomDraft], existingMembers);

    expect(draftColors.get(renamedAliceDraft.id)).toBe('blue');
    expect(draftColors.get(tomDraft.id)).toBe('saffron');
  });

  it('keeps a brand-new draft color stable while its name is edited', () => {
    const draft = createMemberDraft({ id: 'draft-new', name: 'alice' });
    const beforeRename = buildMemberDraftColorMap([draft]);
    const afterRename = buildMemberDraftColorMap([{ ...draft, name: 'charlie' }]);

    expect(afterRename.get(draft.id)).toBe(beforeRename.get(draft.id));
  });

  it('matches the active-then-removed avatar order used by the roster editor', () => {
    const activeAlice = createMemberDraft({ id: 'alice', name: 'alice' });
    const removedBob = createMemberDraft({ id: 'bob', name: 'bob', removedAt: 1 });
    const activeTom = createMemberDraft({ id: 'tom', name: 'tom' });

    const draftColors = buildMemberDraftColorMap([activeAlice, removedBob, activeTom]);

    expect(draftColors.get(activeAlice.id)).toBe(getTeammateParticipantIdentityColor(0));
    expect(draftColors.get(activeTom.id)).toBe(getTeammateParticipantIdentityColor(1));
    expect(draftColors.get(removedBob.id)).toBe(getTeammateParticipantIdentityColor(2));
  });
});

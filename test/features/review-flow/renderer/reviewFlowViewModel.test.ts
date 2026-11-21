import { describe, expect, it } from 'vitest';

import {
  buildOverrideRows,
  buildScopeOptions,
  buildUnreadableRows,
  countFollowingDefault,
  createInitialDraft,
  DEFAULT_SCOPE_VALUE,
  draftToPayload,
  isEditorDraftDirty,
  resolveScopePolicy,
  reviewFlowBoardsOf,
  scopeFromValue,
  scopeToValue,
} from '../../../../src/features/review-flow/renderer/view-model/reviewFlowViewModel';

import type { ReviewFlowSettings } from '../../../../src/features/review-flow/contracts/types';

const agent: ReviewFlowSettings = { reviewFlow: 'agent_approval', reviewFlowPrompt: '' };
const human: ReviewFlowSettings = { reviewFlow: 'human_approval', reviewFlowPrompt: 'Run e2e.' };

const teams = [
  { teamName: 'zeta-team', displayName: 'Zeta' },
  { teamName: 'alpha-team', displayName: 'Alpha' },
  { teamName: 'plain' },
];

describe('review flow scope list', () => {
  it('puts "all teams" first, sorts teams by label and marks overridden ones', () => {
    const options = buildScopeOptions(teams, { 'zeta-team': human }, [], 'All teams');
    expect(options.map((option) => option.value)).toEqual([
      DEFAULT_SCOPE_VALUE,
      'alpha-team',
      'plain',
      'zeta-team',
    ]);
    expect(options.find((option) => option.value === 'zeta-team')?.badge).toBe('custom');
    expect(options.find((option) => option.value === 'plain')?.badge).toBeNull();
    expect(options.find((option) => option.value === 'alpha-team')?.description).toBe('alpha-team');
    expect(options.find((option) => option.value === 'plain')?.description).toBeUndefined();
  });

  it('keeps an overridden team reachable even when the team list does not know it yet', () => {
    const options = buildScopeOptions([], { ghost: human }, [], 'All teams');
    expect(options.map((option) => option.value)).toEqual([DEFAULT_SCOPE_VALUE, 'ghost']);
    expect(buildOverrideRows([], { ghost: human })).toEqual([
      { teamName: 'ghost', displayName: 'ghost', settings: human },
    ]);
  });

  it('marks teams with unreadable settings for repair, even ones the list does not know', () => {
    const options = buildScopeOptions(teams, { 'zeta-team': human }, ['zeta-team', 'ghost'], 'All');
    expect(options.find((option) => option.value === 'zeta-team')?.badge).toBe('repair');
    expect(options.find((option) => option.value === 'ghost')?.badge).toBe('repair');
    expect(buildUnreadableRows(teams, ['zeta-team', 'ghost'])).toEqual([
      { teamName: 'ghost', displayName: 'ghost' },
      { teamName: 'zeta-team', displayName: 'Zeta' },
    ]);
  });

  it('counts only known teams that follow the default', () => {
    expect(countFollowingDefault(teams, { 'zeta-team': human, ghost: human })).toBe(2);
  });

  it('round-trips scope values', () => {
    expect(scopeFromValue(scopeToValue({ kind: 'default' }))).toEqual({ kind: 'default' });
    expect(scopeFromValue(scopeToValue({ kind: 'team', teamName: 'alpha-team' }))).toEqual({
      kind: 'team',
      teamName: 'alpha-team',
    });
  });
});

/**
 * The review flow is a setting of a board. A per-project team has one board per
 * project (its copy) and none of its own, so the settings page offers exactly
 * the boards that exist: the copies, named after the team and the project. Its
 * logical name is never offered (the main process refuses it), and the copies
 * never show up under their internal names.
 */
describe('review flow boards of per-project teams', () => {
  const folded = [
    { teamName: 'legacy', displayName: 'Legacy', projectContextMode: 'shared' as const },
    {
      teamName: 'builders',
      displayName: 'Builders',
      projectContextMode: 'per_project' as const,
      projectHistoryContexts: [
        { executionTeamName: 'ptc-aaa', projectPath: '/work/app-one' },
        { executionTeamName: 'ptc-bbb', projectPath: '/work/app-two' },
      ],
    },
    { teamName: 'fresh', displayName: 'Fresh', projectContextMode: 'per_project' as const },
  ];

  it('names the copies an ordinary team retained, after the team and the project', () => {
    const retained = [
      {
        teamName: 'old',
        displayName: 'Old',
        projectContextMode: 'shared' as const,
        projectHistoryContexts: [{ executionTeamName: 'ptc-old', projectPath: '/work/site' }],
      },
    ];
    expect(reviewFlowBoardsOf(retained)).toEqual([
      { teamName: 'old', displayName: 'Old' },
      { teamName: 'ptc-old', displayName: 'Old · site' },
    ]);
  });

  it('lists an ordinary team as is and a per-project team once per project', () => {
    expect(reviewFlowBoardsOf(folded)).toEqual([
      { teamName: 'legacy', displayName: 'Legacy' },
      { teamName: 'ptc-aaa', displayName: 'Builders · app-one' },
      { teamName: 'ptc-bbb', displayName: 'Builders · app-two' },
    ]);
  });

  it('labels an override of one project with the team and project, and keeps the others on the default', () => {
    const boards = reviewFlowBoardsOf(folded);
    expect(buildOverrideRows(boards, { 'ptc-aaa': human })).toEqual([
      { teamName: 'ptc-aaa', displayName: 'Builders · app-one', settings: human },
    ]);
    const options = buildScopeOptions(boards, { 'ptc-aaa': human }, [], 'All teams');
    expect(options.map((option) => option.value)).not.toContain('builders');
    expect(options.find((option) => option.value === 'ptc-bbb')?.badge).toBeNull();
    expect(countFollowingDefault(boards, { 'ptc-aaa': human })).toBe(2);
  });
});

describe('review flow editor draft', () => {
  it('a team that follows the default starts from the default values', () => {
    const policy = resolveScopePolicy({ kind: 'team', teamName: 'plain' }, human, {});
    expect(policy.source).toBe('default');
    expect(createInitialDraft(policy)).toEqual({ inherit: true, settings: human });
  });

  it('is clean when untouched and dirty after leaving or rejoining the default', () => {
    const scope = { kind: 'team', teamName: 'plain' } as const;
    const inheriting = resolveScopePolicy(scope, agent, {});
    const draft = createInitialDraft(inheriting);
    expect(isEditorDraftDirty(scope, draft, inheriting)).toBe(false);
    expect(isEditorDraftDirty(scope, { ...draft, inherit: false }, inheriting)).toBe(true);

    const custom = resolveScopePolicy(scope, agent, { plain: human });
    const customDraft = createInitialDraft(custom);
    expect(isEditorDraftDirty(scope, customDraft, custom)).toBe(false);
    expect(isEditorDraftDirty(scope, { ...customDraft, inherit: true }, custom)).toBe(true);
  });

  it('ignores edits made while inheriting and treats whitespace-only prompt changes as clean', () => {
    const scope = { kind: 'team', teamName: 'plain' } as const;
    const policy = resolveScopePolicy(scope, agent, {});
    const draft = { inherit: true, settings: human };
    expect(isEditorDraftDirty(scope, draft, policy)).toBe(false);

    const defaultPolicy = resolveScopePolicy({ kind: 'default' }, human, {});
    const padded = { inherit: false, settings: { ...human, reviewFlowPrompt: '  Run e2e.  ' } };
    expect(isEditorDraftDirty({ kind: 'default' }, padded, defaultPolicy)).toBe(false);
  });

  it('saves null only when a team goes back to following the default', () => {
    const draft = { inherit: true, settings: human };
    expect(draftToPayload({ kind: 'team', teamName: 'plain' }, draft)).toBeNull();
    expect(draftToPayload({ kind: 'team', teamName: 'plain' }, { ...draft, inherit: false })).toBe(
      human
    );
    expect(draftToPayload({ kind: 'default' }, draft)).toBe(human);
  });
});

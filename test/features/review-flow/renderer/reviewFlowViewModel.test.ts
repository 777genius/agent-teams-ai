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
import {
  foldProjectTeamBoards,
  projectCopyNames,
  reviewFlowTeamOf,
} from '../../../../src/features/review-flow/renderer/view-model/projectTeamReviewFlow';

import {
  projectCopyLabel,
  type ProjectCopyCatalogTeam,
} from '../../../../src/features/team-project-context/core';

import type { ReviewFlowSettings } from '../../../../src/features/review-flow/contracts/types';

/** The app's own copy label over the folded list, as the hook passes it in. */
const labelIn =
  (teams: readonly ProjectCopyCatalogTeam[]) =>
  (name: string): string | null =>
    projectCopyLabel(teams, name);
/** The folder label of a project, as the hook passes it in. */
const folderOf = (_team: string, copy: string): string | null =>
  ({ 'ptc-aaa': 'app-one', 'ptc-bbb': 'app-two' })[copy] ?? null;

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
 * A per-project team has one review flow for the team: the settings page offers
 * the team once, never its project copies, and the boards of the copies are
 * folded into it. Before the team's first save it shows what its projects share;
 * when they disagree (or a save did not reach one) it names those projects.
 */
describe('review flow of per-project teams', () => {
  // The team list as the app folds it: only ready copies are folded; a copy whose first launch never
  // finished ('ptc-ccc') is still a row of its own there.
  const teamList = [
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
    { teamName: 'ptc-ccc', displayName: 'Builders', projectContextMode: 'shared' as const },
    { teamName: 'fresh', displayName: 'Fresh', projectContextMode: 'per_project' as const },
  ];
  // What the main process reports: every copy it proved, the pending one included.
  const projects = [
    { executionTeamName: 'ptc-aaa', projectPath: '/work/app-one' },
    { executionTeamName: 'ptc-bbb', projectPath: '/work/app-two' },
  ];
  const team = (saved: ReviewFlowSettings | null | undefined, list = projects) => ({
    saved: saved !== undefined,
    settings: saved ?? null,
    projects: list,
  });
  const overview = (
    overrides: Record<string, ReviewFlowSettings>,
    builders: ReturnType<typeof team> = team(undefined),
    unreadableTeams: string[] = []
  ) => ({ overrides, unreadableTeams, projectTeams: { builders, fresh: team(undefined, []) } });

  it('names the copies an ordinary team retained, after the team and the project', () => {
    const retained = [
      {
        teamName: 'old',
        displayName: 'Old',
        projectContextMode: 'shared' as const,
        projectHistoryContexts: [{ executionTeamName: 'ptc-old', projectPath: '/work/site' }],
      },
    ];
    expect(reviewFlowBoardsOf(retained, labelIn(retained), new Set())).toEqual([
      { teamName: 'old', displayName: 'Old' },
      { teamName: 'ptc-old', displayName: 'Old · site' },
    ]);
    // A copy that an ordinary team kept is a board of its own and is not folded.
    const view = foldProjectTeamBoards(
      { overrides: { 'ptc-old': human }, unreadableTeams: ['old'], projectTeams: {} },
      folderOf
    );
    expect(view).toEqual({
      overrides: { 'ptc-old': human },
      unreadableTeams: ['old'],
      projectTeams: {},
    });
    expect(reviewFlowTeamOf({}, 'ptc-old')).toBe('ptc-old');
  });

  it('lists an ordinary team and a per-project team once each, never a project copy', () => {
    const pending = {
      builders: team(undefined, [
        ...projects,
        { executionTeamName: 'ptc-ccc', projectPath: '/work/c' },
      ]),
    };
    expect(reviewFlowBoardsOf(teamList, labelIn(teamList), projectCopyNames(pending))).toEqual([
      { teamName: 'legacy', displayName: 'Legacy' },
      { teamName: 'builders', displayName: 'Builders' },
      { teamName: 'fresh', displayName: 'Fresh' },
    ]);
    expect(reviewFlowTeamOf(pending, 'ptc-ccc')).toBe('builders');
    expect(reviewFlowTeamOf(pending, 'legacy')).toBe('legacy');
  });

  it('shows the saved team setting and folds the boards of its copies away', () => {
    const view = foldProjectTeamBoards(
      overview({ 'ptc-aaa': human, 'ptc-bbb': human, legacy: agent }, team(human)),
      folderOf
    );
    expect(view.overrides).toEqual({ legacy: agent, builders: human });
    expect(view.projectTeams.builders).toEqual({ saved: true, unsynced: [], saveSuggested: false });
    const boards = reviewFlowBoardsOf(
      teamList,
      labelIn(teamList),
      projectCopyNames({ builders: team(human) })
    );
    expect(buildOverrideRows(boards, view.overrides).map((row) => row.displayName)).toEqual([
      'Builders',
      'Legacy',
    ]);
    // ptc-ccc is a row of the team list here because the main process did not report it.
    expect(countFollowingDefault(boards, view.overrides)).toBe(2);
  });

  it('names the projects a saved team setting has not reached', () => {
    const view = foldProjectTeamBoards(
      overview({ 'ptc-aaa': human }, team(human), ['ptc-bbb']),
      folderOf
    );
    expect(view.overrides).toEqual({ builders: human });
    expect(view.unreadableTeams).toEqual([]);
    expect(view.projectTeams.builders).toEqual({
      saved: true,
      unsynced: [{ projectLabel: 'app-two', setting: 'unreadable' }],
      saveSuggested: false,
    });
    // A team that follows the default: a board that still carries an override is behind.
    const cleared = foldProjectTeamBoards(overview({ 'ptc-aaa': human }, team(null)), folderOf);
    expect(cleared.overrides).toEqual({});
    expect(cleared.projectTeams.builders.unsynced).toEqual([
      { projectLabel: 'app-one', setting: human },
    ]);
  });

  it('never shows a team whose setting or projects cannot be read as following the default', () => {
    const broken = foldProjectTeamBoards(
      {
        ...overview({ 'ptc-aaa': human }),
        projectTeams: { builders: { ...team(null), unreadable: true } },
      },
      folderOf
    );
    // Its saved setting is unreadable: it is offered for repair, its copies are still folded.
    expect(broken.unreadableTeams).toEqual(['builders']);
    expect(broken.overrides).toEqual({});
    const listing = foldProjectTeamBoards(
      {
        ...overview({ 'ptc-aaa': human }),
        projectTeams: { builders: { ...team(human, []), projectsError: 'Corrupt index' } },
      },
      folderOf
    );
    expect(listing.projectTeams.builders).toEqual({
      saved: true,
      unsynced: [],
      saveSuggested: false,
      projectsError: 'Corrupt index',
    });
    expect(listing.overrides).not.toHaveProperty('builders');
  });

  it('before the first save, shows what the projects share, or that they differ', () => {
    const shared = foldProjectTeamBoards(
      overview({ 'ptc-aaa': human, 'ptc-bbb': human }),
      folderOf
    );
    expect(shared.overrides).toEqual({ builders: human });
    // Shown as the team's, but not saved for it yet: a new project would start on the default.
    expect(shared.projectTeams.builders).toEqual({
      saved: false,
      unsynced: [],
      saveSuggested: true,
    });

    const differ = foldProjectTeamBoards(overview({ 'ptc-aaa': human }), folderOf);
    // No single setting: the team is not shown as custom, and every project is named.
    expect(differ.overrides).toEqual({});
    expect(differ.projectTeams.builders).toEqual({
      saved: false,
      unsynced: [
        { projectLabel: 'app-one', setting: human },
        { projectLabel: 'app-two', setting: null },
      ],
      saveSuggested: false,
    });
    // A team that has not run in any project yet follows the default.
    expect(differ.projectTeams.fresh).toEqual({ saved: false, unsynced: [], saveSuggested: false });
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

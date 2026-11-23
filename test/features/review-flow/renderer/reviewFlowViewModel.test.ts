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

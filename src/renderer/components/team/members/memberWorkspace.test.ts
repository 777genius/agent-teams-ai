import { describe, expect, it } from 'vitest';

import { createMemberDraft } from './membersEditorUtils';
import {
  filterWorktreePathsForRuntime,
  getDraftWorktreePath,
  resolveBranchDeviation,
  resolveDraftWorkspace,
} from './memberWorkspace';

const project = '/fixtures/issue509/project';
const isolated = '/fixtures/issue509/worktrees/alice';
const paths = { alice: isolated };
const branches = { [project]: 'main', [isolated]: 'feature/current-work' };
const member = createMemberDraft({ name: 'alice', originalName: 'alice', isolation: 'worktree' });

describe('member workspace preview', () => {
  it('shows only a known branch deviation from the common project branch', () => {
    expect(resolveBranchDeviation('main', 'main', true)).toBeUndefined();
    expect(resolveBranchDeviation('feature/current-work', 'main', false)).toBe(
      'feature/current-work'
    );
    expect(resolveBranchDeviation('feature/current-work', null, true)).toBe('feature/current-work');
    expect(resolveBranchDeviation('main', null, false)).toBeUndefined();
    expect(resolveBranchDeviation(null, 'main', true)).toBeUndefined();
  });
  it('shows the existing worktree actual branch without inferring a managed branch name', () => {
    expect(resolveDraftWorkspace(member, project, paths, branches)).toEqual({
      kind: 'existing',
      path: isolated,
      branch: 'feature/current-work',
    });
  });

  it('uses the shared project branch immediately when isolation is disabled', () => {
    const shared = { ...member, isolation: undefined };
    expect(getDraftWorktreePath(shared, paths)).toBeUndefined();
    expect(resolveDraftWorkspace(shared, project, paths, branches)).toEqual({
      kind: 'shared',
      path: project,
      branch: 'main',
    });
    expect(resolveDraftWorkspace(member, project, paths, branches)?.path).toBe(isolated);
  });

  it('does not claim an existing branch for a new member or a renamed identity', () => {
    for (const draft of [
      { ...member, originalName: undefined },
      { ...member, name: 'bob' },
      { ...member, originalName: 'bob' },
    ]) {
      expect(resolveDraftWorkspace(draft, project, paths, branches)).toEqual({
        kind: 'new',
        path: '',
        branch: null,
      });
    }
  });

  it('omits removed members and does not infer a branch for an unresolved worktree', () => {
    expect(resolveDraftWorkspace({ ...member, removedAt: 1 }, project, paths, branches)).toBeNull();
    expect(resolveDraftWorkspace(member, project, paths, {})?.branch).toBeNull();
    expect(resolveDraftWorkspace(member, project, paths, { [isolated]: 'HEAD' })?.branch).toBe(
      'HEAD'
    );
  });

  it('retains equal branches and resolves each row independently in a mixed roster', () => {
    expect(resolveDraftWorkspace(member, project, paths, { [isolated]: 'main' })?.branch).toBe(
      'main'
    );
    expect(
      resolveDraftWorkspace(
        { ...member, name: 'bob', isolation: undefined },
        project,
        paths,
        branches
      )?.branch
    ).toBe('main');
    expect(resolveDraftWorkspace(member, project, paths, branches)?.branch).toBe(
      'feature/current-work'
    );
  });
  it('does not forecast the project branch when a lead worktree is selected', () => {
    expect(
      resolveDraftWorkspace({ ...member, isolation: undefined }, project, paths, branches, true)
    ).toEqual({
      kind: 'sharedPending',
      path: '',
      branch: null,
    });
    expect(resolveDraftWorkspace(member, project, paths, branches, true)?.branch).toBe(
      'feature/current-work'
    );
  });

  it('hides prior workspace history after a known provider or backend change', () => {
    expect(
      filterWorktreePathsForRuntime([{ ...member, providerId: 'codex' }], paths, [
        { name: 'alice', providerId: 'opencode' },
      ])
    ).toEqual({});
    expect(
      filterWorktreePathsForRuntime(
        [member],
        paths,
        [{ name: 'alice', providerId: 'opencode' }],
        'codex'
      )
    ).toEqual({});
    expect(
      filterWorktreePathsForRuntime([{ ...member, providerId: 'opencode' }], paths, [
        { name: 'alice', providerId: 'opencode' },
      ])
    ).toEqual(paths);
    expect(filterWorktreePathsForRuntime([member], paths, [])).toEqual(paths);
    expect(
      filterWorktreePathsForRuntime([{ ...member, providerBackendId: 'cli-sdk' }], paths, [
        { name: 'alice', providerBackendId: 'adapter' },
      ])
    ).toEqual({});
  });
  it('does not mistake inherited object keys for recorded member paths', () => {
    const constructor = { ...member, name: 'constructor', originalName: 'constructor' };
    expect(getDraftWorktreePath(constructor, {})).toBeUndefined();
    const filtered = filterWorktreePathsForRuntime([constructor], {}, []);
    expect(filtered).toEqual({});
    expect(getDraftWorktreePath(constructor, filtered)).toBeUndefined();
    expect(resolveDraftWorkspace(constructor, project, filtered, branches)).toEqual({
      kind: 'new',
      path: '',
      branch: null,
    });
    expect(getDraftWorktreePath(constructor, { constructor: isolated })).toBe(isolated);
  });
});

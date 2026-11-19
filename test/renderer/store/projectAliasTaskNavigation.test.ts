import { describe, expect, it, vi } from 'vitest';

import { redirectProjectAliasTaskNavigation } from '../../../src/renderer/store/team/projectAliasTaskNavigation';

import type { AppState } from '../../../src/renderer/store/types';

function fixture() {
  const alias = { id: 'alias-tab', type: 'team' as const, teamName: 'ptc-a', label: 'Alias' };
  const logical = { id: 'logical-tab', type: 'team' as const, teamName: 'builders', label: 'Builders' };
  const review = {
    contextId: 'context-one',
    teamName: 'ptc-a',
    nonce: 'review-one',
    taskId: 'task-one',
    targetTeamTabId: 'alias-tab',
    status: 'pending' as const,
  };
  const editor = {
    contextId: 'context-one',
    teamName: 'ptc-a',
    nonce: 'editor-one',
    projectPath: '/projects/a',
    filePath: '/projects/a/test.ts',
    line: 15,
    targetTeamTabId: 'alias-tab',
    status: 'pending' as const,
  };
  const state = {
    activeContextId: 'context-one',
    activeTabId: 'alias-tab',
    isContextSwitching: false,
    pendingReviewRequest: review,
    pendingTaskDetailEditorRequest: editor,
    getAllPaneTabs: () => [alias, logical],
    openTeamTab: vi.fn((name: string, path: string) => {
      expect(name).toBe('builders');
      expect(path).toBe('/projects/a');
      state.activeTabId = 'logical-tab';
    }),
    setPendingReviewRequest: vi.fn((value: unknown) => { state.pendingReviewRequest = value as typeof review; }),
    setPendingTaskDetailEditorRequest: vi.fn((value: unknown) => { state.pendingTaskDetailEditorRequest = value as typeof editor; }),
  };
  return { state, get: () => state as unknown as AppState, review, editor };
}

describe('redirectProjectAliasTaskNavigation', () => {
  it('preserves physical task and editor identities while retargeting only their visible tab', () => {
    const f = fixture();
    redirectProjectAliasTaskNavigation(f.get, 'ptc-a', 'builders', '/projects/a');
    expect(f.state.openTeamTab).toHaveBeenCalledOnce();
    expect(f.state.pendingReviewRequest).toMatchObject({
      teamName: 'ptc-a',
      taskId: 'task-one',
      nonce: 'review-one',
      targetTeamTabId: 'logical-tab',
      navigationTeamName: 'builders',
    });
    expect(f.state.pendingTaskDetailEditorRequest).toMatchObject({
      teamName: 'ptc-a',
      filePath: '/projects/a/test.ts',
      nonce: 'editor-one',
      targetTeamTabId: 'logical-tab',
      navigationTeamName: 'builders',
    });
  });

  it('never retargets obsolete reviews or unrelated source team identities', () => {
    const f = fixture();
    f.state.pendingReviewRequest = { ...f.review, nonce: 'newer-review' };
    f.state.pendingTaskDetailEditorRequest = { ...f.editor, teamName: 'ptc-other' };
    redirectProjectAliasTaskNavigation(f.get, 'ptc-a', 'builders', '/projects/a');
    expect(f.state.setPendingReviewRequest).toHaveBeenCalledOnce();
    // The current nonce is still pending, and only its exact alias-tab target qualifies.
    expect(f.state.pendingReviewRequest).toMatchObject({ nonce: 'newer-review' });
    expect(f.state.setPendingTaskDetailEditorRequest).not.toHaveBeenCalled();
  });

  it('does not navigate when the source alias is not the active tab', () => {
    const f = fixture();
    f.state.activeTabId = 'logical-tab';
    redirectProjectAliasTaskNavigation(f.get, 'ptc-a', 'builders', '/projects/a');
    expect(f.state.openTeamTab).not.toHaveBeenCalled();
    expect(f.state.setPendingReviewRequest).not.toHaveBeenCalled();
    expect(f.state.setPendingTaskDetailEditorRequest).not.toHaveBeenCalled();
    expect(f.state.activeTabId).toBe('logical-tab');
  });

  it('does not navigate while the app context is switching', () => {
    const f = fixture();
    f.state.isContextSwitching = true;
    redirectProjectAliasTaskNavigation(f.get, 'ptc-a', 'builders', '/projects/a');
    expect(f.state.openTeamTab).not.toHaveBeenCalled();
  });

  it('does not transfer requests if their context changed while navigating', () => {
    const f = fixture();
    f.state.openTeamTab.mockImplementationOnce(() => {
      f.state.activeContextId = 'other-context';
      f.state.activeTabId = 'logical-tab';
    });
    redirectProjectAliasTaskNavigation(f.get, 'ptc-a', 'builders', '/projects/a');
    expect(f.state.setPendingReviewRequest).not.toHaveBeenCalled();
    expect(f.state.setPendingTaskDetailEditorRequest).not.toHaveBeenCalled();
  });
});

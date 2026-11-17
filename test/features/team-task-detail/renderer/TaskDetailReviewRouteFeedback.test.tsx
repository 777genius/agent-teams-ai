import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskDetailReviewRouteFeedback } from '../../../../src/features/team-task-detail/renderer/adapters/TaskDetailReviewRouteFeedback';
import { TaskDetailEditorRouteFeedback } from '../../../../src/features/team-task-detail/renderer/adapters/TaskDetailEditorRouteFeedback';

const stateHolder = vi.hoisted(() => ({
  current: null as unknown,
  setPendingReviewRequest: vi.fn(),
  setPendingTaskDetailEditorRequest: vi.fn(),
}));

vi.mock('@renderer/store', () => {
  const useStore = Object.assign(
    (selector: (state: unknown) => unknown) => selector(stateHolder.current),
    { getState: () => stateHolder.current }
  );
  return { useStore };
});
vi.mock('@renderer/store/team/taskDetailReadAuthority', () => ({
  isTaskDetailReadScopeCurrent: () => true,
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../../src/features/team-task-detail/renderer/ui/TaskDetailReviewRouteBanner', () => ({
  TaskDetailReviewRouteBanner: () => null,
}));

const review = (navigationTeamName?: string, status: 'pending' | 'opening' = 'pending') => ({
  contextId: 'local',
  teamName: 'ptc-project-a',
  ...(navigationTeamName ? { navigationTeamName } : {}),
  taskId: 'task-a',
  targetTeamTabId: 'logical-tab',
  nonce: 'review-1',
  status,
});

function mountState(target: string, navigationTeamName?: string, status: 'pending' | 'opening' = 'pending') {
  const request = review(navigationTeamName, status);
  stateHolder.current = {
    pendingReviewRequest: request,
    activeContextId: 'local',
    isContextSwitching: false,
    selectedTeamName: 'ptc-project-a',
    paneLayout: {
      panes: [{ activeTabId: 'logical-tab', tabs: [
        { id: 'logical-tab', type: 'team', teamName: target },
      ] }],
    },
    setPendingReviewRequest: stateHolder.setPendingReviewRequest,
  };
  return request;
}

describe('TaskDetailReviewRouteFeedback alias navigation', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stateHolder.setPendingReviewRequest.mockReset();
    stateHolder.setPendingTaskDetailEditorRequest.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('keeps the review pending when a physical task is hosted in its logical team tab', async () => {
    mountState('builders', 'builders');
    await act(async () => root.render(React.createElement(TaskDetailReviewRouteFeedback)));
    expect(stateHolder.setPendingReviewRequest).not.toHaveBeenCalled();
  });

  it('does not block an opening review whose physical team data is selected', async () => {
    mountState('builders', 'builders', 'opening');
    await act(async () => root.render(React.createElement(TaskDetailReviewRouteFeedback)));
    expect(stateHolder.setPendingReviewRequest).not.toHaveBeenCalled();
  });

  it('still blocks navigation to an unrelated visible tab', async () => {
    const request = mountState('other-team', 'builders');
    await act(async () => root.render(React.createElement(TaskDetailReviewRouteFeedback)));
    expect(stateHolder.setPendingReviewRequest).toHaveBeenCalledWith({
      ...request, status: 'blocked',
    });
  });

  it('keeps the project editor request valid when its physical team opens a logical tab', async () => {
    const review = mountState('builders', 'builders');
    const editor = {
      ...review, projectPath: '/sandbox/a', filePath: '/sandbox/a/src/file.ts', line: 1,
    };
    stateHolder.current = {
      ...(stateHolder.current as object),
      pendingTaskDetailEditorRequest: editor,
      setPendingTaskDetailEditorRequest: stateHolder.setPendingTaskDetailEditorRequest,
    };
    await act(async () => root.render(React.createElement(TaskDetailEditorRouteFeedback)));
    expect(stateHolder.setPendingTaskDetailEditorRequest).not.toHaveBeenCalled();
  });

  it('blocks editor navigation if the active tab no longer matches its logical destination', async () => {
    const review = mountState('unrelated', 'builders');
    const editor = {
      ...review, projectPath: '/sandbox/a', filePath: '/sandbox/a/src/file.ts', line: 1,
    };
    stateHolder.current = {
      ...(stateHolder.current as object),
      pendingTaskDetailEditorRequest: editor,
      setPendingTaskDetailEditorRequest: stateHolder.setPendingTaskDetailEditorRequest,
    };
    await act(async () => root.render(React.createElement(TaskDetailEditorRouteFeedback)));
    expect(stateHolder.setPendingTaskDetailEditorRequest).toHaveBeenCalledWith({
      ...editor, status: 'blocked',
    });
  });

  it('retains the ordinary physical-name guard for non-project reviews', async () => {
    mountState('ptc-project-a');
    await act(async () => root.render(React.createElement(TaskDetailReviewRouteFeedback)));
    expect(stateHolder.setPendingReviewRequest).not.toHaveBeenCalled();
  });
});

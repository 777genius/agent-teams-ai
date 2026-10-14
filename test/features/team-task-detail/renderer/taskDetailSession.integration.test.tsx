import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { createTaskDetailReadEntry, taskDetailKey } from '@features/team-task-detail/core';
import { TaskDetailEditorActivationFeedback } from '@features/team-task-detail/renderer/adapters/TaskDetailEditorActivationFeedback';
import { TaskDetailReadCoordinator } from '@features/team-task-detail/renderer/adapters/TaskDetailReadCoordinator';
import { useTaskDetailEditorHost } from '@features/team-task-detail/renderer/hooks/useTaskDetailEditorHost';
import { useTaskDetailReviewRoute } from '@features/team-task-detail/renderer/hooks/useTaskDetailReviewRoute';
import { useTaskDetailSession } from '@features/team-task-detail/renderer/hooks/useTaskDetailSession';
import { useStore } from '@renderer/store';
import { __resetTeamSliceModuleStateForTests } from '@renderer/store/slices/teamSlice';
import { invalidateContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskDetailIdentity } from '@features/team-task-detail/contracts';
import type { TaskDetailSessionController } from '@features/team-task-detail/renderer';
import type { TaskComment, TeamTaskWithKanban } from '@shared/types';

const apiMock = vi.hoisted(() => ({ teams: { addTaskComment: vi.fn(), getTask: vi.fn() } }));
vi.mock('@renderer/api', () => ({ api: apiMock }));
vi.mock('@renderer/services/draftStorage', () => ({
  draftStorage: {
    loadDraft: vi.fn(async () => null),
    saveDraft: vi.fn(async () => {}),
    deleteDraft: vi.fn(async () => {}),
    cleanupExpired: vi.fn(async () => {}),
  },
}));

const initial = useStore.getState();
const identity: TaskDetailIdentity = { contextId: 'local', teamName: 'TEST-team', taskId: '1' };
const key = taskDetailKey(identity);
const task: TeamTaskWithKanban = { id: '1', subject: 'TEST task', status: 'pending' };
const roots: ReturnType<typeof createRoot>[] = [];

function mount(surfaceId: string, receive: (controller: TaskDetailSessionController) => void) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const View = () => {
    const controller = useTaskDetailSession({
      identity: { ...identity },
      surfaceId,
      currentTask: task,
    });
    useEffect(() => {
      receive(controller);
    }, [controller]);
    return React.createElement(
      'span',
      { 'data-owner': controller.isOwner },
      controller.session.commentText
    );
  };
  root.render(React.createElement(View));
  return root;
}

describe('task session surface and origin integration', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    __resetTeamSliceModuleStateForTests();
    useStore.setState(
      {
        ...initial,
        activeContextId: 'local',
        isContextSwitching: false,
        taskDetailById: {
          [key]: {
            ...createTaskDetailReadEntry(identity),
            phase: 'ready',
            full: task,
            loading: false,
          },
        },
        taskDetailSessionById: {},
        refreshTeamData: vi.fn(async () => {}),
      },
      true
    );
  });
  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('refreshes same-ID tasks across teams once per identity from root interest', async () => {
    const other = { ...identity, teamName: 'TEST-other-team' };
    const otherKey = taskDetailKey(other);
    const tails = new Map([
      [identity.teamName, 'full tail A'],
      [other.teamName, 'full tail B'],
    ]);
    apiMock.teams.getTask.mockImplementation(async (teamName: string) => ({
      ...task,
      description: tails.get(teamName),
    }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      useStore.setState({ taskDetailById: {} });
      useStore.getState().openTaskDetailTab(identity);
      useStore.getState().openTaskDetailTab(other);
      useStore.getState().setTaskDetailSurfaceInterest('duplicate-dialog', identity);
      root.render(React.createElement(TaskDetailReadCoordinator));
    });
    expect(apiMock.teams.getTask).toHaveBeenCalledTimes(2);
    expect(useStore.getState().taskDetailById[key].full?.description).toBe('full tail A');
    expect(useStore.getState().taskDetailById[otherKey].full?.description).toBe('full tail B');

    tails.set(identity.teamName, 'changed tail A');
    tails.set(other.teamName, 'changed tail B');
    await act(async () => {
      useStore.getState().invalidateTaskDetailTeamSource('local', identity.teamName, '1');
      useStore.getState().invalidateTaskDetailTeamSource('local', other.teamName, '1');
    });
    expect(apiMock.teams.getTask).toHaveBeenCalledTimes(4);
    expect(useStore.getState().taskDetailById[key].full?.description).toBe('changed tail A');
    expect(useStore.getState().taskDetailById[otherKey].full?.description).toBe('changed tail B');
    await act(async () => {
      useStore.getState().setTaskDetailSurfaceInterest('duplicate-dialog', null);
      useStore.setState({ selectedProjectId: 'TEST-unrelated-selection' });
    });
    expect(useStore.getState().taskDetailSurfaceInterests).not.toHaveProperty('duplicate-dialog');
    expect(apiMock.teams.getTask).toHaveBeenCalledTimes(4);
  });

  it('keeps refused reviews and ignores a late confirmation for an older nonce', async () => {
    let first!: (accepted: boolean) => void;
    let second!: (accepted: boolean) => void;
    const openReview = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            first = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            second = resolve;
          })
      )
      .mockResolvedValue(true);
    useStore.setState({
      selectTeam: vi.fn(async (teamName: string) => {
        useStore.setState({ selectedTeamName: teamName });
      }),
    });
    useStore.getState().updateTaskDetailSessionPart(identity, 'commentText', 'keep route draft');
    expect(useStore.getState().openTaskDetailReview(identity, { requestOptions: {} })).toBe(true);
    const targetId = useStore.getState().pendingReviewRequest!.targetTeamTabId;
    const firstNonce = useStore.getState().pendingReviewRequest!.nonce;
    const Target = ({ teamName }: { teamName: string }) => {
      useTaskDetailReviewRoute({
        teamName,
        tabId: targetId,
        active: true,
        ready: true,
        openReview,
      });
      return null;
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      // TeamDetailView consumes only after its target team data is selected.
      useStore.setState({ selectedTeamName: identity.teamName });
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Target, { teamName: 'TEST-wrong-team' }),
          React.createElement(Target, { teamName: identity.teamName })
        )
      );
    });
    expect(openReview).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pendingReviewRequest?.status).toBe('opening');
    await act(async () => {
      useStore
        .getState()
        .openTaskDetailReview(identity, { filePath: 'next.ts', requestOptions: {} });
    });
    const secondNonce = useStore.getState().pendingReviewRequest!.nonce;
    expect(secondNonce).not.toBe(firstNonce);
    await act(async () => {
      first(true);
    });
    expect(useStore.getState().pendingReviewRequest?.nonce).toBe(secondNonce);
    await act(async () => {
      second(false);
    });
    expect(useStore.getState().pendingReviewRequest?.status).toBe('blocked');
    expect(useStore.getState().pendingReviewRequest?.nonce).toBe(secondNonce);
    await act(async () => {
      useStore.getState().retryPendingTaskDetailReview(secondNonce);
    });
    expect(openReview).toHaveBeenCalledTimes(3);
    expect(useStore.getState().pendingReviewRequest).toBeNull();
    expect(useStore.getState().taskDetailSessionById[key].commentText).toBe('keep route draft');
    await act(async () => {
      useStore.getState().openTaskDetailTab(identity);
      useStore.setState({ setActiveTab: vi.fn() });
      expect(useStore.getState().openTaskDetailReview(identity, { requestOptions: {} })).toBe(
        false
      );
    });
    expect(useStore.getState().pendingReviewRequest).toBeNull();
    expect(useStore.getState().taskDetailReviewActivationFailure?.identity).toEqual(identity);
    useStore
      .getState()
      .closeTaskDetailReviewActivationFailure(
        useStore.getState().taskDetailReviewActivationFailure!.nonce
      );
    expect(useStore.getState().taskDetailReviewActivationFailure).toBeNull();
  });

  it('addresses editor requests to one host and keeps blocked or retired requests inert', async () => {
    const projectPath = '/TEST/editor-project';
    const intent = { projectPath, filePath: `${projectPath}/README.md`, line: 7 };
    const openEditor = vi.fn();
    const wrongEditor = vi.fn();
    const reveal = vi.fn();
    useStore.setState({
      selectTeam: vi.fn(async () => {}),
      editorProjectPath: projectPath,
      editorFileTree: [],
      editorFileTreeLoading: true,
      editorFileTreeError: null,
      revealFileInEditor: reveal,
    });
    expect(useStore.getState().openTaskDetailEditor(identity, intent)).toBe(true);
    const request = useStore.getState().pendingTaskDetailEditorRequest!;
    const Host = ({ wrong = false }: { wrong?: boolean }) => {
      useTaskDetailEditorHost({
        teamName: wrong ? 'TEST-other-team' : identity.teamName,
        tabId: wrong ? 'TEST-other-tab' : request.targetTeamTabId,
        active: true,
        projectPath,
        openEditor: wrong ? wrongEditor : openEditor,
      });
      return null;
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Host),
          React.createElement(Host, { wrong: true })
        )
      );
    });
    expect(openEditor).toHaveBeenCalledTimes(1);
    expect(wrongEditor).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    await act(async () => {
      useStore.setState({ editorFileTreeError: 'TEST unavailable' });
    });
    expect(useStore.getState().pendingTaskDetailEditorRequest?.status).toBe('blocked');
    await act(async () => {
      useStore.setState({ editorFileTreeError: null, editorFileTreeLoading: false });
    });
    expect(reveal).not.toHaveBeenCalled();
    await act(async () => {
      expect(useStore.getState().retryPendingTaskDetailEditor(request.nonce)).toBe(true);
    });
    expect(reveal).toHaveBeenCalledExactlyOnceWith(intent.filePath);
    expect(useStore.getState().editorPendingGoToLine).toBe(7);
    expect(useStore.getState().pendingTaskDetailEditorRequest).toBeNull();
    await act(async () => {
      useStore.setState({ editorFileTreeLoading: true });
      useStore.getState().openTaskDetailEditor(identity, intent);
    });
    const retired = useStore.getState().pendingTaskDetailEditorRequest!;
    invalidateContextScopedRequestEpoch();
    expect(useStore.getState().retryPendingTaskDetailEditor(retired.nonce)).toBe(false);
    await act(async () => {
      useStore.setState({ editorFileTreeLoading: false });
    });
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(wrongEditor).not.toHaveBeenCalled();
  });

  it('shows a refused editor activation only in its originating task', async () => {
    const other = { ...identity, taskId: '2' };
    const intent = { projectPath: '/TEST/project', filePath: '/TEST/project/a.ts', line: null };
    useStore.setState({ openTeamTab: vi.fn() });
    expect(useStore.getState().openTaskDetailEditor(identity, intent)).toBe(false);
    const nonce = useStore.getState().taskDetailEditorActivationFailure!.nonce;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(
            'div',
            { 'data-source': '1' },
            React.createElement(TaskDetailEditorActivationFeedback, { identity, active: true })
          ),
          React.createElement(
            'div',
            { 'data-source': '2' },
            React.createElement(TaskDetailEditorActivationFeedback, {
              identity: other,
              active: true,
            })
          )
        )
      );
    });
    expect(host.querySelector('[data-source="1"] button')).not.toBeNull();
    expect(host.querySelector('[data-source="2"]')?.textContent).toBe('');
    await act(async () => {
      expect(useStore.getState().openTaskDetailEditor(other, intent)).toBe(false);
    });
    expect(useStore.getState().retryTaskDetailEditorActivationFailure(nonce)).toBe(false);
    expect(host.querySelector('[data-source="1"]')?.textContent).toBe('');
    expect(host.querySelector('[data-source="2"] button')).not.toBeNull();
  });

  it('continues a FileReader after dialog unmount and does not read a removed queued file', async () => {
    const readers: DeferredReader[] = [];
    class DeferredReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        readers.push(this);
      }
    }
    vi.stubGlobal('FileReader', DeferredReader);
    let source!: TaskDetailSessionController;
    let target!: TaskDetailSessionController;
    let successor!: TaskDetailSessionController;
    let targetRoot!: ReturnType<typeof createRoot>;
    let sourceRoot!: ReturnType<typeof createRoot>;
    await act(async () => {
      sourceRoot = mount('dialog', (value) => {
        source = value;
      });
    });
    let reading!: Promise<void>;
    await act(async () => {
      reading = source.addPendingFiles([
        new File(['hello'], 'keep.txt', { type: 'text/plain' }),
        new File(['world'], 'remove.txt', { type: 'text/plain' }),
      ]);
    });
    expect(source.canSubmit).toBe(false);
    expect(source.session.pendingAttachments.map((file) => file.filename)).toEqual([
      'keep.txt',
      'remove.txt',
    ]);
    await act(async () => {
      expect(source.openInTaskTab()).toBe(true);
    });
    const tabId = useStore.getState().taskDetailSessionById[key].ownerSurfaceId!;
    await act(async () => {
      sourceRoot.unmount();
      roots.splice(roots.indexOf(sourceRoot), 1);
      targetRoot = mount(tabId, (value) => {
        target = value;
      });
    });
    expect(target.isOwner).toBe(true);
    const removed = target.session.pendingAttachments.find(
      (file) => file.filename === 'remove.txt'
    )!;
    await act(async () => {
      target.removePendingAttachment(removed.id);
    });
    await act(async () => {
      readers[0].result = 'data:text/plain;base64,aGVsbG8=';
      readers[0].onload?.();
      await reading;
    });
    expect(readers).toHaveLength(1);
    expect(target.session.pendingAttachments).toMatchObject([
      { filename: 'keep.txt', base64Data: 'aGVsbG8=', size: 5 },
    ]);
    expect(target.session.ownerSurfaceId).toBe(tabId);
    expect(target.session.pendingAttachmentPreparationIds).toEqual([]);
    await act(async () => {
      mount('successor', (value) => {
        successor = value;
      });
    });
    expect(successor.isOwner).toBe(false);
    await act(async () => {
      targetRoot.unmount();
      roots.splice(roots.indexOf(targetRoot), 1);
    });
    expect(successor.isOwner).toBe(true);
  });

  it('keeps a refused handoff and prevents a late submit from changing another context', async () => {
    let source!: TaskDetailSessionController;
    let peer!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        source = value;
      });
      mount('peer', (value) => {
        peer = value;
      });
    });
    expect(source.isOwner).toBe(true);
    expect(peer.isOwner).toBe(false);
    await act(async () => {
      source.setCommentText('keep A');
      peer.setCommentText('wrong peer');
    });
    let ordinaryTabId!: string;
    let targetTabId!: string;
    await act(async () => {
      useStore.getState().openTab({ type: 'settings', label: 'TEST settings' });
      ordinaryTabId = useStore.getState().activeTabId!;
      targetTabId = useStore.getState().openTaskDetailTab(identity)!.tabId;
      useStore.getState().setActiveTab(ordinaryTabId);
      useStore.setState({ setActiveTab: vi.fn() });
    });
    await act(async () => {
      expect(source.openInTaskTab()).toBe(false);
    });
    expect(useStore.getState().taskDetailSessionById[key].ownerSurfaceId).toBe('dialog');
    expect(useStore.getState().taskDetailSessionById[key].commentText).toBe('keep A');
    expect(targetTabId).not.toBe(ordinaryTabId);

    let finish!: (comment: TaskComment) => void;
    apiMock.teams.addTaskComment.mockReturnValue(
      new Promise<TaskComment>((resolve) => {
        finish = resolve;
      })
    );
    let submitting!: Promise<void>;
    await act(async () => {
      submitting = source.submitComment();
    });
    const other = { ...identity, contextId: 'remote-test' };
    const otherKey = taskDetailKey(other);
    await act(async () => {
      useStore.getState().retireTaskDetailSessionWork();
      invalidateContextScopedRequestEpoch();
      useStore.setState({ activeContextId: other.contextId });
      useStore.getState().updateTaskDetailSessionPart(other, 'commentText', 'keep B');
      useStore.getState().beginTaskDetailSubmitSession(other);
      useStore.setState({ addingComment: true, addCommentError: 'B error' });
    });
    await act(async () => {
      finish({
        id: 'comment-1',
        author: 'user',
        text: 'keep A',
        createdAt: '2026-10-14T00:00:00Z',
        type: 'regular',
      });
      await submitting;
    });
    const state = useStore.getState();
    expect(state.taskDetailSessionById[otherKey]).toMatchObject({
      commentText: 'keep B',
      submitPending: true,
    });
    expect(state.taskDetailSessionById[key]).toMatchObject({
      commentText: 'keep A',
      submitPending: false,
    });
    expect(state.addingComment).toBe(true);
    expect(state.addCommentError).toBe('B error');
    expect(state.refreshTeamData).not.toHaveBeenCalled();
  });
});

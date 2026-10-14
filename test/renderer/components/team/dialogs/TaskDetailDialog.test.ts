import React, { act } from 'react';
import { createRoot as createReactRoot, type Root } from 'react-dom/client';

const roots = new Set<Root>();
function createRoot(host: HTMLElement): Root {
  const root = createReactRoot(host);
  roots.add(root);
  return root;
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getTaskChanges: vi.fn(),
  updateTaskFields: vi.fn(),
  recordTaskChangePresence: vi.fn(),
  setSelectedTeamTaskChangePresence: vi.fn(),
  setTaskNeedsClarification: vi.fn(),
  getTaskAttachmentData: vi.fn(),
  lastUnreadCommentIds: undefined as ReadonlySet<string> | undefined,
  showComments: false,
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      onTeamChange: vi.fn(() => vi.fn()),
    },
    teamGroupChats: {
      list: vi.fn().mockResolvedValue([]),
    },
    review: {
      getTaskChanges: hoisted.getTaskChanges,
    },
  },
}));

vi.mock('@renderer/store', async () => {
  const { create } = await import('zustand');
  const { createTaskDetailResourcesSlice } =
    await import('@renderer/store/slices/taskDetailResourcesSlice');
  const useStore = create<AppState>()(
    (...args) =>
      ({
        ...createTaskDetailResourcesSlice(...args),
        activeContextId: 'local',
        isContextSwitching: false,
        paneLayout: { panes: [], focusedPaneId: '' },
        taskDetailSurfaceInterests: {},
        taskDetailById: {},
        taskDetailReviewActivationFailure: null,
        taskDetailEditorActivationFailure: null,
        updateTaskFields: hoisted.updateTaskFields,
        recordTaskChangePresence: hoisted.recordTaskChangePresence,
        setSelectedTeamTaskChangePresence: hoisted.setSelectedTeamTaskChangePresence,
        setTaskNeedsClarification: hoisted.setTaskNeedsClarification,
        getTaskAttachmentData: hoisted.getTaskAttachmentData,
      }) as unknown as AppState
  );
  return { useStore };
});

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/hooks/useViewportCommentRead', () => ({
  useViewportCommentRead: () => ({ registerComment: vi.fn(), flush: vi.fn() }),
}));

vi.mock('@renderer/services/commentReadStorage', () => ({
  getLegacyCutoff: () => 0,
  getReadCommentIds: () => new Set<string>(),
}));

vi.mock('@renderer/components/team/CollapsibleTeamSection', () => ({
  CollapsibleTeamSection: ({
    title,
    children,
    defaultOpen = true,
    onOpenChange,
    badge,
    headerExtra,
  }: {
    title: string;
    children: React.ReactNode;
    defaultOpen?: boolean;
    onOpenChange?: (isOpen: boolean) => void;
    badge?: React.ReactNode;
    headerExtra?: React.ReactNode;
  }) => {
    const [open, setOpen] = React.useState(defaultOpen);
    React.useEffect(() => {
      onOpenChange?.(open);
    }, [open, onOpenChange]);
    return React.createElement(
      'section',
      null,
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => setOpen((value) => !value),
        },
        title,
        badge !== undefined
          ? React.createElement('span', { 'data-testid': `section-badge-${title}` }, badge)
          : null,
        headerExtra
          ? React.createElement('span', { 'data-testid': `section-extra-${title}` }, headerExtra)
          : null
      ),
      (title === 'Changes' ||
        title === 'Workflow History' ||
        (title === 'Comments' && hoisted.showComments)) &&
        open
        ? React.createElement('div', null, children)
        : null
    );
  },
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type = 'button',
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
  }) => React.createElement('button', { type, disabled, onClick }, children),
}));

vi.mock('@renderer/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => React.createElement('input', props),
}));

vi.mock('@renderer/components/ui/MemberSelect', () => ({
  MemberSelect: () => React.createElement('div', null),
}));

vi.mock('@renderer/components/ui/ExpandableContent', () => ({
  ExpandableContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/ui/tiptap', () => ({
  TiptapEditor: () => React.createElement('div', null),
}));

vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => React.createElement('div', null, content),
}));

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => React.createElement('span', null, name),
}));

vi.mock('@renderer/components/team/editor/FileIcon', () => ({
  FileIcon: () => React.createElement('span', null),
}));

vi.mock('@renderer/components/common/OngoingIndicator', () => ({
  OngoingIndicator: () => React.createElement('span', null),
}));

vi.mock('@renderer/components/team/attachments/ImageLightbox', () => ({
  ImageLightbox: () => null,
  LightboxLockProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('@renderer/components/team/attachments/SourceMessageAttachments', () => ({
  SourceMessageAttachments: () => null,
}));

vi.mock('@renderer/components/team/taskLogs/TaskLogsPanel', () => ({
  TaskLogsPanel: () => null,
}));

vi.mock('@renderer/components/team/dialogs/TaskCommentsSection', () => ({
  TaskCommentsSection: ({
    unreadCommentIds,
  }: {
    unreadCommentIds?: ReadonlySet<string>;
  }): React.ReactElement => {
    hoisted.lastUnreadCommentIds = unreadCommentIds;
    return React.createElement('div', {
      'data-testid': 'task-comments',
      'data-unread-comment-ids': Array.from(unreadCommentIds ?? []).join(','),
    });
  },
}));

vi.mock('@renderer/components/team/dialogs/TaskCommentInput', () => ({
  TaskCommentInput: () => null,
}));

import { createTaskDetailReadEntry, taskDetailKey } from '@features/team-task-detail/core';
import { TaskDetailReadCoordinator } from '@features/team-task-detail/renderer/adapters/TaskDetailReadCoordinator';
import { TaskDetailDialog } from '@renderer/components/team/dialogs/TaskDetailDialog';
import { useStore } from '@renderer/store';

import { createTaskDetailSessionFixture } from './taskDetailSessionFixture';

import type { TaskDetailDialogProps } from '@renderer/components/team/dialogs/TaskDetailDialog';
import type { AppState } from '@renderer/store/types';

function renderDialog(props: Omit<TaskDetailDialogProps, 'sessionController' | 'projectPath'>) {
  const controller = createTaskDetailSessionFixture(props.task?.id ?? 'missing');
  if (props.task) {
    const key = taskDetailKey(controller.identity);
    useStore.setState((state) => ({
      taskDetailById: {
        ...state.taskDetailById,
        [key]: {
          ...createTaskDetailReadEntry(controller.identity),
          full: props.task,
          phase: 'ready',
          loading: false,
        },
      },
    }));
  }
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(TaskDetailReadCoordinator),
    React.createElement(TaskDetailDialog, {
      ...props,
      projectPath: '/TEST/project',
      sessionController: controller,
    })
  );
}

import type { TaskChangeSetV2, TeamTaskWithKanban } from '@shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTask(id: string): TeamTaskWithKanban {
  return {
    id,
    displayId: id,
    subject: `Task ${id}`,
    description: '',
    owner: 'alice',
    reviewer: '',
    status: 'in_progress',
    changePresence: 'unknown',
    comments: [],
    attachments: [],
    blockedBy: [],
    blocks: [],
    workIntervals: [{ startedAt: '2026-04-20T10:00:00.000Z' }],
    historyEvents: [],
    createdAt: '2026-04-20T09:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
  } as unknown as TeamTaskWithKanban;
}

function readyTaskMap(...tasks: TeamTaskWithKanban[]): Map<string, TeamTaskWithKanban> {
  return new Map(tasks.map((task) => [task.id, task]));
}

function makeSummary(taskId: string): TaskChangeSetV2 {
  return {
    teamName: 'team-a',
    taskId,
    files: [
      {
        filePath: `/repo/src/${taskId}.ts`,
        relativePath: `src/${taskId}.ts`,
        snippets: [],
        linesAdded: 1,
        linesRemoved: 0,
        isNewFile: true,
      },
    ],
    totalFiles: 1,
    totalLinesAdded: 1,
    totalLinesRemoved: 0,
    confidence: 'high',
    computedAt: '2026-04-20T10:05:00.000Z',
    scope: {
      taskId,
      memberName: 'alice',
      startLine: 0,
      endLine: 0,
      startTimestamp: '2026-04-20T10:00:00.000Z',
      endTimestamp: '2026-04-20T10:05:00.000Z',
      toolUseIds: ['tool-1'],
      filePaths: [`/repo/src/${taskId}.ts`],
      confidence: { tier: 1, label: 'high', reason: 'ledger' },
    },
    warnings: [],
    provenance: {
      sourceKind: 'ledger',
      sourceFingerprint: `fingerprint-${taskId}`,
    },
  };
}

function clickChangesSection(host: HTMLElement): void {
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.startsWith('Changes') === true
  );
  if (!button) {
    throw new Error('Changes section button not found');
  }
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('TaskDetailDialog changes summary loading', () => {
  beforeEach(() => {
    hoisted.showComments = false;
    hoisted.lastUnreadCommentIds = undefined;
    useStore.setState({
      taskDetailById: {},
      taskDetailResourcesById: {},
      taskDetailVisibleDemandById: {},
      taskDetailResourcesRevision: 0,
    });
  });
  afterEach(async () => {
    await act(async () => {
      for (const root of roots) root.unmount();
      roots.clear();
    });
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('preserves the authoritative unavailable read state and retries only for the captured current identity', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const controller = createTaskDetailSessionFixture('task-unavailable');
    controller.session.commentText = 'rich draft';
    controller.isOriginCurrent = vi.fn(() => false);
    const retryRead = vi.fn();
    const task = { ...makeTask('task-unavailable'), projectPath: '/TASK/project' };

    await act(async () => {
      root.render(
        React.createElement(TaskDetailDialog, {
          open: true,
          task: null,
          readPhase: 'unavailable',
          readError: 'IPC transient',
          teamName: 'team-a',
          projectPath: '/TEAM/project',
          sessionController: controller,
          taskMap: new Map(),
          members: [],
          onClose: vi.fn(),
          onRetryRead: retryRead,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Task unavailable');
    expect(host.textContent).toContain('IPC transient');
    const retryButton = host.querySelector<HTMLButtonElement>('button');
    expect(retryButton).not.toBeNull();
    retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(retryRead).not.toHaveBeenCalled();

    controller.isOriginCurrent = vi.fn(() => true);
    retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(retryRead).toHaveBeenCalledWith({
      contextId: 'local',
      teamName: 'team-a',
      taskId: 'task-unavailable',
    });

    await act(async () => {
      root.render(
        React.createElement(TaskDetailDialog, {
          open: true,
          task,
          readPhase: 'ready',
          readError: null,
          teamName: 'team-a',
          projectPath: '/TEAM/project',
          sessionController: controller,
          taskMap: readyTaskMap(task),
          members: [],
          onClose: vi.fn(),
          onRetryRead: retryRead,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-task-detail-content]')).not.toBeNull();
    expect(controller.session.commentText).toBe('rich draft');
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders a fresh unread comment snapshot when a completed task updates while mounted', async () => {
    hoisted.showComments = true;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const firstComment = {
      id: 'comment-1',
      author: 'alice',
      text: 'first',
      createdAt: '2026-04-20T10:00:00.000Z',
    };
    const secondComment = {
      id: 'comment-2',
      author: 'alice',
      text: 'second',
      createdAt: '2026-04-20T10:01:00.000Z',
    };
    const firstTask = {
      ...makeTask('task-completed-unread'),
      status: 'completed',
      comments: [firstComment],
    } as unknown as TeamTaskWithKanban;
    const updatedTask = {
      ...firstTask,
      comments: [firstComment, secondComment],
    } as unknown as TeamTaskWithKanban;

    await act(async () => {
      root.render(
        renderDialog({
          open: true,
          variant: 'team',
          teamName: 'team-a',
          task: firstTask,
          taskMap: readyTaskMap(firstTask),
          members: [],
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
    });
    expect(hoisted.lastUnreadCommentIds?.has('comment-1')).toBe(true);

    await act(async () => {
      root.render(
        renderDialog({
          open: true,
          variant: 'team',
          teamName: 'team-a',
          task: updatedTask,
          taskMap: readyTaskMap(updatedTask),
          members: [],
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(hoisted.lastUnreadCommentIds?.has('comment-2')).toBe(true);
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses the task project path for file editor intents over the team config path', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const task = {
      ...makeTask('task-editor-path'),
      projectPath: '/TASK/project',
    } as unknown as TeamTaskWithKanban;
    const summary = makeSummary(task.id);
    summary.files[0].filePath = '/TASK/project/src/task-editor-path.ts';
    summary.files[0].relativePath = 'src/task-editor-path.ts';
    hoisted.getTaskChanges.mockResolvedValue(summary);
    const openTaskDetailEditor = vi.fn(() => true);
    useStore.setState({ openTaskDetailEditor });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        renderDialog({
          open: true,
          variant: 'team',
          teamName: 'team-a',
          task,
          taskMap: readyTaskMap(task),
          members: [],
          onClose: vi.fn(),
          onViewChanges: vi.fn(),
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      clickChangesSection(host);
      await Promise.resolve();
    });
    const fileButtons = host.querySelectorAll<HTMLButtonElement>('div[role="button"] button');
    expect(fileButtons.length).toBeGreaterThan(0);
    await act(async () => {
      fileButtons[fileButtons.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(openTaskDetailEditor).toHaveBeenCalledWith(
      {
        contextId: 'local',
        teamName: 'team-a',
        taskId: 'task-editor-path',
      },
      {
        projectPath: '/TASK/project',
        filePath: '/TASK/project/src/task-editor-path.ts',
        line: null,
      }
    );
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows a zero attachments count in the attachments section header', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const task = { ...makeTask('task-empty-attachments'), workIntervals: [] };
    await act(async () => {
      root.render(
        renderDialog({
          open: true,
          variant: 'team',
          teamName: 'team-a',
          task,
          taskMap: readyTaskMap(task),
          members: [],
          onClose: vi.fn(),
          onViewChanges: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="section-badge-Attachments"]')?.textContent).toBe('0');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not render the legacy reviewer row below task logs', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const task = { ...makeTask('task-review'), workIntervals: [] };
    await act(async () => {
      root.render(
        renderDialog({
          open: true,
          variant: 'team',
          teamName: 'team-a',
          task,
          kanbanTaskState: {
            column: 'review',
            reviewer: 'reviewer',
            errorDescription: 'Review failed',
            movedAt: '2026-04-20T10:00:00.000Z',
          },
          taskMap: readyTaskMap(task),
          members: [],
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Reviewer: reviewer');
    expect(host.textContent).toContain('Review failed');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not drop a new task changes request while another task summary is still in flight', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const first = deferred<TaskChangeSetV2>();
    const second = deferred<TaskChangeSetV2>();
    hoisted.getTaskChanges
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const taskA: TeamTaskWithKanban = { ...makeTask('task-a'), changePresence: 'has_changes' };
    const taskB: TeamTaskWithKanban = { ...makeTask('task-b'), changePresence: 'has_changes' };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const baseProps = {
      open: true,
      variant: 'team' as const,
      teamName: 'team-a',
      taskMap: readyTaskMap(taskA, taskB),
      members: [],
      onClose: vi.fn(),
      onViewChanges: vi.fn(),
    };

    await act(async () => {
      root.render(renderDialog({ ...baseProps, task: taskA }));
      await Promise.resolve();
    });
    await act(async () => {
      clickChangesSection(host);
      await Promise.resolve();
    });
    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(1);
    expect(hoisted.getTaskChanges).toHaveBeenLastCalledWith(
      'team-a',
      'task-a',
      expect.objectContaining({ summaryOnly: true })
    );

    await act(async () => {
      root.render(renderDialog({ ...baseProps, task: taskB }));
      await Promise.resolve();
    });
    await act(async () => {
      clickChangesSection(host);
      await Promise.resolve();
    });

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(2);
    expect(hoisted.getTaskChanges).toHaveBeenLastCalledWith(
      'team-a',
      'task-b',
      expect.objectContaining({ summaryOnly: true })
    );

    await act(async () => {
      root.render(renderDialog({ ...baseProps, task: taskA }));
      await Promise.resolve();
    });
    await act(async () => {
      clickChangesSection(host);
      await Promise.resolve();
    });
    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(makeSummary('task-a'));
      await Promise.resolve();
    });
    expect(host.textContent).toContain('src/task-a.ts');
    expect(host.textContent).not.toContain('src/task-b.ts');

    await act(async () => {
      second.resolve(makeSummary('task-b'));
      await Promise.resolve();
    });
    expect(host.textContent).toContain('src/task-a.ts');
    expect(host.textContent).not.toContain('src/task-b.ts');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the changes section lazy-loadable when the task needs attention', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hoisted.getTaskChanges.mockResolvedValueOnce({
      ...makeSummary('task-attention'),
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      confidence: 'low',
      warnings: ['No file changes were recorded for this task.'],
    });

    const task: TeamTaskWithKanban = {
      ...makeTask('task-attention'),
      changePresence: 'needs_attention',
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        renderDialog({
          open: true,
          variant: 'team',
          teamName: 'team-a',
          task,
          taskMap: readyTaskMap(task),
          members: [],
          onClose: vi.fn(),
          onViewChanges: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(
      [...host.querySelectorAll('button')].some(
        (button) => button.textContent?.startsWith('Changes') === true
      )
    ).toBe(true);

    await act(async () => {
      clickChangesSection(host);
      await Promise.resolve();
    });

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(1);
    expect(hoisted.getTaskChanges).toHaveBeenLastCalledWith(
      'team-a',
      'task-attention',
      expect.objectContaining({ summaryOnly: true })
    );
    expect(host.textContent).toContain('No file changes were recorded for this task.');
    expect(host.textContent).toContain('No reviewable file changes recovered');
    const warningText = [...host.querySelectorAll('span')].find(
      (element) => element.textContent === 'No file changes were recorded for this task.'
    );
    const warningRow = warningText?.parentElement?.parentElement;
    expect(warningRow?.className).toContain('border-b');
    expect(warningRow?.className).not.toContain('rounded');
    expect(host.querySelector('[data-testid="section-badge-Changes"]')?.textContent).toBe(
      'attention'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('reserves backfill retry for a manual click while automatically refreshing every 20 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const task = makeTask('task-refresh');
    hoisted.getTaskChanges.mockResolvedValue(makeSummary(task.id));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          renderDialog({
            open: true,
            variant: 'team',
            teamName: 'team-a',
            task,
            taskMap: readyTaskMap(task),
            members: [],
            onClose: vi.fn(),
          })
        );
      });
      await act(async () => {
        clickChangesSection(host);
      });
      expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(1);
      for (let tick = 0; tick < 5; tick++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000);
        });
        expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(tick + 2);
        expect(hoisted.getTaskChanges).toHaveBeenLastCalledWith(
          'team-a',
          task.id,
          expect.objectContaining({ summaryOnly: true, forceFresh: true })
        );
        expect(hoisted.getTaskChanges.mock.lastCall?.[2].retryBackfill).not.toBe(true);
      }
      const refreshButton = host.querySelector<HTMLButtonElement>(
        '[data-testid="section-extra-Changes"] button'
      );
      expect(refreshButton).not.toBeNull();
      await act(async () => {
        refreshButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(7);
      expect(hoisted.getTaskChanges).toHaveBeenLastCalledWith(
        'team-a',
        task.id,
        expect.objectContaining({ summaryOnly: true, forceFresh: true, retryBackfill: true })
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(8);
      expect(hoisted.getTaskChanges.mock.lastCall?.[2].retryBackfill).not.toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
      hoisted.getTaskChanges.mockReset();
    }
  });

  it('loads the visible changes summary once and shares its header loading state', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const request = deferred<TaskChangeSetV2>();
    hoisted.getTaskChanges.mockImplementationOnce(() => request.promise);

    const task: TeamTaskWithKanban = { ...makeTask('task-autoload'), changePresence: 'unknown' };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        renderDialog({
          open: true,
          variant: 'team',
          teamName: 'team-a',
          task,
          taskMap: readyTaskMap(task),
          members: [],
          onClose: vi.fn(),
          onViewChanges: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(1);
    expect(hoisted.getTaskChanges).toHaveBeenLastCalledWith(
      'team-a',
      'task-autoload',
      expect.objectContaining({ summaryOnly: true, forceFresh: false })
    );
    expect(host.querySelector('[data-testid="section-badge-Changes"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="section-extra-Changes"] .animate-spin')
    ).not.toBeNull();

    await act(async () => {
      request.resolve(makeSummary('task-autoload'));
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="section-badge-Changes"]')?.textContent).toBe('1');

    await act(async () => {
      clickChangesSection(host);
      await Promise.resolve();
    });

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('src/task-autoload.ts');
    const fileRow = host.querySelector<HTMLElement>(
      '[role="button"][aria-label="src/task-autoload.ts"]'
    );
    expect(fileRow).not.toBeNull();
    expect(fileRow?.className).not.toContain('rounded');
    expect(fileRow?.parentElement?.parentElement?.className).toContain('border-y');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the changes section visible for pending tasks and loads without a review handler', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hoisted.getTaskChanges.mockResolvedValueOnce(makeSummary('task-pending'));

    const task: TeamTaskWithKanban = {
      ...makeTask('task-pending'),
      status: 'pending',
      changePresence: 'unknown',
      workIntervals: [],
    } as unknown as TeamTaskWithKanban;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        renderDialog({
          open: true,
          variant: 'team',
          teamName: 'team-a',
          task,
          taskMap: readyTaskMap(task),
          members: [],
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(
      [...host.querySelectorAll('button')].some(
        (button) => button.textContent?.startsWith('Changes') === true
      )
    ).toBe(true);

    await act(async () => {
      clickChangesSection(host);
      await Promise.resolve();
    });

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(1);
    expect(hoisted.getTaskChanges).toHaveBeenLastCalledWith(
      'team-a',
      'task-pending',
      expect.objectContaining({ summaryOnly: true })
    );
    expect(host.textContent).toContain('src/task-pending.ts');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows total and per-transition implementation time in workflow history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T10:07:30.000Z'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const task: TeamTaskWithKanban = {
      ...makeTask('task-duration'),
      workIntervals: [
        {
          startedAt: '2026-04-20T10:00:00.000Z',
          completedAt: '2026-04-20T10:02:30.000Z',
        },
        { startedAt: '2026-04-20T10:05:00.000Z' },
      ],
      historyEvents: [
        {
          id: 'event-created',
          timestamp: '2026-04-20T09:59:00.000Z',
          type: 'task_created',
          status: 'pending',
          actor: 'lead',
        },
        {
          id: 'event-started',
          timestamp: '2026-04-20T10:00:00.000Z',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          actor: 'lead',
        },
        {
          id: 'event-completed',
          timestamp: '2026-04-20T10:02:31.000Z',
          type: 'status_changed',
          from: 'in_progress',
          to: 'completed',
          actor: 'alice',
        },
        {
          id: 'event-restarted',
          timestamp: '2026-04-20T10:05:00.000Z',
          type: 'status_changed',
          from: 'completed',
          to: 'in_progress',
          actor: 'lead',
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        renderDialog({
          open: true,
          variant: 'team',
          teamName: 'team-a',
          task,
          taskMap: readyTaskMap(task),
          members: [],
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Workflow History');
    expect(host.textContent).toContain('In progress time 5m 00s');

    const workflowButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.startsWith('Workflow History') === true
    );
    if (!workflowButton) {
      throw new Error('Workflow History section button not found');
    }

    await act(async () => {
      workflowButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('2m 30s');
    expect(host.textContent).toContain('running 2m 30s');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BoardTaskActivityDetailResult,
  BoardTaskActivityEntry,
} from '../../../../../src/shared/types';

const apiState = {
  getTaskActivity: vi.fn<(teamName: string, taskId: string) => Promise<BoardTaskActivityEntry[]>>(),
  getTaskActivityDetail:
    vi.fn<
      (teamName: string, taskId: string, activityId: string) => Promise<BoardTaskActivityDetailResult>
    >(),
};

const renderabilityState = {
  hasDisplayItems: true,
  toolName: 'task_add_comment',
};

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getTaskActivity: (...args: Parameters<typeof apiState.getTaskActivity>) =>
        apiState.getTaskActivity(...args),
      getTaskActivityDetail: (...args: Parameters<typeof apiState.getTaskActivityDetail>) =>
        apiState.getTaskActivityDetail(...args),
    },
  },
}));

vi.mock('@renderer/components/chat/DisplayItemList', () => ({
  DisplayItemList: ({
    items,
  }: {
    items: Array<{ type: string; tool?: { name?: string } }>;
  }) =>
    React.createElement(
      'div',
      { 'data-testid': 'linked-tool-card' },
      items.map((item) => `${item.type}:${item.tool?.name ?? 'unknown'}`).join(',')
    ),
}));

vi.mock('@renderer/types/data', () => ({
  asEnhancedChunkArray: (value: unknown) => value,
}));

vi.mock('@renderer/utils/groupTransformer', () => ({
  transformChunksToConversation: () => ({
    items: [{ type: 'ai', group: { id: 'ai-group' } }],
  }),
}));

vi.mock('@renderer/utils/aiGroupEnhancer', () => ({
  enhanceAIGroup: () => ({
    displayItems: renderabilityState.hasDisplayItems
      ? [
          {
            type: 'tool',
            tool: {
              id: 'tool-1',
              name: renderabilityState.toolName,
              input: {},
              inputPreview: '',
              startTime: new Date('2026-04-13T10:35:00.000Z'),
              isOrphaned: false,
            },
          },
        ]
      : [],
  }),
}));

vi.mock('@shared/utils/boardTaskActivityPresentation', () => ({
  describeBoardTaskActivityActorLabel: (actor: { memberName?: string }) =>
    actor.memberName ?? 'lead session',
  describeBoardTaskActivityContextLines: (entry: {
    actorContext?: { relation?: string; activeTask?: { taskRef?: { displayId?: string } } };
  }) =>
    entry.actorContext?.relation === 'other_active_task'
      ? [`while working on #${entry.actorContext.activeTask?.taskRef?.displayId ?? 'unknown'}`]
      : [],
}));

vi.mock('@shared/utils/boardTaskActivityLabels', () => ({
  describeBoardTaskActivityLabel: (entry: { action?: { canonicalToolName?: string } }) => {
    switch (entry.action?.canonicalToolName) {
      case 'task_get':
        return 'Viewed task';
      case 'task_start':
        return 'Started work';
      case 'task_add_comment':
        return 'Added a comment';
      default:
        return 'Worked on task';
    }
  },
  formatBoardTaskActivityTaskLabel: (task?: { taskRef?: { displayId?: string } }) =>
    task?.taskRef?.displayId ? `#${task.taskRef.displayId}` : null,
}));

import { TaskActivitySection } from '@renderer/components/team/taskLogs/TaskActivitySection';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

function makeEntry(
  overrides: Partial<BoardTaskActivityEntry> & Pick<BoardTaskActivityEntry, 'id' | 'linkKind'>
): BoardTaskActivityEntry {
  const { id, linkKind, ...rest } = overrides;

  return {
    id,
    timestamp: '2026-04-13T10:33:00.000Z',
    task: {
      locator: {
        ref: 'abc12345',
        refKind: 'display',
      },
      resolution: 'resolved',
      taskRef: {
        taskId: 'task-1',
        displayId: 'abc12345',
        teamName: 'demo',
      },
    },
    linkKind,
    targetRole: 'subject',
    actor: {
      memberName: 'bob',
      role: 'member',
      sessionId: 'session-1',
      agentId: 'agent-1',
      isSidechain: true,
    },
    actorContext: {
      relation: 'same_task',
    },
    source: {
      messageUuid: `${overrides.id}-message`,
      filePath: '/tmp/transcript.jsonl',
      sourceOrder: 1,
      ...(rest.source?.toolUseId ? { toolUseId: rest.source.toolUseId } : {}),
    },
    ...rest,
  };
}

describe('TaskActivitySection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    apiState.getTaskActivity.mockReset();
    apiState.getTaskActivityDetail.mockReset();
    renderabilityState.hasDisplayItems = true;
    renderabilityState.toolName = 'task_add_comment';
    vi.unstubAllGlobals();
  });

  it('hides low-signal execution rows while keeping key task activity in descending time order', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskActivity.mockResolvedValue([
      makeEntry({
        id: 'viewed',
        timestamp: '2026-04-13T10:33:00.000Z',
        linkKind: 'board_action',
        action: {
          canonicalToolName: 'task_get',
          category: 'read',
        },
      }),
      makeEntry({
        id: 'started',
        timestamp: '2026-04-13T10:34:00.000Z',
        linkKind: 'lifecycle',
        action: {
          canonicalToolName: 'task_start',
          category: 'status',
        },
      }),
      makeEntry({
        id: 'worked-1',
        linkKind: 'execution',
      }),
      makeEntry({
        id: 'worked-2',
        linkKind: 'execution',
      }),
    ]);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskActivitySection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('Viewed task');
    expect(host.textContent).toContain('Started work');
    expect(host.textContent).not.toContain('Worked on task');
    expect(host.textContent?.indexOf('Started work')).toBeLessThan(
      host.textContent?.indexOf('Viewed task') ?? Number.POSITIVE_INFINITY
    );

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('shows a task-log-stream hint when only low-signal execution rows exist', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskActivity.mockResolvedValue([
      makeEntry({
        id: 'worked-1',
        linkKind: 'execution',
      }),
    ]);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskActivitySection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('No key task activity was found yet');
    expect(host.textContent).toContain('Task Log Stream');
    expect(host.textContent).not.toContain('Worked on task');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('loads inline detail lazily and renders metadata plus a linked tool card', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskActivity.mockResolvedValue([
      makeEntry({
        id: 'comment-1',
        timestamp: '2026-04-13T10:35:00.000Z',
        linkKind: 'board_action',
        actorContext: {
          relation: 'other_active_task',
          activePhase: 'work',
          activeTask: {
            locator: {
              ref: 'peer12345',
              refKind: 'display',
            },
            resolution: 'resolved',
            taskRef: {
              taskId: 'task-2',
              displayId: 'peer12345',
              teamName: 'demo',
            },
          },
        },
        action: {
          canonicalToolName: 'task_add_comment',
          category: 'comment',
          toolUseId: 'tool-1',
          details: {
            commentId: '42',
          },
        },
        source: {
          messageUuid: 'comment-1-message',
          filePath: '/tmp/transcript.jsonl',
          toolUseId: 'tool-1',
          sourceOrder: 5,
        },
      }),
    ]);
    apiState.getTaskActivityDetail.mockResolvedValue({
      status: 'ok',
      detail: {
        entryId: 'comment-1',
        summaryLabel: 'Added a comment',
        actorLabel: 'bob',
        timestamp: '2026-04-13T10:35:00.000Z',
        contextLines: ['while working on #peer12345'],
        metadataRows: [
          { label: 'Task', value: '#abc12345' },
          { label: 'Tool', value: 'task_add_comment' },
          { label: 'Comment', value: '42' },
        ],
        logDetail: {
          id: 'activity:comment-1',
          chunks: [{ id: 'chunk-1' }] as never,
        },
      },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskActivitySection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    const button = host.querySelector('button');
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushMicrotasks();
    });

    expect(apiState.getTaskActivityDetail).toHaveBeenCalledWith('demo', 'task-a', 'comment-1');
    expect(host.textContent).toContain('Tool');
    expect(host.textContent).toContain('task_add_comment');
    expect(host.textContent).toContain('Comment');
    expect(host.textContent).toContain('42');
    expect(host.textContent).toContain('while working on #peer12345');
    expect(host.querySelector('[data-testid="linked-tool-card"]')?.textContent).toBe(
      'tool:task_add_comment'
    );
    expect(host.textContent?.match(/Added a comment/g)?.length).toBe(1);

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushMicrotasks();
    });

    expect(host.querySelector('[data-testid="linked-tool-card"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('shows metadata-only detail for read activity without embedding a linked tool log', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskActivity.mockResolvedValue([
      makeEntry({
        id: 'view-1',
        timestamp: '2026-04-13T10:36:00.000Z',
        linkKind: 'board_action',
        action: {
          canonicalToolName: 'task_get',
          category: 'read',
          toolUseId: 'tool-read',
        },
        source: {
          messageUuid: 'view-1-message',
          filePath: '/tmp/transcript.jsonl',
          toolUseId: 'tool-read',
          sourceOrder: 6,
        },
      }),
    ]);
    apiState.getTaskActivityDetail.mockResolvedValue({
      status: 'ok',
      detail: {
        entryId: 'view-1',
        summaryLabel: 'Viewed task',
        actorLabel: 'bob',
        timestamp: '2026-04-13T10:36:00.000Z',
        contextLines: ['without an active task scope'],
        metadataRows: [
          { label: 'Task', value: '#abc12345' },
          { label: 'Tool', value: 'task_get' },
        ],
      },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskActivitySection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    const button = host.querySelector('button');
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('Viewed task');
    expect(host.textContent).toContain('task_get');
    expect(host.querySelector('[data-testid="linked-tool-card"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('shows a linked tool card for lifecycle activity when shared pipeline returns a renderable tool', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    renderabilityState.toolName = 'task_start';
    apiState.getTaskActivity.mockResolvedValue([
      makeEntry({
        id: 'start-live',
        timestamp: '2026-04-13T10:37:00.000Z',
        linkKind: 'lifecycle',
        action: {
          canonicalToolName: 'task_start',
          category: 'status',
          toolUseId: 'tool-start',
        },
        source: {
          messageUuid: 'start-live-message',
          filePath: '/tmp/transcript.jsonl',
          toolUseId: 'tool-start',
          sourceOrder: 7,
        },
      }),
    ]);
    apiState.getTaskActivityDetail.mockResolvedValue({
      status: 'ok',
      detail: {
        entryId: 'start-live',
        summaryLabel: 'Started work',
        actorLabel: 'bob',
        timestamp: '2026-04-13T10:37:00.000Z',
        contextLines: ['without an active task scope'],
        metadataRows: [
          { label: 'Task', value: '#abc12345' },
          { label: 'Tool', value: 'task_start' },
          { label: 'Scope', value: 'idle' },
        ],
        logDetail: {
          id: 'activity:start-live',
          chunks: [{ id: 'chunk-start' }] as never,
        },
      },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskActivitySection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    const button = host.querySelector('button');
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('task_start');
    expect(host.querySelector('[data-testid="linked-tool-card"]')?.textContent).toBe(
      'tool:task_start'
    );

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('hides embedded linked tool detail when the shared execution-log pipeline finds no display items', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    renderabilityState.hasDisplayItems = false;
    apiState.getTaskActivity.mockResolvedValue([
      makeEntry({
        id: 'comment-quiet',
        timestamp: '2026-04-13T10:38:00.000Z',
        linkKind: 'board_action',
        action: {
          canonicalToolName: 'task_add_comment',
          category: 'comment',
          toolUseId: 'tool-quiet',
          details: {
            commentId: '7',
          },
        },
        source: {
          messageUuid: 'comment-quiet-message',
          filePath: '/tmp/transcript.jsonl',
          toolUseId: 'tool-quiet',
          sourceOrder: 8,
        },
      }),
    ]);
    apiState.getTaskActivityDetail.mockResolvedValue({
      status: 'ok',
      detail: {
        entryId: 'comment-quiet',
        summaryLabel: 'Added a comment',
        actorLabel: 'bob',
        timestamp: '2026-04-13T10:38:00.000Z',
        contextLines: ['without an active task scope'],
        metadataRows: [
          { label: 'Task', value: '#abc12345' },
          { label: 'Tool', value: 'task_add_comment' },
          { label: 'Comment', value: '7' },
        ],
        logDetail: {
          id: 'activity:comment-quiet',
          chunks: [{ id: 'chunk-quiet' }] as never,
        },
      },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskActivitySection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    const button = host.querySelector('button');
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('task_add_comment');
    expect(host.querySelector('[data-testid="linked-tool-card"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('keeps lifecycle activity metadata-only when the focused detail has no linked tool execution', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskActivity.mockResolvedValue([
      makeEntry({
        id: 'start-1',
        timestamp: '2026-04-13T10:37:00.000Z',
        linkKind: 'lifecycle',
        action: {
          canonicalToolName: 'task_start',
          category: 'status',
          toolUseId: 'tool-start',
        },
        source: {
          messageUuid: 'start-1-message',
          filePath: '/tmp/transcript.jsonl',
          toolUseId: 'tool-start',
          sourceOrder: 7,
        },
      }),
    ]);
    apiState.getTaskActivityDetail.mockResolvedValue({
      status: 'ok',
      detail: {
        entryId: 'start-1',
        summaryLabel: 'Started work',
        actorLabel: 'bob',
        timestamp: '2026-04-13T10:37:00.000Z',
        contextLines: ['without an active task scope'],
        metadataRows: [
          { label: 'Task', value: '#abc12345' },
          { label: 'Tool', value: 'task_start' },
          { label: 'Scope', value: 'idle' },
        ],
      },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskActivitySection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    const button = host.querySelector('button');
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('Started work');
    expect(host.textContent).toContain('task_start');
    expect(host.querySelector('[data-testid="linked-tool-card"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});

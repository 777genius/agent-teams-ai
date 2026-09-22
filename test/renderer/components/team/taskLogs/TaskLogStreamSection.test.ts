import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TeamChangeEvent } from '../../../../../src/shared/types';
import type { BoardTaskLogStreamResponse } from '../../../../../src/shared/types';

const apiState = {
  getTaskLogStream: vi.fn<
    (teamName: string, taskId: string) => Promise<BoardTaskLogStreamResponse>
  >(),
  onTeamChange: vi.fn<(callback: (event: unknown, data: TeamChangeEvent) => void) => () => void>(),
  setTaskLogStreamTracking: vi.fn<(teamName: string, enabled: boolean) => Promise<void>>(),
};

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getTaskLogStream: (...args: Parameters<typeof apiState.getTaskLogStream>) =>
        apiState.getTaskLogStream(...args),
      onTeamChange: (...args: Parameters<typeof apiState.onTeamChange>) =>
        apiState.onTeamChange(...args),
      setTaskLogStreamTracking: (...args: Parameters<typeof apiState.setTaskLogStreamTracking>) =>
        apiState.setTaskLogStreamTracking(...args),
    },
  },
}));

vi.mock('@renderer/components/team/members/MemberExecutionLog', () => ({
  MemberExecutionLog: ({
    memberName,
    chunks,
  }: {
    memberName?: string;
    chunks: { id: string }[];
  }) => {
    const [expanded, setExpanded] = React.useState(true);
    return React.createElement(
      'div',
      {
        'data-testid': 'member-execution-log',
        'data-expanded': expanded ? 'true' : 'false',
      },
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': `member-execution-log-toggle:${memberName ?? 'lead'}`,
          onClick: () => setExpanded((prev) => !prev),
        },
        `${memberName ?? 'lead'}:${chunks.length}`
      )
    );
  },
}));

import { TaskLogStreamSection } from '@renderer/components/team/taskLogs/TaskLogStreamSection';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

function buildParticipant(key: string, label: string) {
  return {
    key,
    label,
    role: 'member' as const,
    isLead: false,
    isSidechain: true,
  };
}

function buildSegment(args: {
  id: string;
  participantKey: string;
  memberName: string;
  startTimestamp: string;
  endTimestamp: string;
  chunkIds?: string[];
}) {
  const chunkIds = args.chunkIds ?? [`chunk-${args.id}`];
  return {
    id: args.id,
    participantKey: args.participantKey,
    actor: {
      memberName: args.memberName,
      role: 'member' as const,
      sessionId: `${args.memberName}-session-${args.id}`,
      agentId: `${args.memberName}-agent`,
      isSidechain: true,
    },
    startTimestamp: args.startTimestamp,
    endTimestamp: args.endTimestamp,
    chunks: chunkIds.map((chunkId) => ({
      id: chunkId,
      chunkType: 'user',
      rawMessages: [],
    })) as never,
  };
}

describe('TaskLogStreamSection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    apiState.getTaskLogStream.mockReset();
    apiState.onTeamChange.mockReset();
    apiState.setTaskLogStreamTracking.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders empty state when the stream is absent', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskLogStream.mockResolvedValueOnce({
      participants: [],
      defaultFilter: 'all',
      segments: [],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskLogStreamSection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('Task Log Stream');
    expect(host.textContent).toContain('No task log stream yet');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('shows participant chips and filters the visible segments', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskLogStream.mockResolvedValueOnce({
      participants: [
        {
          key: 'member:tom',
          label: 'tom',
          role: 'member',
          isLead: false,
          isSidechain: true,
        },
        {
          key: 'member:alice',
          label: 'alice',
          role: 'member',
          isLead: false,
          isSidechain: true,
        },
      ],
      defaultFilter: 'all',
      segments: [
        {
          id: 'segment-tom-1',
          participantKey: 'member:tom',
          actor: {
            memberName: 'tom',
            role: 'member',
            sessionId: 'session-tom-1',
            agentId: 'agent-tom',
            isSidechain: true,
          },
          startTimestamp: '2026-04-12T16:00:00.000Z',
          endTimestamp: '2026-04-12T16:01:00.000Z',
          chunks: [{ id: 'chunk-tom-1', chunkType: 'user', rawMessages: [] }] as never,
        },
        {
          id: 'segment-alice-1',
          participantKey: 'member:alice',
          actor: {
            memberName: 'alice',
            role: 'member',
            sessionId: 'session-alice-1',
            agentId: 'agent-alice',
            isSidechain: true,
          },
          startTimestamp: '2026-04-12T16:02:00.000Z',
          endTimestamp: '2026-04-12T16:03:00.000Z',
          chunks: [{ id: 'chunk-alice-1', chunkType: 'user', rawMessages: [] }] as never,
        },
        {
          id: 'segment-tom-2',
          participantKey: 'member:tom',
          actor: {
            memberName: 'tom',
            role: 'member',
            sessionId: 'session-tom-2',
            agentId: 'agent-tom',
            isSidechain: true,
          },
          startTimestamp: '2026-04-12T16:04:00.000Z',
          endTimestamp: '2026-04-12T16:05:00.000Z',
          chunks: [{ id: 'chunk-tom-2', chunkType: 'user', rawMessages: [] }] as never,
        },
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskLogStreamSection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('All');
    expect(host.textContent).toContain('tom');
    expect(host.textContent).toContain('alice');
    expect(host.querySelectorAll('[data-testid="member-execution-log"]')).toHaveLength(3);

    const buttons = [...host.querySelectorAll('button')];
    const tomButton = buttons.find((button) => button.textContent?.trim() === 'tom');
    expect(tomButton).toBeDefined();

    await act(async () => {
      tomButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushMicrotasks();
    });

    const logs = [...host.querySelectorAll('[data-testid="member-execution-log"]')].map(
      (node) => node.textContent
    );
    expect(logs).toEqual(['tom:1', 'tom:1']);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('describes OpenCode runtime fallback when the stream source is projected from runtime logs', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskLogStream.mockResolvedValueOnce({
      participants: [buildParticipant('member:alice', 'alice')],
      defaultFilter: 'member:alice',
      segments: [
        buildSegment({
          id: 'segment-alice-1',
          participantKey: 'member:alice',
          memberName: 'alice',
          startTimestamp: '2026-04-21T10:00:00.000Z',
          endTimestamp: '2026-04-21T10:01:00.000Z',
        }),
      ],
      source: 'opencode_runtime_fallback',
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskLogStreamSection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('Task-scoped OpenCode runtime logs projected');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('describes OpenCode marker-based fallback when runtime projection matched task tools', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskLogStream.mockResolvedValueOnce({
      participants: [buildParticipant('member:alice', 'alice')],
      defaultFilter: 'member:alice',
      segments: [
        buildSegment({
          id: 'segment-alice-marker',
          participantKey: 'member:alice',
          memberName: 'alice',
          startTimestamp: '2026-04-21T10:00:00.000Z',
          endTimestamp: '2026-04-21T10:01:00.000Z',
        }),
      ],
      source: 'opencode_runtime_fallback',
      runtimeProjection: {
        provider: 'opencode',
        mode: 'heuristic',
        attributionRecordCount: 0,
        projectedMessageCount: 2,
        fallbackReason: 'task_tool_markers',
        markerMatchCount: 1,
        markerSpanCount: 2,
      },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskLogStreamSection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('matched task tool markers');
    expect(host.textContent).toContain('across 2 spans');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('honors a participant default filter from the stream response', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.onTeamChange.mockImplementation(() => () => undefined);
    apiState.getTaskLogStream.mockResolvedValueOnce({
      participants: [
        {
          key: 'member:tom',
          label: 'tom',
          role: 'member',
          isLead: false,
          isSidechain: false,
        },
      ],
      defaultFilter: 'member:tom',
      segments: [
        {
          id: 'segment-tom-1',
          participantKey: 'member:tom',
          actor: {
            memberName: 'tom',
            role: 'lead',
            sessionId: 'session-tom-1',
            isSidechain: false,
          },
          startTimestamp: '2026-04-12T16:00:00.000Z',
          endTimestamp: '2026-04-12T16:01:00.000Z',
          chunks: [{ id: 'chunk-tom-1', chunkType: 'ai', rawMessages: [] }] as never,
        },
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskLogStreamSection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    expect(host.querySelectorAll('[data-testid="member-execution-log"]')).toHaveLength(1);
    expect(host.textContent).toContain('tom:1');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('live-refreshes on matching task-log changes and preserves the selected participant filter', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();

    let handler: ((event: unknown, data: TeamChangeEvent) => void) | null = null;
    apiState.onTeamChange.mockImplementation((callback) => {
      handler = callback;
      return () => {
        handler = null;
      };
    });

    apiState.getTaskLogStream
      .mockResolvedValueOnce({
        participants: [
          buildParticipant('member:tom', 'tom'),
          buildParticipant('member:alice', 'alice'),
        ],
        defaultFilter: 'all',
        segments: [
          buildSegment({
            id: 'tom-1',
            participantKey: 'member:tom',
            memberName: 'tom',
            startTimestamp: '2026-04-12T16:00:00.000Z',
            endTimestamp: '2026-04-12T16:01:00.000Z',
          }),
          buildSegment({
            id: 'alice-1',
            participantKey: 'member:alice',
            memberName: 'alice',
            startTimestamp: '2026-04-12T16:02:00.000Z',
            endTimestamp: '2026-04-12T16:03:00.000Z',
          }),
        ],
      })
      .mockResolvedValueOnce({
        participants: [
          buildParticipant('member:tom', 'tom'),
          buildParticipant('member:alice', 'alice'),
        ],
        defaultFilter: 'all',
        segments: [
          buildSegment({
            id: 'tom-1',
            participantKey: 'member:tom',
            memberName: 'tom',
            startTimestamp: '2026-04-12T16:00:00.000Z',
            endTimestamp: '2026-04-12T16:01:00.000Z',
          }),
          buildSegment({
            id: 'alice-1',
            participantKey: 'member:alice',
            memberName: 'alice',
            startTimestamp: '2026-04-12T16:02:00.000Z',
            endTimestamp: '2026-04-12T16:03:00.000Z',
          }),
          buildSegment({
            id: 'tom-2',
            participantKey: 'member:tom',
            memberName: 'tom',
            startTimestamp: '2026-04-12T16:04:00.000Z',
            endTimestamp: '2026-04-12T16:05:00.000Z',
          }),
        ],
      })
      .mockResolvedValueOnce({
        participants: [
          buildParticipant('member:tom', 'tom'),
          buildParticipant('member:alice', 'alice'),
        ],
        defaultFilter: 'all',
        segments: [
          buildSegment({
            id: 'tom-1',
            participantKey: 'member:tom',
            memberName: 'tom',
            startTimestamp: '2026-04-12T16:00:00.000Z',
            endTimestamp: '2026-04-12T16:01:00.000Z',
          }),
          buildSegment({
            id: 'tom-2',
            participantKey: 'member:tom',
            memberName: 'tom',
            startTimestamp: '2026-04-12T16:04:00.000Z',
            endTimestamp: '2026-04-12T16:05:00.000Z',
          }),
        ],
      });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskLogStreamSection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    const tomButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'tom'
    );
    expect(tomButton).toBeDefined();

    await act(async () => {
      tomButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushMicrotasks();
    });

    expect(
      [...host.querySelectorAll('[data-testid="member-execution-log"]')].map((node) => node.textContent)
    ).toEqual(['tom:1']);

    expect(handler).toBeTypeOf('function');

    await act(async () => {
      handler?.(null, {
        teamName: 'other-team',
        type: 'task-log-change',
        taskId: 'task-a',
        taskSignalKind: 'log',
      });
      vi.advanceTimersByTime(400);
      await flushMicrotasks();
    });

    expect(apiState.getTaskLogStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      handler?.(null, {
        teamName: 'demo',
        type: 'task-log-change',
        taskId: 'task-b',
        taskSignalKind: 'log',
      });
      vi.advanceTimersByTime(400);
      await flushMicrotasks();
    });

    expect(apiState.getTaskLogStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      handler?.(null, {
        teamName: 'demo',
        type: 'task-log-change',
        taskId: 'task-a',
        taskSignalKind: 'change',
      });
      vi.advanceTimersByTime(400);
      await flushMicrotasks();
    });

    expect(apiState.getTaskLogStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      handler?.(null, {
        teamName: 'demo',
        type: 'task-log-change',
        taskId: 'task-a',
        taskSignalKind: 'log',
      });
      vi.advanceTimersByTime(400);
      await flushMicrotasks();
    });

    expect(apiState.getTaskLogStream).toHaveBeenCalledTimes(2);
    expect(
      [...host.querySelectorAll('[data-testid="member-execution-log"]')].map((node) => node.textContent)
    ).toEqual(['tom:1', 'tom:1']);

    await act(async () => {
      handler?.(null, { teamName: 'demo', type: 'log-source-change' });
      vi.advanceTimersByTime(400);
      await flushMicrotasks();
    });

    expect(apiState.getTaskLogStream).toHaveBeenCalledTimes(3);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('preserves expanded state when a live refresh extends the current segment tail', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();

    let handler: ((event: unknown, data: TeamChangeEvent) => void) | null = null;
    apiState.onTeamChange.mockImplementation((callback) => {
      handler = callback;
      return () => {
        handler = null;
      };
    });

    apiState.getTaskLogStream
      .mockResolvedValueOnce({
        participants: [buildParticipant('member:alice', 'alice')],
        defaultFilter: 'all',
        segments: [
          buildSegment({
            id: 'member:alice:chunk-start:chunk-start',
            participantKey: 'member:alice',
            memberName: 'alice',
            startTimestamp: '2026-04-24T10:00:00.000Z',
            endTimestamp: '2026-04-24T10:01:00.000Z',
            chunkIds: ['chunk-start'],
          }),
        ],
      })
      .mockResolvedValueOnce({
        participants: [buildParticipant('member:alice', 'alice')],
        defaultFilter: 'all',
        segments: [
          buildSegment({
            id: 'member:alice:chunk-start:chunk-next',
            participantKey: 'member:alice',
            memberName: 'alice',
            startTimestamp: '2026-04-24T10:00:00.000Z',
            endTimestamp: '2026-04-24T10:02:00.000Z',
            chunkIds: ['chunk-start', 'chunk-next'],
          }),
        ],
      });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskLogStreamSection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    const logNodeBefore = host.querySelector('[data-testid="member-execution-log"]');
    const toggle = host.querySelector(
      '[data-testid="member-execution-log-toggle:alice"]'
    ) as HTMLButtonElement | null;
    expect(logNodeBefore?.getAttribute('data-expanded')).toBe('true');
    expect(toggle).not.toBeNull();

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushMicrotasks();
    });

    expect(
      host.querySelector('[data-testid="member-execution-log"]')?.getAttribute('data-expanded')
    ).toBe('false');

    await act(async () => {
      handler?.(null, {
        teamName: 'demo',
        type: 'task-log-change',
        taskId: 'task-a',
        taskSignalKind: 'log',
      });
      vi.advanceTimersByTime(400);
      await flushMicrotasks();
    });

    const logNodeAfter = host.querySelector('[data-testid="member-execution-log"]');
    expect(apiState.getTaskLogStream).toHaveBeenCalledTimes(2);
    expect(logNodeAfter?.getAttribute('data-expanded')).toBe('false');
    expect(logNodeAfter?.textContent).toBe('alice:2');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('does not subscribe to live refresh when live mode is disabled', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    apiState.onTeamChange.mockImplementation(() => () => undefined);
    apiState.getTaskLogStream.mockResolvedValueOnce({
      participants: [buildParticipant('member:tom', 'tom')],
      defaultFilter: 'all',
      segments: [
        buildSegment({
          id: 'tom-1',
          participantKey: 'member:tom',
          memberName: 'tom',
          startTimestamp: '2026-04-12T16:00:00.000Z',
          endTimestamp: '2026-04-12T16:01:00.000Z',
        }),
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TaskLogStreamSection, {
          teamName: 'demo',
          taskId: 'task-a',
          liveEnabled: false,
        })
      );
      await flushMicrotasks();
    });

    expect(apiState.getTaskLogStream).toHaveBeenCalledTimes(1);
    expect(apiState.onTeamChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('revalidates once when the task leaves in-progress state', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    apiState.getTaskLogStream
      .mockResolvedValueOnce({
        participants: [buildParticipant('member:tom', 'tom')],
        defaultFilter: 'all',
        segments: [
          buildSegment({
            id: 'tom-1',
            participantKey: 'member:tom',
            memberName: 'tom',
            startTimestamp: '2026-04-12T16:00:00.000Z',
            endTimestamp: '2026-04-12T16:01:00.000Z',
          }),
        ],
      })
      .mockResolvedValueOnce({
        participants: [buildParticipant('member:tom', 'tom')],
        defaultFilter: 'all',
        segments: [
          buildSegment({
            id: 'tom-1',
            participantKey: 'member:tom',
            memberName: 'tom',
            startTimestamp: '2026-04-12T16:00:00.000Z',
            endTimestamp: '2026-04-12T16:01:00.000Z',
          }),
          buildSegment({
            id: 'tom-2',
            participantKey: 'member:tom',
            memberName: 'tom',
            startTimestamp: '2026-04-12T16:02:00.000Z',
            endTimestamp: '2026-04-12T16:03:00.000Z',
          }),
        ],
      });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TaskLogStreamSection, {
          teamName: 'demo',
          taskId: 'task-a',
          taskStatus: 'in_progress',
          liveEnabled: true,
        })
      );
      await flushMicrotasks();
    });

    expect(apiState.getTaskLogStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        React.createElement(TaskLogStreamSection, {
          teamName: 'demo',
          taskId: 'task-a',
          taskStatus: 'completed',
          liveEnabled: false,
        })
      );
      await flushMicrotasks();
    });

    expect(apiState.getTaskLogStream).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('[data-testid="member-execution-log"]')).toHaveLength(2);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});

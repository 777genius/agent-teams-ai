import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BoardTaskLogStreamResponse } from '../../../../../src/shared/types';

const apiState = {
  getTaskLogStream: vi.fn<
    (teamName: string, taskId: string) => Promise<BoardTaskLogStreamResponse>
  >(),
};

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getTaskLogStream: (...args: Parameters<typeof apiState.getTaskLogStream>) =>
        apiState.getTaskLogStream(...args),
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
  }) =>
    React.createElement(
      'div',
      { 'data-testid': 'member-execution-log' },
      `${memberName ?? 'lead'}:${chunks.length}`
    ),
}));

import { TaskLogStreamSection } from '@renderer/components/team/taskLogs/TaskLogStreamSection';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

describe('TaskLogStreamSection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    apiState.getTaskLogStream.mockReset();
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

  it('honors a participant default filter from the stream response', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
});

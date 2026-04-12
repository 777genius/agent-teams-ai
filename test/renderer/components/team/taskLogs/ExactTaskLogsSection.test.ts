import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BoardTaskExactLogDetailResult,
  BoardTaskExactLogSummariesResponse,
} from '../../../../../src/shared/types';

const apiState = {
  getTaskExactLogSummaries: vi.fn<
    (teamName: string, taskId: string) => Promise<BoardTaskExactLogSummariesResponse>
  >(),
  getTaskExactLogDetail: vi.fn<
    (
      teamName: string,
      taskId: string,
      exactLogId: string,
      expectedSourceGeneration: string
    ) => Promise<BoardTaskExactLogDetailResult>
  >(),
};

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getTaskExactLogSummaries: (...args: Parameters<typeof apiState.getTaskExactLogSummaries>) =>
        apiState.getTaskExactLogSummaries(...args),
      getTaskExactLogDetail: (...args: Parameters<typeof apiState.getTaskExactLogDetail>) =>
        apiState.getTaskExactLogDetail(...args),
    },
  },
}));

vi.mock('@renderer/components/team/members/MemberExecutionLog', () => ({
  MemberExecutionLog: ({ memberName }: { memberName?: string }) =>
    React.createElement('div', { 'data-testid': 'member-execution-log' }, memberName ?? 'no-name'),
}));

import { ExactTaskLogsSection } from '@renderer/components/team/taskLogs/ExactTaskLogsSection';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

describe('ExactTaskLogsSection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    apiState.getTaskExactLogSummaries.mockReset();
    apiState.getTaskExactLogDetail.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders empty state when exact summaries are absent', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskExactLogSummaries.mockResolvedValueOnce({ items: [] });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ExactTaskLogsSection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('Exact Task Logs');
    expect(host.textContent).toContain('No exact task logs yet');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('renders loading state while summaries are still pending', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolveSummaries: ((value: BoardTaskExactLogSummariesResponse) => void) | null = null;
    apiState.getTaskExactLogSummaries.mockImplementationOnce(
      () =>
        new Promise<BoardTaskExactLogSummariesResponse>((resolve) => {
          resolveSummaries = resolve;
        })
    );

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ExactTaskLogsSection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('Loading exact task logs');

    await act(async () => {
      resolveSummaries?.({ items: [] });
      await flushMicrotasks();
    });

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('renders error state when summaries fail to load', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskExactLogSummaries.mockRejectedValueOnce(new Error('boom'));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ExactTaskLogsSection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('boom');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('reloads summaries on stale detail and then renders exact detail', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskExactLogSummaries
      .mockResolvedValueOnce({
        items: [
          {
            id: 'tool:/tmp/task.jsonl:tool-1',
            timestamp: '2026-04-12T18:00:00.000Z',
            actor: {
              memberName: 'alice',
              role: 'member',
              sessionId: 'session-1',
              agentId: 'agent-1',
              isSidechain: true,
            },
            source: {
              filePath: '/tmp/task.jsonl',
              messageUuid: 'assistant-1',
              toolUseId: 'tool-1',
              sourceOrder: 1,
            },
            anchorKind: 'tool',
            actionLabel: 'Added a comment',
            actionCategory: 'comment',
            canonicalToolName: 'task_add_comment',
            linkKinds: ['board_action'],
            canLoadDetail: true,
            sourceGeneration: 'gen-1',
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'tool:/tmp/task.jsonl:tool-1',
            timestamp: '2026-04-12T18:00:00.000Z',
            actor: {
              memberName: 'alice',
              role: 'member',
              sessionId: 'session-1',
              agentId: 'agent-1',
              isSidechain: true,
            },
            source: {
              filePath: '/tmp/task.jsonl',
              messageUuid: 'assistant-1',
              toolUseId: 'tool-1',
              sourceOrder: 1,
            },
            anchorKind: 'tool',
            actionLabel: 'Added a comment',
            actionCategory: 'comment',
            canonicalToolName: 'task_add_comment',
            linkKinds: ['board_action'],
            canLoadDetail: true,
            sourceGeneration: 'gen-2',
          },
        ],
      });
    apiState.getTaskExactLogDetail
      .mockResolvedValueOnce({ status: 'stale' })
      .mockResolvedValueOnce({
        status: 'ok',
        detail: {
          id: 'tool:/tmp/task.jsonl:tool-1',
          chunks: [],
        },
      });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ExactTaskLogsSection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    const button = host.querySelector('button');
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    await vi.waitFor(() => {
      expect(apiState.getTaskExactLogSummaries).toHaveBeenCalledTimes(2);
      expect(apiState.getTaskExactLogDetail).toHaveBeenNthCalledWith(
        1,
        'demo',
        'task-a',
        'tool:/tmp/task.jsonl:tool-1',
        'gen-1'
      );
      expect(apiState.getTaskExactLogDetail).toHaveBeenNthCalledWith(
        2,
        'demo',
        'task-a',
        'tool:/tmp/task.jsonl:tool-1',
        'gen-2'
      );
      expect(host.querySelector('[data-testid=\"member-execution-log\"]')?.textContent).toBe('alice');
    });

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('renders descriptive action labels and lead-session fallback actor text', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.getTaskExactLogSummaries.mockResolvedValueOnce({
      items: [
        {
          id: 'tool:/tmp/task.jsonl:tool-1',
          timestamp: '2026-04-12T18:00:00.000Z',
          actor: {
            role: 'lead',
            sessionId: 'lead-session-1',
            isSidechain: false,
          },
          source: {
            filePath: '/tmp/task.jsonl',
            messageUuid: 'assistant-1',
            toolUseId: 'tool-1',
            sourceOrder: 1,
          },
          anchorKind: 'tool',
          actionLabel: 'Requested review',
          actionCategory: 'review',
          canonicalToolName: 'review_request',
          linkKinds: ['board_action'],
          canLoadDetail: false,
        },
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ExactTaskLogsSection, { teamName: 'demo', taskId: 'task-a' }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('lead session');
    expect(host.textContent).toContain('Requested review');
    expect(host.textContent).toContain('tool');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});

import { readFile } from 'fs/promises';
import path from 'path';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeTaskLogStreamSource } from '../../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogStreamSource';
import { BoardTaskExactLogChunkBuilder } from '../../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogChunkBuilder';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';

import type { OpenCodeRuntimeTranscriptResponse } from '../../../../../src/main/services/runtime/ClaudeMultimodelBridgeService';
import type { BoardTaskLogStreamResponse, TeamTask } from '../../../../../src/shared/types';

const TEAM_NAME = 'relay-works-10';
const TASK_ID = '0b3a0624-5d66-4067-848e-5a74a1720c0d';
const COORDINATION_TASK_ID = 'b5534868-0901-4c9e-9296-2b6e2059a08f';
const FIXTURE_PATH = path.resolve(
  process.cwd(),
  'test/fixtures/team/opencode/relay-works-10-jack-projection-transcript.json'
);

const apiState = {
  getTaskLogStream:
    vi.fn<(teamName: string, taskId: string) => Promise<BoardTaskLogStreamResponse>>(),
  onTeamChange: vi.fn<(callback: (event: unknown, data: unknown) => void) => () => void>(),
};

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getTaskLogStream: (...args: Parameters<typeof apiState.getTaskLogStream>) =>
        apiState.getTaskLogStream(...args),
      onTeamChange: (...args: Parameters<typeof apiState.onTeamChange>) =>
        apiState.onTeamChange(...args),
    },
  },
}));

import { TaskLogStreamSection } from '@renderer/components/team/taskLogs/TaskLogStreamSection';

const RELAY_WORKS_10_TASK: TeamTask = {
  id: TASK_ID,
  displayId: '0b3a0624',
  subject: 'Define calculator arithmetic behavior',
  owner: 'jack',
  status: 'completed',
  createdAt: '2026-04-24T20:29:03.133Z',
  updatedAt: '2026-04-24T20:29:34.157Z',
  workIntervals: [
    {
      startedAt: '2026-04-24T20:29:03.133Z',
      completedAt: '2026-04-24T20:29:34.157Z',
    },
  ],
};

const RELAY_WORKS_10_COORDINATION_TASK: TeamTask = {
  id: COORDINATION_TASK_ID,
  displayId: 'b5534868',
  subject: 'Split calculator implementation work',
  owner: 'jack',
  status: 'in_progress',
  createdAt: '2026-04-24T20:28:58.000Z',
  updatedAt: '2026-04-24T20:31:21.876Z',
  workIntervals: [
    {
      startedAt: '2026-04-24T20:28:58.000Z',
    },
  ],
};

async function loadFixtureTranscript(): Promise<
  NonNullable<OpenCodeRuntimeTranscriptResponse['transcript']>
> {
  const parsed = JSON.parse(
    await readFile(FIXTURE_PATH, 'utf8')
  ) as OpenCodeRuntimeTranscriptResponse;
  if (parsed.providerId !== 'opencode' || !parsed.transcript) {
    throw new Error('Invalid OpenCode transcript fixture');
  }
  return parsed.transcript;
}

async function buildFixtureStream(
  task: TeamTask = RELAY_WORKS_10_TASK
): Promise<BoardTaskLogStreamResponse> {
  const transcript = await loadFixtureTranscript();
  const source = new OpenCodeTaskLogStreamSource(
    {
      getOpenCodeTranscript: vi.fn(async () => transcript),
    } as never,
    { resolve: async () => '/tmp/agent_teams_orchestrator' },
    {
      getTasks: vi.fn(async () => [task]),
      getDeletedTasks: vi.fn(async () => []),
    } as never,
    new BoardTaskExactLogChunkBuilder(),
    { readTaskRecords: vi.fn(async () => []) }
  );
  const stream = await source.getTaskLogStream(TEAM_NAME, task.id);
  if (!stream) {
    throw new Error('Expected OpenCode fixture stream');
  }
  return stream;
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

describe('TaskLogStreamSection OpenCode real fixture e2e', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    apiState.getTaskLogStream.mockReset();
    apiState.onTeamChange.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders real OpenCode task activity through the UI log stream', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.onTeamChange.mockImplementation(() => () => undefined);
    apiState.getTaskLogStream.mockResolvedValueOnce(await buildFixtureStream());

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TaskLogStreamSection, {
            teamName: TEAM_NAME,
            taskId: TASK_ID,
            liveEnabled: false,
          })
        )
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const text = host.textContent ?? '';
    expect(text).toContain('Task Log Stream');
    expect(text).toContain('matched task tool markers');
    expect(text).toContain('Agent');
    expect(text).toContain('Calculator behavior');
    expect(text).toContain('Задача #0b3a0624 завершена');
    expect(text).not.toContain('Keyboard handlers added');
    expect(text).not.toContain('Logic smoke check');
    expect(text).not.toContain('#00000000');
    expect(text).not.toContain('SendMessage');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('renders real OpenCode native tool rows when the task stream includes them', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiState.onTeamChange.mockImplementation(() => () => undefined);
    apiState.getTaskLogStream.mockResolvedValueOnce(
      await buildFixtureStream(RELAY_WORKS_10_COORDINATION_TASK)
    );

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TaskLogStreamSection, {
            teamName: TEAM_NAME,
            taskId: COORDINATION_TASK_ID,
            liveEnabled: false,
          })
        )
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const text = host.textContent ?? '';
    expect(text).toContain('Task Log Stream');
    expect(text).toContain('read');
    expect(text).toContain('bash');
    expect(text).toContain('Разбил работу на мелкие задачи');
    expect(text).not.toContain('SendMessage');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});

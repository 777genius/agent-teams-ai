import * as os from 'os';
import * as path from 'path';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BoardTaskLogDiagnosticsService } from '../../../../../src/main/services/team/taskLogs/diagnostics/BoardTaskLogDiagnosticsService';
import { BoardTaskLogStreamService } from '../../../../../src/main/services/team/taskLogs/stream/BoardTaskLogStreamService';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import { setClaudeBasePathOverride } from '../../../../../src/main/utils/pathDecoder';

const LIVE_TEAM = process.env.LIVE_TASK_LOG_TEAM?.trim();
const LIVE_TASK = process.env.LIVE_TASK_LOG_TASK?.trim();
const LIVE_CLAUDE_BASE =
  process.env.LIVE_TASK_LOG_CLAUDE_BASE?.trim() || path.join(os.homedir(), '.claude');
const EXPECT_NO_EMPTY_PAYLOADS =
  process.env.LIVE_TASK_LOG_EXPECT_NO_EMPTY_PAYLOADS === '1';
const EXPECT_VISIBLE_TOOLS = (process.env.LIVE_TASK_LOG_EXPECT_VISIBLE_TOOLS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const describeLive =
  LIVE_TEAM && LIVE_TASK && LIVE_CLAUDE_BASE ? describe : describe.skip;

const apiState = {
  getTaskLogStream: vi.fn(),
};

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getTaskLogStream: (...args: Parameters<typeof apiState.getTaskLogStream>) =>
        apiState.getTaskLogStream(...args),
    },
  },
}));

import { TaskLogStreamSection } from '@renderer/components/team/taskLogs/TaskLogStreamSection';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

describeLive('TaskLogStreamSection live smoke', () => {
  beforeAll(() => {
    setClaudeBasePathOverride(LIVE_CLAUDE_BASE);
  });

  afterAll(() => {
    setClaudeBasePathOverride(null);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    apiState.getTaskLogStream.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders the current live task log stream without empty payload placeholders', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const diagnosticsService = new BoardTaskLogDiagnosticsService();
    const streamService = new BoardTaskLogStreamService();
    const report = await diagnosticsService.diagnose(LIVE_TEAM!, LIVE_TASK!);
    const stream = await streamService.getTaskLogStream(LIVE_TEAM!, report.task.taskId);

    apiState.getTaskLogStream.mockResolvedValueOnce(stream);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TaskLogStreamSection, {
            teamName: LIVE_TEAM!,
            taskId: report.task.taskId,
          }),
        ),
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('Task Log Stream');
    expect(host.textContent).not.toContain('Loading task log stream');
    expect(host.textContent).not.toContain('[]');

    if (EXPECT_NO_EMPTY_PAYLOADS) {
      expect(report.stream.emptyPayloadExamples).toHaveLength(0);
    }

    for (const toolName of EXPECT_VISIBLE_TOOLS) {
      expect(host.textContent).toContain(toolName);
    }

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});

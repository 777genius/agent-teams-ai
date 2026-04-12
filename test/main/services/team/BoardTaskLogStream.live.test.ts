import * as os from 'os';
import * as path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BoardTaskLogStreamService } from '../../../../src/main/services/team/taskLogs/stream/BoardTaskLogStreamService';
import { BoardTaskLogDiagnosticsService } from '../../../../src/main/services/team/taskLogs/diagnostics/BoardTaskLogDiagnosticsService';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

const LIVE_TEAM = process.env.LIVE_TASK_LOG_TEAM?.trim();
const LIVE_TASK = process.env.LIVE_TASK_LOG_TASK?.trim();
const LIVE_CLAUDE_BASE =
  process.env.LIVE_TASK_LOG_CLAUDE_BASE?.trim() || path.join(os.homedir(), '.claude');
const EXPECT_MISSING_WORKER_LINKS =
  process.env.LIVE_TASK_LOG_EXPECT_MISSING_WORKER_LINKS === '1';
const EXPECT_NO_EMPTY_PAYLOADS =
  process.env.LIVE_TASK_LOG_EXPECT_NO_EMPTY_PAYLOADS === '1';
const EXPECT_VISIBLE_TOOLS = (process.env.LIVE_TASK_LOG_EXPECT_VISIBLE_TOOLS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const describeLive =
  LIVE_TEAM && LIVE_TASK && LIVE_CLAUDE_BASE ? describe : describe.skip;

describeLive('BoardTaskLogStream live smoke', () => {
  beforeAll(() => {
    setClaudeBasePathOverride(LIVE_CLAUDE_BASE);
  });

  afterAll(() => {
    setClaudeBasePathOverride(null);
  });

  it('diagnoses the current live task-log state', async () => {
    const service = new BoardTaskLogDiagnosticsService();
    const streamService = new BoardTaskLogStreamService();
    let report;
    try {
      report = await service.diagnose(LIVE_TEAM!, LIVE_TASK!);
    } catch (error) {
      const fallbackTaskRef =
        LIVE_TASK!.length > 8 && LIVE_TASK!.includes('-') ? LIVE_TASK!.slice(0, 8) : null;
      if (!fallbackTaskRef) {
        throw error;
      }
      report = await service.diagnose(LIVE_TEAM!, fallbackTaskRef);
    }

    expect(report.task.taskId).toBeTruthy();
    expect(report.transcript.fileCount).toBeGreaterThan(0);
    expect(report.diagnosis.length).toBeGreaterThan(0);
    expect(report.stream.segmentCount).toBeGreaterThan(0);

    const stream = await streamService.getTaskLogStream(LIVE_TEAM!, report.task.taskId);
    expect(stream.segments.length).toBeGreaterThan(0);

    if (EXPECT_MISSING_WORKER_LINKS) {
      expect(report.intervalToolResults.worker.missingExplicit).toBeGreaterThan(0);
    }

    if (EXPECT_NO_EMPTY_PAYLOADS) {
      expect(report.stream.emptyPayloadExamples).toHaveLength(0);
    }

    if (EXPECT_VISIBLE_TOOLS.length > 0) {
      for (const toolName of EXPECT_VISIBLE_TOOLS) {
        expect(report.stream.visibleToolNames).toContain(toolName);
      }
    }
  });
});

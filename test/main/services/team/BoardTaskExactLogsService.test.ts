import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoardTaskExactLogsService } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogsService';

import type { BoardTaskActivityRecord } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecord';

const tempDirs: string[] = [];

async function createTempTranscript(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exact-log-summary-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'transcript.jsonl');
  await fs.writeFile(filePath, '{"uuid":"x","type":"user","timestamp":"2026-04-12T16:00:00.000Z","message":{"role":"user","content":"hi"}}\n', 'utf8');
  return filePath;
}

function makeRecord(filePath: string, id: string, timestamp: string, sourceOrder: number): BoardTaskActivityRecord {
  return {
    id,
    timestamp,
    task: {
      locator: { ref: 'abcd1234', refKind: 'display', canonicalId: 'task-a' },
      resolution: 'resolved',
    },
    linkKind: 'board_action',
    targetRole: 'subject',
    actor: {
      memberName: 'alice',
      role: 'member',
      sessionId: 'session-1',
      agentId: 'agent-1',
      isSidechain: true,
    },
    actorContext: { relation: 'same_task' },
    source: {
      filePath,
      messageUuid: id,
      sourceOrder,
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe('BoardTaskExactLogsService', () => {
  it('returns empty when the exact-log read flag is disabled', async () => {
    vi.stubEnv('CLAUDE_TEAM_BOARD_TASK_EXACT_LOGS_READ_ENABLED', 'false');
    const recordSource = {
      getTaskRecords: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };

    const service = new BoardTaskExactLogsService(recordSource as never);
    await expect(service.getTaskExactLogSummaries('demo', 'task-a')).resolves.toEqual({ items: [] });
    expect(recordSource.getTaskRecords).not.toHaveBeenCalled();
  });

  it('returns summaries in deterministic source order for the renderer to present', async () => {
    const filePath = await createTempTranscript();
    const recordSource = {
      getTaskRecords: vi.fn(async () => [
        makeRecord(filePath, 'msg-older', '2026-04-12T16:00:00.000Z', 1),
        makeRecord(filePath, 'msg-newer', '2026-04-12T16:05:00.000Z', 2),
      ]),
    };

    const service = new BoardTaskExactLogsService(recordSource as never);
    const response = await service.getTaskExactLogSummaries('demo', 'task-a');

    expect(response.items).toHaveLength(2);
    expect(response.items[0]?.timestamp).toBe('2026-04-12T16:00:00.000Z');
    expect(response.items[1]?.timestamp).toBe('2026-04-12T16:05:00.000Z');
  });
});

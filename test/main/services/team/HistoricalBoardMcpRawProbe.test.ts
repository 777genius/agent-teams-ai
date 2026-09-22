import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { HistoricalBoardMcpRawProbe } from '../../../../src/main/services/team/taskLogs/stream/HistoricalBoardMcpRawProbe';

import type { TeamTask } from '../../../../src/shared/types';

function makeTask(): TeamTask {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    displayId: 'abcd1234',
    subject: 'Test task',
    status: 'in_progress',
  };
}

describe('HistoricalBoardMcpRawProbe', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('returns only files that contain both a task reference and board MCP marker', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'historical-board-raw-probe-'));
    const hitFile = path.join(tempDir, 'hit.jsonl');
    const taskOnlyFile = path.join(tempDir, 'task-only.jsonl');
    const markerOnlyFile = path.join(tempDir, 'marker-only.jsonl');

    await writeFile(
      hitFile,
      JSON.stringify({
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'mcp__agent-teams__task_add_comment',
              input: { taskId: '#abcd1234' },
            },
          ],
        },
      }) + '\n',
      'utf8'
    );
    await writeFile(taskOnlyFile, 'the task #abcd1234 is mentioned without a tool\n', 'utf8');
    await writeFile(markerOnlyFile, 'mcp__agent-teams__task_add_comment unrelated\n', 'utf8');

    const result = await new HistoricalBoardMcpRawProbe().findCandidateFiles({
      task: makeTask(),
      transcriptFiles: [markerOnlyFile, hitFile, taskOnlyFile],
    });

    expect(result.filePaths).toEqual([hitFile]);
    expect(result.scannedFileCount).toBe(3);
    expect(result.hitCount).toBe(1);
  });

  it('matches canonical task ids as well as display ids', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'historical-board-raw-probe-'));
    const hitFile = path.join(tempDir, 'hit-canonical.jsonl');
    await writeFile(
      hitFile,
      'agent_teams_task_complete ' + '11111111-2222-3333-4444-555555555555\n',
      'utf8'
    );

    const result = await new HistoricalBoardMcpRawProbe().findCandidateFiles({
      task: makeTask(),
      transcriptFiles: [hitFile],
    });

    expect(result.filePaths).toEqual([hitFile]);
  });

  it('does not match task subject text without task id or display id evidence', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'historical-board-raw-probe-'));
    const subjectOnlyFile = path.join(tempDir, 'subject-only.jsonl');
    await writeFile(
      subjectOnlyFile,
      'mcp__agent-teams__task_add_comment mentions only Test task subject text\n',
      'utf8'
    );

    const result = await new HistoricalBoardMcpRawProbe().findCandidateFiles({
      task: makeTask(),
      transcriptFiles: [subjectOnlyFile],
    });

    expect(result.filePaths).toEqual([]);
    expect(result.scannedFileCount).toBe(1);
    expect(result.hitCount).toBe(0);
  });
});

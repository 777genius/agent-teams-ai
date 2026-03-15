import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import * as fs from 'fs/promises';

import { TaskBoundaryParser } from '../../../../src/main/services/team/TaskBoundaryParser';

describe('TaskBoundaryParser', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('detects MCP task boundaries for modern runtime sessions', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-boundary-parser-'));
    const jsonlPath = path.join(tmpDir, 'mcp.jsonl');
    await fs.writeFile(
      jsonlPath,
      [
        JSON.stringify({
          timestamp: '2026-03-01T10:00:00.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'task_start',
                input: { taskId: 'task-123' },
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-01T10:10:00.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-2',
                name: 'task_complete',
                input: { taskId: 'task-123' },
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const result = await new TaskBoundaryParser().parseBoundaries(jsonlPath);

    expect(result.detectedMechanism).toBe('mcp');
    expect(result.boundaries).toHaveLength(2);
    expect(result.boundaries.map((entry) => entry.event)).toEqual(['start', 'complete']);
    expect(result.boundaries.every((entry) => entry.mechanism === 'mcp')).toBe(true);
  });

  it('ignores legacy teamctl bash markers and keeps modern MCP markers only', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-boundary-parser-'));
    const jsonlPath = path.join(tmpDir, 'mixed.jsonl');
    await fs.writeFile(
      jsonlPath,
      [
        JSON.stringify({
          timestamp: '2026-03-01T10:00:00.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'task_start',
                input: { taskId: 'task-123' },
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-01T10:05:00.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-2',
                name: 'Bash',
                input: { command: 'node "teamctl.js" --team demo task complete 123' },
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const result = await new TaskBoundaryParser().parseBoundaries(jsonlPath);

    expect(result.detectedMechanism).toBe('mcp');
    expect(result.boundaries).toHaveLength(1);
    expect(result.boundaries[0]?.mechanism).toBe('mcp');
  });

  it('accepts task_id for TaskUpdate and MCP task markers', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-boundary-parser-'));
    const jsonlPath = path.join(tmpDir, 'task-id-underscore.jsonl');
    await fs.writeFile(
      jsonlPath,
      [
        JSON.stringify({
          timestamp: '2026-03-01T10:00:00.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'TaskUpdate',
                input: { task_id: 'task-123', status: 'in_progress' },
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-01T10:10:00.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-2',
                name: 'task_complete',
                input: { task_id: 'task-123' },
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const result = await new TaskBoundaryParser().parseBoundaries(jsonlPath);

    expect(result.boundaries).toHaveLength(2);
    expect(result.boundaries.map((entry) => entry.taskId)).toEqual(['task-123', 'task-123']);
    expect(result.boundaries.map((entry) => entry.event)).toEqual(['start', 'complete']);
  });
});

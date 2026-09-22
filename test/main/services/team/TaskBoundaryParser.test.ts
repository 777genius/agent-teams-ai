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

  it('dedupes concurrent boundary parsing and invalidates when the file changes', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-boundary-parser-'));
    const jsonlPath = path.join(tmpDir, 'concurrent.jsonl');
    await fs.writeFile(
      jsonlPath,
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
      }) + '\n',
      'utf8'
    );

    const parser = new TaskBoundaryParser();
    const [first, second, third] = await Promise.all([
      parser.parseBoundaries(jsonlPath),
      parser.parseBoundaries(jsonlPath),
      parser.parseBoundaries(jsonlPath),
    ]);

    expect(first.boundaries).toHaveLength(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.appendFile(
      jsonlPath,
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
      }) + '\n',
      'utf8'
    );

    const afterChange = await parser.parseBoundaries(jsonlPath);
    expect(afterChange.boundaries).toHaveLength(2);
  });

  it('detects fully-qualified agent-teams MCP task boundaries', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-boundary-parser-'));
    const jsonlPath = path.join(tmpDir, 'mcp-qualified.jsonl');
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
                name: 'mcp__agent-teams__task_start',
                input: { taskId: 'task-123', teamName: 'demo' },
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
                name: 'mcp__agent_teams__task_complete',
                input: { taskId: 'task-123', teamName: 'demo' },
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

  it('includes every metadata changes path in scoped file paths', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-boundary-parser-'));
    const jsonlPath = path.join(tmpDir, 'metadata-changes.jsonl');
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
                id: 'tool-start',
                name: 'task_start',
                input: { taskId: 'task-123' },
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-01T10:01:00.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-edit',
                name: 'Edit',
                input: {
                  file_path: '/repo/dfdf/calc.js',
                  changes: [
                    { path: '/repo/dfdf/calc.js', kind: 'add' },
                    { path: '/repo/dfdf/style.css', kind: 'add' },
                  ],
                },
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-01T10:02:00.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-complete',
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

    expect(result.scopes[0]?.toolUseIds).toEqual(['tool-edit']);
    expect(result.scopes[0]?.filePaths).toEqual(['/repo/dfdf/calc.js', '/repo/dfdf/style.css']);
  });
});

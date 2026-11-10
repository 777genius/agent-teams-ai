import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CodexNativeTraceReader } from '../../../../src/main/services/team/taskLogs/stream/CodexNativeTraceReader';

const TRACE_ROOT_SEGMENT = path.join('.member-work-sync', 'runtime-hooks', 'codex-native-traces');

let teamsBasePath: string;

function traceSegment(value: string): string {
  return encodeURIComponent(value);
}

async function writeTraceFile(params: {
  bucket: 'incoming' | 'processed';
  teamName: string;
  taskId: string;
  runId: string;
  records: Array<Record<string, unknown>>;
  suffix?: '.jsonl' | '.jsonl.tmp';
}): Promise<string> {
  const dir = path.join(
    teamsBasePath,
    TRACE_ROOT_SEGMENT,
    params.bucket,
    traceSegment(params.teamName),
    traceSegment(params.taskId)
  );
  await mkdir(dir, { recursive: true });
  const absolutePath = path.join(dir, `${params.runId}${params.suffix ?? (params.bucket === 'incoming' ? '.jsonl.tmp' : '.jsonl')}`);
  await writeFile(
    absolutePath,
    `${params.records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8'
  );
  return absolutePath;
}

function header(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    recordType: 'codex_native_trace_header',
    runId: 'run-1',
    teamName: 'vector-room-131313',
    taskId: '8421e1bb-2f3b-4656-9983-6e0fd4b15963',
    ownerName: 'atlas',
    provider: 'codex',
    cwd: '/repo',
    startedAt: '2026-05-01T17:10:07.799Z',
    ...overrides,
  };
}

describe('CodexNativeTraceReader', () => {
  beforeEach(async () => {
    teamsBasePath = await mkdtemp(path.join(tmpdir(), 'codex-native-trace-reader-'));
  });

  afterEach(async () => {
    await rm(teamsBasePath, { recursive: true, force: true });
  });

  it('reads projection records and prefers processed trace over duplicate incoming run', async () => {
    const teamName = 'vector-room-131313';
    const taskId = '8421e1bb-2f3b-4656-9983-6e0fd4b15963';
    await writeTraceFile({
      bucket: 'incoming',
      teamName,
      taskId,
      runId: 'run-1',
      records: [
        header(),
        {
          schemaVersion: 1,
          recordType: 'codex_native_stdout_event',
          receivedAt: '2026-05-01T17:10:08.000Z',
          sourceOrder: 1,
          projection: {
            kind: 'tool_result',
            toolSource: 'native',
            rawItemType: 'command_execution',
            itemId: 'item_1',
            toolName: 'Bash',
            input: { command: 'pwd' },
            result: { content: 'incoming' },
          },
        },
      ],
    });
    await writeTraceFile({
      bucket: 'processed',
      teamName,
      taskId,
      runId: 'run-1',
      records: [
        header(),
        {
          schemaVersion: 1,
          recordType: 'codex_native_stdout_event',
          receivedAt: '2026-05-01T17:10:08.000Z',
          sourceOrder: 1,
          projection: {
            kind: 'tool_result',
            toolSource: 'native',
            rawItemType: 'command_execution',
            itemId: 'item_1',
            toolName: 'Bash',
            input: { command: 'pwd' },
            result: { content: 'processed' },
          },
        },
      ],
    });

    const runs = await new CodexNativeTraceReader(teamsBasePath).readTaskRuns({
      teamName,
      taskIds: [taskId, '8421e1bb'],
      includeIncoming: true,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.partial).toBe(false);
    expect(runs[0]?.events[0]?.projection).toMatchObject({
      kind: 'tool_result',
      toolSource: 'native',
      toolName: 'Bash',
      result: { content: 'processed' },
    });
  });

  it('falls back to raw Codex command/file events and ignores malformed trailing incoming line', async () => {
    const teamName = 'vector-room-131313';
    const taskId = '891e1f68-d5b0-40f7-aa48-c378607e0f3b';
    const dir = path.join(
      teamsBasePath,
      TRACE_ROOT_SEGMENT,
      'incoming',
      traceSegment(teamName),
      traceSegment(taskId)
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'run-raw.jsonl.tmp'),
      [
        JSON.stringify(header({ runId: 'run-raw', taskId, ownerName: 'jack' })),
        JSON.stringify({
          schemaVersion: 1,
          recordType: 'codex_native_stdout_event',
          receivedAt: '2026-05-01T17:19:36.000Z',
          sourceOrder: 1,
          raw: {
            type: 'item.completed',
            item: {
              id: 'item_1',
              type: 'command_execution',
              command: 'pwd',
              aggregated_output: '/repo\n',
              exit_code: 2,
              status: 'completed',
            },
          },
        }),
        JSON.stringify({
          schemaVersion: 1,
          recordType: 'codex_native_stdout_event',
          receivedAt: '2026-05-01T17:19:37.000Z',
          sourceOrder: 2,
          raw: {
            type: 'item.completed',
            item: {
              id: 'item_2',
              type: 'file_change',
              changes: [{ path: '/repo/src/a.ts', kind: 'update' }],
              status: 'completed',
            },
          },
        }),
        '{"schemaVersion":1,"recordType":"codex_native_stdout_event"',
      ].join('\n'),
      'utf8'
    );

    const runs = await new CodexNativeTraceReader(teamsBasePath).readTaskRuns({
      teamName,
      taskIds: [taskId, '891e1f68'],
      includeIncoming: true,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.partial).toBe(true);
    expect(runs[0]?.events.map((event) => event.projection?.toolName)).toEqual(['Bash', 'Edit']);
    expect(runs[0]?.events[0]?.projection).toMatchObject({
      kind: 'tool_result',
      rawItemType: 'command_execution',
      result: {
        content: '/repo\n',
        stdout: '/repo\n',
        exitCode: 2,
      },
      isError: true,
    });
  });

  it('rejects trace files whose header belongs to another team or task', async () => {
    const teamName = 'vector-room-131313';
    const taskId = '8421e1bb-2f3b-4656-9983-6e0fd4b15963';
    await writeTraceFile({
      bucket: 'processed',
      teamName,
      taskId,
      runId: 'run-wrong-team',
      records: [
        header({ teamName: 'another-team', runId: 'run-wrong-team' }),
        {
          schemaVersion: 1,
          recordType: 'codex_native_stdout_event',
          receivedAt: '2026-05-01T17:10:08.000Z',
          sourceOrder: 1,
          projection: {
            kind: 'tool_result',
            toolSource: 'native',
            itemId: 'item_1',
            toolName: 'Bash',
          },
        },
      ],
    });

    await expect(
      new CodexNativeTraceReader(teamsBasePath).readTaskRuns({
        teamName,
        taskIds: [taskId],
      })
    ).resolves.toEqual([]);
  });
});

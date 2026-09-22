import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { TeamTaskStallExactRowReader } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallExactRowReader';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dirPath) => {
      await fs.rm(dirPath, { recursive: true, force: true });
    })
  );
});

function createAssistantEntry(args: {
  uuid: string;
  timestamp: string;
  content: unknown[];
  requestId?: string;
}): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: args.uuid,
    timestamp: args.timestamp,
    sessionId: 'session-a',
    teamName: 'demo',
    agentName: 'alice',
    isSidechain: true,
    ...(args.requestId ? { requestId: args.requestId } : {}),
    message: {
      id: `${args.uuid}-msg`,
      role: 'assistant',
      model: 'claude-test',
      type: 'message',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
      content: args.content,
    },
  };
}

function createUserEntry(args: {
  uuid: string;
  timestamp: string;
  content: unknown[];
  sourceToolUseID?: string;
}): Record<string, unknown> {
  return {
    type: 'user',
    uuid: args.uuid,
    timestamp: args.timestamp,
    sessionId: 'session-a',
    teamName: 'demo',
    agentName: 'alice',
    isSidechain: true,
    ...(args.sourceToolUseID ? { sourceToolUseID: args.sourceToolUseID } : {}),
    message: {
      role: 'user',
      content: args.content,
    },
  };
}

describe('TeamTaskStallExactRowReader', () => {
  it('keeps strict rows with subtype and tool ids', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stall-exact-rows-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'session.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'system',
          uuid: 'sys-init',
          timestamp: '2026-04-19T12:00:00.000Z',
          sessionId: 'session-a',
          teamName: 'demo',
          agentName: 'alice',
          isSidechain: true,
          isMeta: true,
          subtype: 'turn_duration',
          durationMs: 1234,
        }),
        JSON.stringify(
          createAssistantEntry({
            uuid: 'asst-1',
            timestamp: '2026-04-19T12:01:00.000Z',
            requestId: 'req-1',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'task_start',
                input: { taskId: 'task-a' },
              },
            ],
          })
        ),
        JSON.stringify(
          createUserEntry({
            uuid: 'user-1',
            timestamp: '2026-04-19T12:01:01.000Z',
            sourceToolUseID: 'tool-1',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
          })
        ),
        JSON.stringify({
          uuid: 'bad-ts',
          type: 'assistant',
          timestamp: 'not-a-date',
          message: { role: 'assistant', content: 'bad row' },
        }),
      ].join('\n'),
      'utf8'
    );

    const parsed = await new TeamTaskStallExactRowReader().parseFiles([filePath]);
    const rows = parsed.get(filePath) ?? [];

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.messageUuid)).toEqual(['sys-init', 'asst-1', 'user-1']);
    expect(rows[0]).toMatchObject({
      systemSubtype: 'turn_duration',
      sourceOrder: 1,
      toolUseIds: [],
      toolResultIds: [],
    });
    expect(rows[1]).toMatchObject({
      requestId: 'req-1',
      toolUseIds: ['tool-1'],
      toolResultIds: [],
      sourceOrder: 2,
    });
    expect(rows[2]).toMatchObject({
      sourceToolUseId: 'tool-1',
      toolUseIds: [],
      toolResultIds: ['tool-1'],
      sourceOrder: 3,
    });
  });
});

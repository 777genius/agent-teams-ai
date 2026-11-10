import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { BoardTaskActivityTranscriptReader } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityTranscriptReader';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map(async (dirPath) => {
      await fs.rm(dirPath, { recursive: true, force: true });
    })
  );
});

describe('BoardTaskActivityTranscriptReader', () => {
  it('skips non-board and malformed rows while preserving task-linked activity rows', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activity-transcript-reader-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'session.jsonl');
    await fs.writeFile(
      filePath,
      [
        '{not-json',
        JSON.stringify({
          uuid: 'ordinary-message',
          sessionId: 'session-a',
          timestamp: '2026-04-20T12:00:00.000Z',
          message: { role: 'assistant', content: 'No board task links here' },
        }),
        '{"boardTaskLinks":',
        JSON.stringify({
          uuid: 'linked-message',
          sessionId: 'session-a',
          timestamp: '2026-04-20T12:01:00.000Z',
          agentId: 'agent-a',
          agentName: 'alice',
          isSidechain: true,
          boardTaskLinks: [
            {
              schemaVersion: 1,
              task: { ref: '12345678', refKind: 'display', canonicalId: 'task-a' },
              targetRole: 'subject',
              linkKind: 'execution',
              actorContext: { relation: 'same_task' },
              toolUseId: 'toolu_1',
            },
          ],
          boardTaskToolActions: [
            {
              schemaVersion: 1,
              toolUseId: 'toolu_1',
              canonicalToolName: 'task_set_status',
              input: { status: 'in_progress' },
            },
          ],
        }),
      ].join('\n'),
      'utf8'
    );

    const rows = await new BoardTaskActivityTranscriptReader().readFiles([filePath]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      filePath,
      uuid: 'linked-message',
      sessionId: 'session-a',
      timestamp: '2026-04-20T12:01:00.000Z',
      agentId: 'agent-a',
      agentName: 'alice',
      isSidechain: true,
      sourceOrder: 1,
      boardTaskLinks: [
        {
          schemaVersion: 1,
          toolUseId: 'toolu_1',
          task: { ref: '12345678', refKind: 'display', canonicalId: 'task-a' },
          targetRole: 'subject',
          linkKind: 'execution',
          actorContext: { relation: 'same_task' },
        },
      ],
      boardTaskToolActions: [
        {
          schemaVersion: 1,
          toolUseId: 'toolu_1',
          canonicalToolName: 'task_set_status',
          input: { status: 'in_progress' },
        },
      ],
    });
  });

  it('inherits stable session actor context for task-linked Codex projection rows', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activity-transcript-reader-actor-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'codex-session.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          uuid: 'session-context',
          sessionId: 'session-codex',
          timestamp: '2026-04-20T12:00:00.000Z',
          agentName: 'tom',
          isSidechain: false,
          message: { role: 'assistant', content: 'Starting task' },
        }),
        JSON.stringify({
          uuid: 'linked-without-agent-name',
          sessionId: 'session-codex',
          timestamp: '2026-04-20T12:01:00.000Z',
          boardTaskLinks: [
            {
              schemaVersion: 1,
              task: { ref: '12345678', refKind: 'display', canonicalId: 'task-a' },
              targetRole: 'subject',
              linkKind: 'board_action',
              actorContext: { relation: 'same_task' },
              toolUseId: 'toolu_task_comment',
            },
          ],
          boardTaskToolActions: [
            {
              schemaVersion: 1,
              toolUseId: 'toolu_task_comment',
              canonicalToolName: 'task_add_comment',
            },
          ],
        }),
      ].join('\n'),
      'utf8'
    );

    const rows = await new BoardTaskActivityTranscriptReader().readFiles([filePath]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      uuid: 'linked-without-agent-name',
      sessionId: 'session-codex',
      agentName: 'tom',
      isSidechain: false,
    });
  });
});

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  teamsBasePath: '',
}));

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => hoisted.teamsBasePath,
}));

import {
  OpenCodeTaskLogAttributionStore,
  getOpenCodeTaskLogAttributionPath,
} from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogAttributionStore';

describe('OpenCodeTaskLogAttributionStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-attribution-'));
    hoisted.teamsBasePath = tempDir;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reads normalized task records from tasks map and flat records without duplicates', async () => {
    const filePath = getOpenCodeTaskLogAttributionPath('team-a');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          tasks: {
            'task-a': [
              {
                memberName: ' bob ',
                scope: 'member_session_window',
                sessionId: ' session-bob ',
                since: '2026-04-21T12:00:00Z',
                until: '2026-04-21T12:10:00Z',
                source: 'launch_runtime',
              },
              {
                memberName: 'bob',
                scope: 'member_session_window',
                sessionId: 'session-bob',
                since: '2026-04-21T12:00:00.000Z',
                until: '2026-04-21T12:10:00.000Z',
                source: 'launch_runtime',
              },
              {
                memberName: '',
                since: '2026-04-21T12:00:00Z',
              },
            ],
          },
          records: [
            {
              taskId: 'task-a',
              memberName: 'carol',
              scope: 'task_session',
              sessionId: 'session-carol',
              startMessageUuid: 'm-1',
              endMessageUuid: 'm-3',
              createdAt: '2026-04-21T11:59:00Z',
            },
            {
              taskId: 'other-task',
              memberName: 'dave',
            },
            {
              taskId: 'task-a',
              memberName: 'erin',
              since: '2026-04-21T13:00:00Z',
              until: '2026-04-21T12:00:00Z',
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const records = await new OpenCodeTaskLogAttributionStore().readTaskRecords('team-a', 'task-a');

    expect(records).toEqual([
      {
        taskId: 'task-a',
        memberName: 'carol',
        scope: 'task_session',
        sessionId: 'session-carol',
        startMessageUuid: 'm-1',
        endMessageUuid: 'm-3',
        createdAt: '2026-04-21T11:59:00.000Z',
      },
      {
        taskId: 'task-a',
        memberName: 'bob',
        scope: 'member_session_window',
        sessionId: 'session-bob',
        since: '2026-04-21T12:00:00.000Z',
        until: '2026-04-21T12:10:00.000Z',
        source: 'launch_runtime',
      },
    ]);
  });

  it('degrades to empty records for missing, invalid, or unsupported files', async () => {
    const store = new OpenCodeTaskLogAttributionStore();
    await expect(store.readTaskRecords('team-a', 'task-a')).resolves.toEqual([]);

    const filePath = getOpenCodeTaskLogAttributionPath('team-a');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{bad-json', 'utf8');
    await expect(store.readTaskRecords('team-a', 'task-a')).resolves.toEqual([]);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      '[OpenCodeTaskLogAttributionStore]',
      expect.stringContaining('invalid OpenCode task-log attribution JSON')
    );
    vi.mocked(console.warn).mockClear();

    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 2,
        records: [{ taskId: 'task-a', memberName: 'alice' }],
      }),
      'utf8'
    );
    await expect(store.readTaskRecords('team-a', 'task-a')).resolves.toEqual([]);
  });

  it('upserts records atomically and does not rewrite unchanged attribution', async () => {
    const store = new OpenCodeTaskLogAttributionStore();
    const now = new Date('2026-04-21T12:00:00.000Z');

    await expect(
      store.upsertTaskRecord(
        'team-a',
        {
          taskId: 'task-a',
          memberName: ' alice ',
          scope: 'member_session_window',
          sessionId: ' session-a ',
          since: '2026-04-21T11:59:00Z',
          until: '2026-04-21T12:05:00Z',
          source: 'launch_runtime',
        },
        { now }
      )
    ).resolves.toBe('created');

    const filePath = getOpenCodeTaskLogAttributionPath('team-a');
    const firstRaw = await fs.readFile(filePath, 'utf8');
    await expect(
      store.upsertTaskRecord(
        'team-a',
        {
          taskId: 'task-a',
          memberName: 'alice',
          scope: 'member_session_window',
          sessionId: 'session-a',
          since: '2026-04-21T11:59:00.000Z',
          until: '2026-04-21T12:05:00.000Z',
          source: 'launch_runtime',
        },
        { now: new Date('2026-04-21T12:10:00.000Z') }
      )
    ).resolves.toBe('unchanged');

    expect(await fs.readFile(filePath, 'utf8')).toBe(firstRaw);
    await expect(store.readTaskRecords('team-a', 'task-a')).resolves.toEqual([
      {
        taskId: 'task-a',
        memberName: 'alice',
        scope: 'member_session_window',
        sessionId: 'session-a',
        since: '2026-04-21T11:59:00.000Z',
        until: '2026-04-21T12:05:00.000Z',
        source: 'launch_runtime',
        createdAt: '2026-04-21T12:00:00.000Z',
        updatedAt: '2026-04-21T12:00:00.000Z',
      },
    ]);
  });

  it('serializes concurrent upserts without losing records', async () => {
    const store = new OpenCodeTaskLogAttributionStore();

    await Promise.all([
      store.upsertTaskRecord(
        'team-a',
        {
          taskId: 'task-a',
          memberName: 'alice',
          scope: 'member_session_window',
          sessionId: 'session-a',
          since: '2026-04-21T10:00:00Z',
        },
        { now: new Date('2026-04-21T10:00:01.000Z') }
      ),
      store.upsertTaskRecord(
        'team-a',
        {
          taskId: 'task-b',
          memberName: 'bob',
          scope: 'task_session',
          sessionId: 'session-b',
          startMessageUuid: 'm-1',
          endMessageUuid: 'm-3',
        },
        { now: new Date('2026-04-21T10:00:02.000Z') }
      ),
    ]);

    await expect(store.readTaskRecords('team-a', 'task-a')).resolves.toMatchObject([
      {
        taskId: 'task-a',
        memberName: 'alice',
        sessionId: 'session-a',
      },
    ]);
    await expect(store.readTaskRecords('team-a', 'task-b')).resolves.toMatchObject([
      {
        taskId: 'task-b',
        memberName: 'bob',
        sessionId: 'session-b',
        startMessageUuid: 'm-1',
        endMessageUuid: 'm-3',
      },
    ]);
  });

  it('replaces and clears only the requested task records', async () => {
    const store = new OpenCodeTaskLogAttributionStore();

    await store.upsertTaskRecord('team-a', {
      taskId: 'task-a',
      memberName: 'alice',
      scope: 'member_session_window',
      sessionId: 'session-a',
      since: '2026-04-21T10:00:00Z',
    });
    await store.upsertTaskRecord('team-a', {
      taskId: 'task-b',
      memberName: 'bob',
      scope: 'member_session_window',
      sessionId: 'session-b',
      since: '2026-04-21T11:00:00Z',
    });

    await expect(
      store.replaceTaskRecords(
        'team-a',
        'task-a',
        [
          {
            taskId: 'ignored-by-replace',
            memberName: 'carol',
            scope: 'task_session',
            sessionId: 'session-c',
            startMessageUuid: 'm-1',
          },
        ],
        { now: new Date('2026-04-21T12:00:00.000Z') }
      )
    ).resolves.toBe('updated');

    await expect(store.readTaskRecords('team-a', 'task-a')).resolves.toMatchObject([
      {
        taskId: 'task-a',
        memberName: 'carol',
        sessionId: 'session-c',
        startMessageUuid: 'm-1',
      },
    ]);
    await expect(store.readTaskRecords('team-a', 'task-b')).resolves.toMatchObject([
      {
        taskId: 'task-b',
        memberName: 'bob',
        sessionId: 'session-b',
      },
    ]);

    await expect(store.clearTaskRecords('team-a', 'task-a')).resolves.toBe('deleted');
    await expect(store.readTaskRecords('team-a', 'task-a')).resolves.toEqual([]);
    await expect(store.readTaskRecords('team-a', 'task-b')).resolves.toHaveLength(1);
  });

  it('fails closed instead of overwriting invalid attribution JSON during writes', async () => {
    const store = new OpenCodeTaskLogAttributionStore();
    const filePath = getOpenCodeTaskLogAttributionPath('team-a');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{bad-json', 'utf8');

    await expect(
      store.upsertTaskRecord('team-a', {
        taskId: 'task-a',
        memberName: 'alice',
        scope: 'member_session_window',
        sessionId: 'session-a',
      })
    ).rejects.toThrow('Invalid OpenCode task-log attribution JSON');
    expect(await fs.readFile(filePath, 'utf8')).toBe('{bad-json');
  });
});

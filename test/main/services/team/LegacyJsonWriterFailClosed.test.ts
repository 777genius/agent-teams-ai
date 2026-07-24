import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  tasksBase: '',
  teamsBase: '',
}));

vi.mock('../../../../src/main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/utils/pathDecoder')>();
  return {
    ...actual,
    getTasksBasePath: () => hoisted.tasksBase,
    getTeamsBasePath: () => hoisted.teamsBase,
  };
});

import { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';
import { TeamInboxWriter } from '../../../../src/main/services/team/TeamInboxWriter';
import { TeamMetaStore } from '../../../../src/main/services/team/TeamMetaStore';
import { TeamTaskWriter } from '../../../../src/main/services/team/TeamTaskWriter';

interface FileSnapshot {
  bytes: string;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
}

async function snapshotFile(filePath: string): Promise<FileSnapshot> {
  const [bytes, stats] = await Promise.all([
    fs.readFile(filePath, 'utf8'),
    fs.stat(filePath, { bigint: true }),
  ]);
  return {
    bytes,
    dev: stats.dev,
    ino: stats.ino,
    mtimeNs: stats.mtimeNs,
  };
}

async function expectRejectedWithoutRewrite(
  filePath: string,
  mutation: () => Promise<unknown>
): Promise<void> {
  const stableTimestamp = new Date('2020-01-02T03:04:05.000Z');
  await fs.utimes(filePath, stableTimestamp, stableTimestamp);
  const before = await snapshotFile(filePath);
  let rejected = false;
  try {
    await mutation();
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
  await expect(snapshotFile(filePath)).resolves.toEqual(before);
}

describe('legacy JSON writer fail-closed boundaries', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-json-writers-'));
    hoisted.tasksBase = path.join(tempDir, 'tasks');
    hoisted.teamsBase = path.join(tempDir, 'teams');
    await Promise.all([
      fs.mkdir(hoisted.tasksBase, { recursive: true }),
      fs.mkdir(hoisted.teamsBase, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    TeamConfigReader.clearCacheForTests();
    hoisted.tasksBase = '';
    hoisted.teamsBase = '';
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    [
      'root backend',
      {
        version: 1,
        cwd: '/project',
        createdAt: 1,
        providerId: 'codex',
        providerBackendId: 'future-backend',
      },
    ],
    [
      'launch identity backend',
      {
        version: 1,
        cwd: '/project',
        createdAt: 1,
        launchIdentity: {
          providerId: 'codex',
          providerBackendId: 'future-backend',
          selectedModel: 'gpt-5',
          selectedModelKind: 'explicit',
          resolvedLaunchModel: 'gpt-5',
          catalogId: 'catalog',
          catalogSource: 'app-server',
          catalogFetchedAt: null,
          selectedEffort: 'high',
          resolvedEffort: 'high',
        },
      },
    ],
  ])('TeamMetaStore rejects an unsupported persisted %s without rewriting', async (_label, doc) => {
    const teamName = 'meta-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const metaPath = path.join(teamDir, 'team.meta.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify(doc), 'utf8');

    await expectRejectedWithoutRewrite(metaPath, () =>
      new TeamMetaStore().writeMeta(teamName, {
        cwd: '/replacement',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        createdAt: 2,
      })
    );
  });

  it('TeamConfigReader rejects members: [42] without rewriting', async () => {
    const teamName = 'config-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const configPath = path.join(teamDir, 'config.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Before', members: [42] }), 'utf8');

    await expectRejectedWithoutRewrite(configPath, () =>
      new TeamConfigReader().updateConfig(teamName, { name: 'After' })
    );
  });

  it('TeamTaskWriter rejects comments: [42] without rewriting', async () => {
    const teamName = 'task-team';
    const teamDir = path.join(hoisted.tasksBase, teamName);
    const taskPath = path.join(teamDir, '12.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      taskPath,
      JSON.stringify({ id: '12', subject: 'Before', status: 'pending', comments: [42] }),
      'utf8'
    );

    await expectRejectedWithoutRewrite(taskPath, () =>
      new TeamTaskWriter().addComment('task-team', '12', 'must not be appended')
    );
  });

  it('TeamInboxWriter rejects an entry with text: 42 without filtering or rewriting', async () => {
    const teamName = 'inbox-team';
    const inboxDir = path.join(hoisted.teamsBase, teamName, 'inboxes');
    const inboxPath = path.join(inboxDir, 'alice.json');
    await fs.mkdir(inboxDir, { recursive: true });
    await fs.writeFile(
      inboxPath,
      JSON.stringify([
        {
          from: 'user',
          to: 'alice',
          text: 42,
          timestamp: '2026-07-20T00:00:00.000Z',
          read: false,
          messageId: 'malformed-message',
        },
      ]),
      'utf8'
    );

    await expectRejectedWithoutRewrite(inboxPath, () =>
      new TeamInboxWriter().sendMessage(teamName, {
        member: 'alice',
        text: 'must not replace the malformed entry',
      })
    );
  });
});

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectTasksPollSnapshot,
  collectTeamsPollSnapshot,
  isNotFoundError,
} from '../../../../src/main/services/infrastructure/TeamTaskPollSnapshot';

let root = '';

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'team-task-poll-snapshot-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function writeFile(relativePath: string, contents: string): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, contents, 'utf8');
}

describe('isNotFoundError', () => {
  it('accepts the ENOENT shapes the fallback poller can observe', () => {
    expect(isNotFoundError({ code: 'ENOENT' })).toBe(true);
    expect(isNotFoundError({ code: '2' })).toBe(true);
    expect(isNotFoundError({ code: 2 })).toBe(true);
  });

  it('rejects other errors and non-error values', () => {
    expect(isNotFoundError({ code: 'EPERM' })).toBe(false);
    expect(isNotFoundError(new Error('boom'))).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });
});

describe('collectTeamsPollSnapshot', () => {
  it('covers team metadata and inbox json files without recursing deeper', async () => {
    const teamsPath = path.join(root, 'teams');
    await writeFile('teams/alpha/team.json', '{}');
    await writeFile('teams/alpha/notes.txt', 'ignored');
    await writeFile('teams/alpha/inboxes/member-1.json', '[]');
    await writeFile('teams/alpha/members/deep/nested.json', '{}');
    await writeFile('teams/beta/team.json', '{}');
    await writeFile('teams/loose.json', '{}');

    const snapshot = await collectTeamsPollSnapshot(teamsPath);

    expect([...snapshot.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      'alpha/inboxes/member-1.json',
      'alpha/team.json',
      'beta/team.json',
    ]);
    expect(snapshot.get('alpha/team.json')).toMatch(/^\d+:\d+:[\d.]+:[\d.]+:\d+$/);
  });

  it('tolerates a team without an inboxes directory', async () => {
    const teamsPath = path.join(root, 'teams');
    await writeFile('teams/alpha/team.json', '{}');

    const snapshot = await collectTeamsPollSnapshot(teamsPath);

    expect([...snapshot.keys()]).toEqual(['alpha/team.json']);
  });

  it('propagates a missing teams root', async () => {
    await expect(collectTeamsPollSnapshot(path.join(root, 'teams'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('collectTasksPollSnapshot', () => {
  it('covers tasks/<team>/*.json and skips hidden and nested files', async () => {
    const tasksPath = path.join(root, 'tasks');
    await writeFile('tasks/alpha/task-1.json', '{}');
    await writeFile('tasks/alpha/.hidden.json', '{}');
    await writeFile('tasks/alpha/task-1.md', '# ignored');
    await writeFile('tasks/alpha/archive/task-2.json', '{}');
    await writeFile('tasks/loose.json', '{}');

    const snapshot = await collectTasksPollSnapshot(tasksPath);

    expect([...snapshot.keys()]).toEqual(['alpha/task-1.json']);
  });

  it('propagates a missing tasks root', async () => {
    await expect(collectTasksPollSnapshot(path.join(root, 'tasks'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

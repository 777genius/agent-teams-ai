import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();

  // Normalize path separators so tests pass on Windows (backslash → forward slash)
  const norm = (p: string): string => p.replace(/\\/g, '/');

  const readdir = vi.fn(async (dirPath: string) => {
    const entries = dirs.get(norm(dirPath));
    if (!entries) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return entries;
  });

  const readFile = vi.fn(async (filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return data;
  });

  return { files, dirs, readdir, readFile };
});

vi.mock('fs', () => ({
  promises: {
    readdir: hoisted.readdir,
    readFile: hoisted.readFile,
  },
}));

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => '/mock/teams',
}));

import { TeamInboxReader } from '../../../../src/main/services/team/TeamInboxReader';

describe('TeamInboxReader', () => {
  const reader = new TeamInboxReader();
  const inboxDir = '/mock/teams/my-team/inboxes';

  beforeEach(() => {
    hoisted.files.clear();
    hoisted.dirs.clear();
    hoisted.readdir.mockClear();
    hoisted.readFile.mockClear();
  });

  it('listInboxNames filters only visible json files', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json', '.hidden.json', 'bob.json', 'note.txt']);

    const names = await reader.listInboxNames('my-team');
    expect(names).toEqual(['alice', 'bob']);
  });

  it('getMessagesFor returns empty for corrupted JSON', async () => {
    hoisted.files.set('/mock/teams/my-team/inboxes/alice.json', '{bad');
    const messages = await reader.getMessagesFor('my-team', 'alice');
    expect(messages).toEqual([]);
  });

  it('getMessages merges and sorts by newest timestamp', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json', 'bob.json']);
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'alice',
          text: 'older',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
        },
      ])
    );
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/bob.json',
      JSON.stringify([
        {
          from: 'bob',
          text: 'newer',
          timestamp: '2026-01-02T00:00:00.000Z',
          read: false,
        },
      ])
    );

    const merged = await reader.getMessages('my-team');
    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe('newer');
    expect(merged[1].text).toBe('older');
  });
});

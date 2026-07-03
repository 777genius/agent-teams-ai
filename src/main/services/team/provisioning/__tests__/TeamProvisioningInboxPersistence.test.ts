import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildLegacyInboxMessageId } from '../../inboxMessageIdentity';
import { markTeamInboxMessagesRead } from '../TeamProvisioningInboxPersistence';

const tmpRoots: string[] = [];

async function makeTeamsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'team-inbox-persistence-'));
  tmpRoots.push(root);
  return root;
}

async function readRegularFileUtf8(filePath: string): Promise<string | null> {
  return readFile(filePath, 'utf8').catch(() => null);
}

describe('team inbox persistence', () => {
  afterEach(async () => {
    await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('marks matching inbox rows read by stable and legacy message ids', async () => {
    const teamsRoot = await makeTeamsRoot();
    const inboxDir = path.join(teamsRoot, 'team-a', 'inboxes');
    const inboxPath = path.join(inboxDir, 'lead.json');
    await mkdir(inboxDir, { recursive: true });
    await writeFile(
      inboxPath,
      JSON.stringify(
        [
          {
            messageId: 'stable-1',
            from: 'worker-a',
            timestamp: '2026-01-01T00:00:00.000Z',
            text: 'stable',
            read: false,
          },
          {
            from: 'worker-b',
            timestamp: '2026-01-01T00:00:01.000Z',
            text: 'legacy',
            read: false,
          },
          {
            messageId: 'unmatched',
            from: 'worker-c',
            timestamp: '2026-01-01T00:00:02.000Z',
            text: 'keep unread',
            read: false,
          },
        ],
        null,
        2
      )
    );

    await markTeamInboxMessagesRead({
      teamName: 'team-a',
      member: 'lead',
      teamsBasePath: teamsRoot,
      messages: [
        { messageId: 'stable-1' },
        {
          messageId: buildLegacyInboxMessageId('worker-b', '2026-01-01T00:00:01.000Z', 'legacy'),
        },
      ],
      readRegularFileUtf8,
      timeoutMs: 5_000,
      maxBytes: 2 * 1024 * 1024,
    });

    const rows = JSON.parse(await readFile(inboxPath, 'utf8')) as { read?: boolean }[];
    expect(rows.map((row) => row.read)).toEqual([true, true, false]);
  });

  it('leaves malformed and non-array inbox files unchanged', async () => {
    const teamsRoot = await makeTeamsRoot();
    const inboxDir = path.join(teamsRoot, 'team-a', 'inboxes');
    await mkdir(inboxDir, { recursive: true });

    async function expectUnchanged(member: string, raw: string): Promise<void> {
      const inboxPath = path.join(inboxDir, `${member}.json`);
      await writeFile(inboxPath, raw);

      await markTeamInboxMessagesRead({
        teamName: 'team-a',
        member,
        teamsBasePath: teamsRoot,
        messages: [{ messageId: 'stable-1' }],
        readRegularFileUtf8,
        timeoutMs: 5_000,
        maxBytes: 2 * 1024 * 1024,
      });

      expect(await readFile(inboxPath, 'utf8')).toBe(raw);
    }

    await expectUnchanged('malformed', '{not-json');
    await expectUnchanged('object', JSON.stringify({ messageId: 'stable-1', read: false }));
  });

  it('ignores missing inbox files and avoids writes when no ids match', async () => {
    const teamsRoot = await makeTeamsRoot();

    await expect(
      markTeamInboxMessagesRead({
        teamName: 'team-a',
        member: 'missing',
        teamsBasePath: teamsRoot,
        messages: [{ messageId: 'stable-1' }],
        readRegularFileUtf8,
        timeoutMs: 5_000,
        maxBytes: 2 * 1024 * 1024,
      })
    ).resolves.toBeUndefined();

    const inboxDir = path.join(teamsRoot, 'team-a', 'inboxes');
    const inboxPath = path.join(inboxDir, 'lead.json');
    const raw = JSON.stringify(
      [
        {
          messageId: 'stable-1',
          from: 'worker-a',
          timestamp: '2026-01-01T00:00:00.000Z',
          text: 'stable',
          read: false,
        },
      ],
      null,
      2
    );
    await mkdir(inboxDir, { recursive: true });
    await writeFile(inboxPath, raw);

    await markTeamInboxMessagesRead({
      teamName: 'team-a',
      member: 'lead',
      teamsBasePath: teamsRoot,
      messages: [{ messageId: '' }, { messageId: '   ' }, { messageId: 'missing' }],
      readRegularFileUtf8,
      timeoutMs: 5_000,
      maxBytes: 2 * 1024 * 1024,
    });

    expect(await readFile(inboxPath, 'utf8')).toBe(raw);
  });

  it('rejects unsafe team and member path segments before reading inbox files', async () => {
    const teamsRoot = await makeTeamsRoot();
    const readFileSpy = vi.fn(readRegularFileUtf8);

    await expect(
      markTeamInboxMessagesRead({
        teamName: '../outside',
        member: 'lead',
        teamsBasePath: teamsRoot,
        messages: [{ messageId: 'stable-1' }],
        readRegularFileUtf8: readFileSpy,
        timeoutMs: 5_000,
        maxBytes: 2 * 1024 * 1024,
      })
    ).resolves.toBeUndefined();

    await expect(
      markTeamInboxMessagesRead({
        teamName: 'team-a',
        member: '../lead',
        teamsBasePath: teamsRoot,
        messages: [{ messageId: 'stable-1' }],
        readRegularFileUtf8: readFileSpy,
        timeoutMs: 5_000,
        maxBytes: 2 * 1024 * 1024,
      })
    ).resolves.toBeUndefined();

    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('does not follow symlinked inbox files when marking rows read', async () => {
    const teamsRoot = await makeTeamsRoot();
    const inboxDir = path.join(teamsRoot, 'team-a', 'inboxes');
    const inboxPath = path.join(inboxDir, 'lead.json');
    const outsidePath = path.join(teamsRoot, 'outside.json');
    await mkdir(inboxDir, { recursive: true });
    await writeFile(outsidePath, JSON.stringify([{ messageId: 'stable-1', read: false }], null, 2));
    try {
      await symlink(outsidePath, inboxPath);
    } catch {
      return;
    }
    const readFileSpy = vi.fn(readRegularFileUtf8);

    await markTeamInboxMessagesRead({
      teamName: 'team-a',
      member: 'lead',
      teamsBasePath: teamsRoot,
      messages: [{ messageId: 'stable-1' }],
      readRegularFileUtf8: readFileSpy,
      timeoutMs: 5_000,
      maxBytes: 2 * 1024 * 1024,
    });

    expect(readFileSpy).not.toHaveBeenCalled();
    expect(await readlink(inboxPath)).toBe(outsidePath);
    expect(JSON.parse(await readFile(outsidePath, 'utf8'))).toEqual([
      { messageId: 'stable-1', read: false },
    ]);
  });
});

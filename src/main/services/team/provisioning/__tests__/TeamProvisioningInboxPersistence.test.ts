import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

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

    const rows = JSON.parse(await readFile(inboxPath, 'utf8')) as Array<{ read?: boolean }>;
    expect(rows.map((row) => row.read)).toEqual([true, true, false]);
  });
});

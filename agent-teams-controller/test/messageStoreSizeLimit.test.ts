import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const store = createRequire(import.meta.url)('../src/internal/messageStore.js') as {
  sendInboxMessageAsync(
    paths: { teamDir: string },
    flags: Record<string, unknown>
  ): Promise<unknown>;
};

it.each(['private', 'mixed', 'group-history', 'group-write'])(
  'keeps the storage size limit scoped to group content (%s)',
  async (kind) => {
    const teamDir = await mkdtemp(join(tmpdir(), 'controller-size-boundary-'));
    const inbox = join(teamDir, 'inboxes', 'alice.json');
    const groupFields = {
      groupChatId: 'group',
      groupMessageId: 'canonical',
      groupChatProtocolVersion: 1,
      groupRunKey: 'run:alice',
    };
    const row = {
      from: 'user',
      to: 'alice',
      messageId: 'existing',
      read: false,
      text: kind === 'group-write' ? 'Private history' : 'x'.repeat(10 * 1024 * 1024),
      timestamp: '2026-10-10T00:00:00.000Z',
      ...(kind === 'group-history' ? groupFields : {}),
    };
    const originalRows = [row];
    if (kind === 'mixed')
      originalRows.push({
        ...row,
        ...groupFields,
        messageId: 'small-group',
        text: 'Small group history',
      });
    try {
      await mkdir(join(teamDir, 'inboxes'));
      const original = JSON.stringify(originalRows);
      await writeFile(inbox, original);
      const send = store.sendInboxMessageAsync(
        { teamDir },
        {
          from: 'user',
          member: 'alice',
          messageId: 'next',
          text: 'Next private message',
          ...(kind === 'group-write' ? { ...groupFields, text: 'x'.repeat(10 * 1024 * 1024) } : {}),
        }
      );
      if (kind === 'group-write') {
        await expect(send).rejects.toThrow('size limit exceeded');
        expect(await readFile(inbox, 'utf8')).toBe(original);
      } else {
        await expect(send).resolves.toMatchObject({ deliveredToInbox: true, messageId: 'next' });
        const rows = JSON.parse(await readFile(inbox, 'utf8')) as Record<string, unknown>[];
        expect(rows).toHaveLength(originalRows.length + 1);
        expect(rows.slice(0, -1)).toEqual(originalRows);
        expect(rows.at(-1)).toMatchObject({ messageId: 'next', text: 'Next private message' });
      }
    } finally {
      await rm(teamDir, { recursive: true, force: true });
    }
  }
);

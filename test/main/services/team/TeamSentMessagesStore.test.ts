import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamSentMessagesStore } from '../../../../src/main/services/team/TeamSentMessagesStore';

const tempDirs: string[] = [];

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => tempDirs[tempDirs.length - 1],
}));

describe('TeamSentMessagesStore', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
      })
    );
  });

  it('preserves slash-command metadata when reading sent messages', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-sent-store-'));
    tempDirs.push(root);

    const teamDir = path.join(root, 'my-team');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'sentMessages.json'),
      JSON.stringify(
        [
          {
            from: 'user',
            to: 'team-lead',
            text: '/model sonnet',
            timestamp: '2026-03-27T12:00:00.000Z',
            read: true,
            messageId: 'msg-1',
            source: 'user_sent',
            messageKind: 'slash_command',
            slashCommand: {
              name: 'model',
              command: '/model',
              args: 'sonnet',
              knownDescription: 'Select or change the active model.',
            },
          },
          {
            from: 'team-lead',
            text: 'Model set to sonnet',
            timestamp: '2026-03-27T12:00:01.000Z',
            read: true,
            messageId: 'msg-2',
            source: 'lead_session',
            messageKind: 'slash_command_result',
            commandOutput: {
              stream: 'stdout',
              commandLabel: '/model',
            },
          },
        ],
        null,
        2
      ),
      'utf8'
    );

    const store = new TeamSentMessagesStore();
    const messages = await store.readMessages('my-team');

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      messageKind: 'slash_command',
      slashCommand: {
        name: 'model',
        command: '/model',
        args: 'sonnet',
        knownDescription: 'Select or change the active model.',
      },
    });
    expect(messages[1]).toMatchObject({
      messageKind: 'slash_command_result',
      commandOutput: {
        stream: 'stdout',
        commandLabel: '/model',
      },
    });
  });

  it('caps legacy sent message files to the newest messages on read', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-sent-store-'));
    tempDirs.push(root);

    const teamDir = path.join(root, 'my-team');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'sentMessages.json'),
      JSON.stringify(
        Array.from({ length: 205 }, (_, index) => ({
          from: 'user',
          to: 'team-lead',
          text: `message ${index}`,
          timestamp: new Date(Date.UTC(2026, 2, 27, 12, 0, index)).toISOString(),
          read: true,
          messageId: `sent-${index}`,
          source: 'user_sent',
        }))
      ),
      'utf8'
    );

    const store = new TeamSentMessagesStore();
    const messages = await store.readMessages('my-team');

    expect(messages).toHaveLength(200);
    expect(messages[0].messageId).toBe('sent-5');
    expect(messages.at(-1)?.messageId).toBe('sent-204');
  });

  it('does not overwrite corrupt sent message history when appending', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-sent-store-'));
    tempDirs.push(root);

    const teamDir = path.join(root, 'my-team');
    const sentMessagesPath = path.join(teamDir, 'sentMessages.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(sentMessagesPath, 'NOT VALID JSON', 'utf8');

    const store = new TeamSentMessagesStore();
    expect(await store.readMessages('my-team')).toEqual([]);

    await store.appendMessage('my-team', {
      from: 'alice',
      to: 'user',
      text: 'should not replace corrupt history',
      timestamp: '2026-03-27T12:00:00.000Z',
      read: true,
      messageId: 'msg-after-corruption',
    });

    expect(console.error).toHaveBeenCalledWith(
      '[TeamSentMessagesStore]',
      expect.stringContaining('Failed to append sent message for my-team')
    );
    vi.mocked(console.error).mockClear();
    await expect(fs.readFile(sentMessagesPath, 'utf8')).resolves.toBe('NOT VALID JSON');
  });
});

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
              knownDescription: 'Select or change the Claude model.',
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
        knownDescription: 'Select or change the Claude model.',
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
});

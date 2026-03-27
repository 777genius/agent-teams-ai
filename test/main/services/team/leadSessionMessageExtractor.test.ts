import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { extractLeadSessionMessagesFromJsonl } from '../../../../src/main/services/team/leadSessionMessageExtractor';

function createUserEntry(
  uuid: string,
  timestamp: string,
  content: string
): Record<string, unknown> {
  return {
    uuid,
    parentUuid: null,
    type: 'user',
    timestamp,
    isSidechain: false,
    userType: 'external',
    cwd: '/repo',
    sessionId: 'lead-1',
    version: '1.0.0',
    gitBranch: 'main',
    message: {
      role: 'user',
      content,
    },
  };
}

function createAssistantEntry(
  uuid: string,
  timestamp: string,
  text: string
): Record<string, unknown> {
  return {
    uuid,
    parentUuid: null,
    type: 'assistant',
    timestamp,
    isSidechain: false,
    userType: 'external',
    cwd: '/repo',
    sessionId: 'lead-1',
    version: '1.0.0',
    gitBranch: 'main',
    requestId: `req-${uuid}`,
    message: {
      role: 'assistant',
      model: 'claude-sonnet',
      id: `msg-${uuid}`,
      type: 'message',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
      content: [{ type: 'text', text }],
    },
  };
}

describe('extractLeadSessionMessagesFromJsonl', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map(async (tempPath) => {
        await fs.rm(tempPath, { recursive: true, force: true });
      })
    );
  });

  it('extracts and merges command outputs without duplicating command rows', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lead-session-extractor-'));
    tempPaths.push(dir);
    const jsonlPath = path.join(dir, 'lead-1.jsonl');

    const lines = [
      createUserEntry(
        'user-slash-1',
        '2026-03-27T12:00:00.000Z',
        '<command-name>/model</command-name><command-message>model</command-message><command-args>sonnet</command-args>'
      ),
      createUserEntry(
        'stdout-1',
        '2026-03-27T12:00:01.000Z',
        '<local-command-stdout>Model set to sonnet</local-command-stdout>'
      ),
      createUserEntry(
        'stdout-2',
        '2026-03-27T12:00:02.000Z',
        '<local-command-stdout>Context usage reset</local-command-stdout>'
      ),
      createAssistantEntry('assistant-1', '2026-03-27T12:00:03.000Z', 'Regular assistant text'),
      createUserEntry(
        'stderr-1',
        '2026-03-27T12:00:04.000Z',
        '<local-command-stderr>Warning: using cached model alias</local-command-stderr>'
      ),
      createUserEntry('user-plain-1', '2026-03-27T12:00:05.000Z', 'hello'),
      createUserEntry(
        'stdout-3',
        '2026-03-27T12:00:06.000Z',
        '<local-command-stdout>Detached output</local-command-stdout>'
      ),
    ].map((entry) => JSON.stringify(entry));

    await fs.writeFile(jsonlPath, `${lines.join('\n')}\n`, 'utf8');

    const messages = await extractLeadSessionMessagesFromJsonl({
      jsonlPath,
      leadName: 'team-lead',
      leadSessionId: 'lead-1',
      maxMessages: 20,
    });

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      from: 'team-lead',
      messageKind: 'slash_command_result',
      commandOutput: {
        stream: 'stdout',
        commandLabel: '/model',
      },
      text: 'Model set to sonnet\nContext usage reset',
      summary: 'Model set to sonnet',
    });
    expect(messages[1]).toMatchObject({
      messageKind: 'slash_command_result',
      commandOutput: {
        stream: 'stderr',
        commandLabel: '/model',
      },
      text: 'Warning: using cached model alias',
    });
    expect(messages[2]).toMatchObject({
      messageKind: 'slash_command_result',
      commandOutput: {
        stream: 'stdout',
        commandLabel: '/command',
      },
      text: 'Detached output',
    });
  });
});

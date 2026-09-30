import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TeamLeadSessionMessageReader,
  type TeamLeadSessionMessageReaderProjectResolver,
} from '../../../../src/features/team-view-read-model/main';
import { LeadSessionParseCache } from '../../../../src/features/team-view-read-model/main/application/LeadSessionParseCache';
import { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';
import { TeamTranscriptProjectResolver } from '../../../../src/main/services/team/TeamTranscriptProjectResolver';
import { encodePath, setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { InboxMessage, TeamConfig } from '../../../../src/shared/types/team';

const tempPaths: string[] = [];

type TeamLeadSessionMessageReaderPrivate = {
  extractLeadAssistantTextsFromJsonlLines(
    rawLines: readonly string[],
    leadName: string,
    leadSessionId: string,
    maxTexts: number
  ): Promise<InboxMessage[]>;
  extractLeadSessionTextsFromJsonl(
    jsonlPath: string,
    leadName: string,
    leadSessionId: string,
    maxTexts: number
  ): Promise<InboxMessage[]>;
  getLeadSessionJsonlPaths(projectDir: string): Promise<Map<string, string>>;
};

function readerPrivate(reader: TeamLeadSessionMessageReader): TeamLeadSessionMessageReaderPrivate {
  return reader as unknown as TeamLeadSessionMessageReaderPrivate;
}

function createReader(
  projectResolver: TeamLeadSessionMessageReaderProjectResolver = {
    getLiveBaseContext: vi.fn(async () => null),
    getContext: vi.fn(async () => null),
  },
  cache = new LeadSessionParseCache()
): TeamLeadSessionMessageReader {
  return new TeamLeadSessionMessageReader(projectResolver, cache);
}

function createLeadAssistantEntry(
  uuid: string,
  timestamp: string,
  text: string,
  options?: { model?: string; content?: Record<string, unknown>[] }
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
      model: options?.model ?? 'claude-sonnet',
      id: `msg-${uuid}`,
      type: 'message',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
      content: options?.content ?? [{ type: 'text', text }],
    },
  };
}

function createSyntheticLeadAssistantChunk(
  uuid: string,
  timestamp: string,
  text: string
): Record<string, unknown> {
  return {
    ...createLeadAssistantEntry(uuid, timestamp, text),
    message: {
      role: 'assistant',
      model: '<synthetic>',
      id: `msg-${uuid}`,
      type: 'message',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
      content: [{ type: 'text', text }],
    },
  };
}

function createSyntheticLeadApiErrorEntry(
  uuid: string,
  timestamp: string,
  text: string
): Record<string, unknown> {
  return {
    ...createSyntheticLeadAssistantChunk(uuid, timestamp, text),
    error: 'rate_limit',
    isApiErrorMessage: true,
    entrypoint: 'sdk-cli',
  };
}

async function createTempJsonl(
  entries: Record<string, unknown>[],
  options?: { dirName?: string; sessionId?: string }
): Promise<string> {
  const dir = options?.dirName
    ? path.join(os.tmpdir(), options.dirName)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'team-lead-session-reader-'));
  if (options?.dirName) {
    await fs.mkdir(dir, { recursive: true });
  }
  tempPaths.push(dir);
  const jsonlPath = path.join(dir, `${options?.sessionId ?? 'lead-1'}.jsonl`);
  await fs.writeFile(
    jsonlPath,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8'
  );
  return jsonlPath;
}

function extract(
  reader: TeamLeadSessionMessageReader,
  jsonlPath: string,
  leadName = 'team-lead',
  leadSessionId = 'lead-1',
  maxTexts = 150
): Promise<InboxMessage[]> {
  return readerPrivate(reader).extractLeadSessionTextsFromJsonl(
    jsonlPath,
    leadName,
    leadSessionId,
    maxTexts
  );
}

function config(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    name: 'My team',
    members: [{ name: 'team-lead', role: 'Lead' }],
    leadSessionId: 'lead-1',
    ...overrides,
  };
}

async function createResolverBackedLeadFixture(options?: {
  teamName?: string;
  staleProjectPath?: string;
  actualProjectPath?: string;
  leadSessionId?: string;
  sessionHistory?: string[];
  sessionFileId?: string;
}): Promise<{
  claudeRoot: string;
  teamName: string;
  configPath: string;
  staleProjectPath: string;
  actualProjectPath: string;
  actualProjectDir: string;
  config: TeamConfig;
}> {
  const teamName = options?.teamName ?? 'my-team';
  const staleProjectPath = options?.staleProjectPath ?? '/Users/test/hookplex';
  const actualProjectPath = options?.actualProjectPath ?? '/Users/test/plugin-kit-ai';
  const leadSessionId = options?.leadSessionId ?? 'lead-1';
  const sessionFileId = options?.sessionFileId ?? leadSessionId;
  const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-lead-session-resolver-'));
  tempPaths.push(claudeRoot);
  setClaudeBasePathOverride(claudeRoot);

  await fs.mkdir(path.join(claudeRoot, 'teams', teamName), { recursive: true });
  await fs.mkdir(path.join(claudeRoot, 'projects', encodePath(staleProjectPath)), {
    recursive: true,
  });

  const teamConfig = config({
    name: 'My Team',
    projectPath: staleProjectPath,
    leadSessionId: leadSessionId || undefined,
    ...(options?.sessionHistory ? { sessionHistory: options.sessionHistory } : {}),
    members: [{ name: 'team-lead', agentType: 'team-lead', cwd: actualProjectPath }],
  });
  const configPath = path.join(claudeRoot, 'teams', teamName, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(teamConfig, null, 2), 'utf8');

  const actualProjectDir = path.join(claudeRoot, 'projects', encodePath(actualProjectPath));
  await fs.mkdir(actualProjectDir, { recursive: true });
  await fs.writeFile(
    path.join(actualProjectDir, `${sessionFileId}.jsonl`),
    `${JSON.stringify({
      teamName,
      type: 'assistant',
      timestamp: '2026-04-18T10:00:00.000Z',
      cwd: actualProjectPath,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'This is a sufficiently long lead thought recovered through the transcript resolver.',
          },
        ],
      },
    })}\n`,
    'utf8'
  );

  return {
    claudeRoot,
    teamName,
    configPath,
    staleProjectPath,
    actualProjectPath,
    actualProjectDir,
    config: teamConfig,
  };
}

function createResolverBackedReader(): TeamLeadSessionMessageReader {
  return createReader(new TeamTranscriptProjectResolver(new TeamConfigReader()));
}

afterEach(async () => {
  setClaudeBasePathOverride(null);
  vi.restoreAllMocks();
  await Promise.all(
    tempPaths.splice(0).map(async (tempPath) => {
      await fs.rm(tempPath, { recursive: true, force: true });
    })
  );
});

describe('TeamLeadSessionMessageReader', () => {
  it('coalesces Codex synthetic lead stream chunks into one lead-session message', async () => {
    const reader = createReader();
    const jsonlPath = await createTempJsonl([
      createSyntheticLeadAssistantChunk('chunk-1', '2026-03-27T22:17:01.000Z', 'Соз'),
      createSyntheticLeadAssistantChunk('chunk-2', '2026-03-27T22:17:01.010Z', 'дал'),
      createSyntheticLeadAssistantChunk(
        'chunk-3',
        '2026-03-27T22:17:01.020Z',
        ' стартовую задачу для /212 и раздал работу.'
      ),
    ]);

    const messages = await extract(reader, jsonlPath);

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: 'lead-thought-stream-chunk-1',
        text: 'Создал стартовую задачу для /212 и раздал работу.',
      }),
    ]);
  });

  it('extracts Claude synthetic quota errors as lead-session messages', async () => {
    const reader = createReader();
    const jsonlPath = await createTempJsonl([
      createSyntheticLeadApiErrorEntry(
        'quota-1',
        '2026-07-01T20:46:55.944Z',
        "You're out of extra usage · resets 11:50pm (Europe/Kiev)"
      ),
    ]);

    const messages = await extract(reader, jsonlPath);

    expect(messages).toEqual([
      expect.objectContaining({
        from: 'team-lead',
        source: 'lead_session',
        leadSessionId: 'lead-1',
        messageId: 'lead-thought-stream-quota-1',
        text: "You're out of extra usage · resets 11:50pm (Europe/Kiev)",
      }),
    ]);
  });

  it('caches unchanged results and returns defensive clones of nested projections', async () => {
    const reader = createReader();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought for cache validation.'
      ),
      createLeadAssistantEntry('tool-1', '2026-03-27T22:17:01.100Z', '', {
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.ts' } }],
      }),
    ]);
    const assistantSpy = vi.spyOn(readerPrivate(reader), 'extractLeadAssistantTextsFromJsonlLines');

    const first = await extract(reader, jsonlPath);
    first[0]!.text = 'mutated locally';
    first[0]!.toolCalls![0]!.name = 'mutated tool';
    const second = await extract(reader, jsonlPath);

    expect(assistantSpy).toHaveBeenCalledTimes(1);
    expect(second[0]?.text).toBe(
      'This is a sufficiently long assistant thought for cache validation.'
    );
    expect(second[0]?.toolCalls?.[0]?.name).toBe('Read');
  });

  it('coalesces concurrent parses for the same file signature', async () => {
    const reader = createReader();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought for in-flight coalescing.'
      ),
    ]);
    const privateReader = readerPrivate(reader);
    const originalExtract = privateReader.extractLeadAssistantTextsFromJsonlLines.bind(reader);
    const assistantSpy = vi
      .spyOn(privateReader, 'extractLeadAssistantTextsFromJsonlLines')
      .mockImplementation(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return originalExtract(...args);
      });

    const [first, second] = await Promise.all([
      extract(reader, jsonlPath),
      extract(reader, jsonlPath),
    ]);

    expect(assistantSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('does not populate the fulfilled cache when the file changes during parse', async () => {
    const reader = createReader();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought before mutation.'
      ),
    ]);
    const privateReader = readerPrivate(reader);
    const originalExtract = privateReader.extractLeadAssistantTextsFromJsonlLines.bind(reader);
    let appended = false;
    const assistantSpy = vi
      .spyOn(privateReader, 'extractLeadAssistantTextsFromJsonlLines')
      .mockImplementation(async (...args) => {
        if (!appended) {
          appended = true;
          await fs.appendFile(
            jsonlPath,
            `${JSON.stringify(
              createLeadAssistantEntry(
                'assistant-2',
                '2026-03-27T22:17:02.000Z',
                'This is a sufficiently long assistant thought appended during parse.'
              )
            )}\n`,
            'utf8'
          );
        }
        return originalExtract(...args);
      });

    const first = await extract(reader, jsonlPath);
    const second = await extract(reader, jsonlPath);

    expect(assistantSpy).toHaveBeenCalledTimes(2);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it('does not reuse an older in-flight parse after the file signature changes', async () => {
    const reader = createReader();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought before concurrent signature change.'
      ),
    ]);
    const privateReader = readerPrivate(reader);
    const originalExtract = privateReader.extractLeadAssistantTextsFromJsonlLines.bind(reader);
    let releaseFirstInvocation = () => {};
    let firstInvocationStartedResolve: (() => void) | null = null;
    const firstInvocationStarted = new Promise<void>((resolve) => {
      firstInvocationStartedResolve = resolve;
    });
    const assistantSpy = vi
      .spyOn(privateReader, 'extractLeadAssistantTextsFromJsonlLines')
      .mockImplementation(async (...args) => {
        if (assistantSpy.mock.calls.length === 1) {
          firstInvocationStartedResolve?.();
          await new Promise<void>((resolve) => {
            releaseFirstInvocation = resolve;
          });
        }
        return originalExtract(...args);
      });

    const firstPromise = extract(reader, jsonlPath);
    await firstInvocationStarted;
    await fs.appendFile(
      jsonlPath,
      `${JSON.stringify(
        createLeadAssistantEntry(
          'assistant-2',
          '2026-03-27T22:17:02.000Z',
          'This is a sufficiently long assistant thought appended before the second caller.'
        )
      )}\n`,
      'utf8'
    );
    const secondPromise = extract(reader, jsonlPath);
    releaseFirstInvocation();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(assistantSpy).toHaveBeenCalledTimes(2);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it('keeps leadName and maxTexts in the cache identity', async () => {
    const reader = createReader();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought for keying behavior one.'
      ),
      createLeadAssistantEntry(
        'assistant-2',
        '2026-03-27T22:17:02.000Z',
        'This is a sufficiently long assistant thought for keying behavior two.'
      ),
    ]);
    const assistantSpy = vi.spyOn(readerPrivate(reader), 'extractLeadAssistantTextsFromJsonlLines');

    const firstLead = await extract(reader, jsonlPath, 'team-lead', 'lead-1', 1);
    const secondLeadSameKey = await extract(reader, jsonlPath, 'team-lead', 'lead-1', 1);
    const renamedLead = await extract(reader, jsonlPath, 'captain', 'lead-1', 1);
    const widerSlice = await extract(reader, jsonlPath, 'team-lead', 'lead-1', 2);

    expect(firstLead).toHaveLength(1);
    expect(secondLeadSameKey).toHaveLength(1);
    expect(renamedLead[0]?.from).toBe('captain');
    expect(widerSlice).toHaveLength(2);
    expect(assistantSpy).toHaveBeenCalledTimes(3);
  });

  it('does not return stale cached content when the jsonl file is deleted', async () => {
    const reader = createReader();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought before file deletion.'
      ),
    ]);
    const assistantSpy = vi.spyOn(readerPrivate(reader), 'extractLeadAssistantTextsFromJsonlLines');

    const first = await extract(reader, jsonlPath);
    await fs.rm(jsonlPath, { force: true });

    await expect(extract(reader, jsonlPath)).rejects.toThrow();
    expect(first).toHaveLength(1);
    expect(assistantSpy).toHaveBeenCalledTimes(1);
  });

  it('tolerates a partial trailing line without keeping a sticky stale result', async () => {
    const reader = createReader();
    const firstEntry = createLeadAssistantEntry(
      'assistant-1',
      '2026-03-27T22:17:01.000Z',
      'This is a sufficiently long assistant thought before partial trailing data.'
    );
    const secondEntry = createLeadAssistantEntry(
      'assistant-2',
      '2026-03-27T22:17:02.000Z',
      'This is a sufficiently long assistant thought after the file was fixed.'
    );
    const jsonlPath = await createTempJsonl([firstEntry]);
    await fs.appendFile(jsonlPath, '{"type":"assistant"', 'utf8');
    const assistantSpy = vi.spyOn(readerPrivate(reader), 'extractLeadAssistantTextsFromJsonlLines');

    const partialRead = await extract(reader, jsonlPath);
    await fs.writeFile(
      jsonlPath,
      `${JSON.stringify(firstEntry)}\n${JSON.stringify(secondEntry)}\n`,
      'utf8'
    );
    const repairedRead = await extract(reader, jsonlPath);

    expect(partialRead).toHaveLength(1);
    expect(repairedRead).toHaveLength(2);
    expect(assistantSpy).toHaveBeenCalledTimes(2);
  });

  it('matches a lead session filename containing both dashes and underscores', async () => {
    const sessionId = 'lead-session_cache-check';
    const jsonlPath = await createTempJsonl(
      [
        createLeadAssistantEntry(
          'assistant-1',
          '2026-03-27T22:17:01.000Z',
          'This is a sufficiently long assistant thought for mixed path characters.'
        ),
      ],
      { dirName: 'team_data-lead-session-cache-check', sessionId }
    );
    const projectDir = path.dirname(jsonlPath);
    const projectResolver: TeamLeadSessionMessageReaderProjectResolver = {
      getLiveBaseContext: vi.fn(async () => ({
        projectDir,
        config: config({ leadSessionId: sessionId }),
      })),
      getContext: vi.fn(async () => null),
    };
    const reader = createReader(projectResolver);
    const assistantSpy = vi.spyOn(readerPrivate(reader), 'extractLeadAssistantTextsFromJsonlLines');

    const first = await reader.read('my-team', config({ leadSessionId: sessionId }));
    const second = await reader.read('my-team', config({ leadSessionId: sessionId }));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.leadSessionId).toBe(sessionId);
    expect(assistantSpy).toHaveBeenCalledTimes(1);
  });

  it('does not keep a rejected in-flight parse sticky across retries', async () => {
    const reader = createReader();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought before retry after failure.'
      ),
    ]);
    const privateReader = readerPrivate(reader);
    const originalExtract = privateReader.extractLeadAssistantTextsFromJsonlLines.bind(reader);
    let shouldFail = true;
    const assistantSpy = vi
      .spyOn(privateReader, 'extractLeadAssistantTextsFromJsonlLines')
      .mockImplementation(async (...args) => {
        if (shouldFail) {
          throw new Error('transient parse failure');
        }
        return originalExtract(...args);
      });

    await expect(extract(reader, jsonlPath)).rejects.toThrow('transient parse failure');
    shouldFail = false;
    const retryResult = await extract(reader, jsonlPath);

    expect(retryResult).toHaveLength(1);
    expect(assistantSpy).toHaveBeenCalledTimes(2);
  });

  it('does not share cache state across fresh reader instances', async () => {
    const firstReader = createReader();
    const secondReader = createReader();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought for service instance isolation.'
      ),
    ]);
    const firstSpy = vi.spyOn(
      readerPrivate(firstReader),
      'extractLeadAssistantTextsFromJsonlLines'
    );
    const secondSpy = vi.spyOn(
      readerPrivate(secondReader),
      'extractLeadAssistantTextsFromJsonlLines'
    );

    await extract(firstReader, jsonlPath);
    await extract(secondReader, jsonlPath);

    expect(firstSpy).toHaveBeenCalledTimes(1);
    expect(secondSpy).toHaveBeenCalledTimes(1);
  });

  it('reads only the bounded transcript tail and ignores a partial leading line', async () => {
    const reader = createReader();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-lead-session-bounded-'));
    tempPaths.push(dir);
    const jsonlPath = path.join(dir, 'lead-1.jsonl');
    const oldEntry = JSON.stringify(
      createLeadAssistantEntry(
        'old-assistant',
        '2026-03-27T20:00:00.000Z',
        'This old assistant thought is outside the bounded transcript tail.'
      )
    );
    const tailEntry = JSON.stringify(
      createLeadAssistantEntry(
        'tail-assistant',
        '2026-03-27T22:17:01.000Z',
        'This recent assistant thought is inside the bounded transcript tail.'
      )
    );
    const padding = `\n${'x'.repeat(8 * 1024 * 1024)}\n`;
    await fs.writeFile(jsonlPath, `${oldEntry}${padding}${tailEntry}\n`, 'utf8');

    const messages = await extract(reader, jsonlPath);

    expect(messages.map((message) => message.messageId)).toEqual(['lead-thought-tail-assistant']);
  });

  it('preserves assistant and command-result ordering, IDs, and projections', async () => {
    const reader = createReader();
    const jsonlPath = await createTempJsonl([
      {
        uuid: 'slash-1',
        type: 'user',
        timestamp: '2026-03-27T22:17:00.000Z',
        message: {
          role: 'user',
          content:
            '<command-name>/cost</command-name><command-message>cost</command-message><command-args></command-args>',
        },
      },
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long lead thought before command output.'
      ),
      {
        uuid: 'command-1',
        type: 'user',
        timestamp: '2026-03-27T22:17:02.000Z',
        message: {
          role: 'user',
          content: '<local-command-stdout>Total cost: $1.23</local-command-stdout>',
        },
      },
    ]);

    const messages = await extract(reader, jsonlPath);

    expect(messages.map((message) => message.messageId)).toEqual([
      'lead-thought-assistant-1',
      'lead-command-result-command-1',
    ]);
    expect(messages[1]).toMatchObject({
      text: 'Total cost: $1.23',
      messageKind: 'slash_command_result',
      commandOutput: { stream: 'stdout', commandLabel: '/cost' },
    });
  });

  it('uses live base context without full transcript discovery', async () => {
    const projectResolver: TeamLeadSessionMessageReaderProjectResolver = {
      getLiveBaseContext: vi.fn(async () => ({
        projectDir: '/fast-project',
        config: config({
          members: [{ name: 'fast-lead', agentType: 'lead' }],
        }),
      })),
      getContext: vi.fn(async () => {
        throw new Error('full transcript discovery should not be used');
      }),
    };
    const reader = createReader(projectResolver);
    vi.spyOn(readerPrivate(reader), 'getLeadSessionJsonlPaths').mockResolvedValue(
      new Map([['lead-1', '/fast-project/lead-1.jsonl']])
    );
    vi.spyOn(readerPrivate(reader), 'extractLeadSessionTextsFromJsonl').mockResolvedValue([
      {
        from: 'fast-lead',
        text: 'Fast path recovered lead thought from the known lead session.',
        timestamp: '2026-04-18T10:00:00.000Z',
        read: true,
        source: 'lead_session',
        leadSessionId: 'lead-1',
        messageId: 'lead-fast-1',
      },
    ]);

    const messages = await reader.read('my-team', config());

    expect(projectResolver.getLiveBaseContext).toHaveBeenCalledWith('my-team');
    expect(projectResolver.getContext).not.toHaveBeenCalled();
    expect(messages.some((message) => message.messageId === 'lead-fast-1')).toBe(true);
  });

  it('falls back to lightweight transcript context when the live path is stale', async () => {
    const projectResolver: TeamLeadSessionMessageReaderProjectResolver = {
      getLiveBaseContext: vi.fn(async () => ({
        projectDir: '/stale-project',
        config: config({
          members: [{ name: 'stale-lead', agentType: 'lead' }],
        }),
      })),
      getContext: vi.fn(async () => ({
        projectDir: '/actual-project',
        config: config({
          members: [{ name: 'actual-lead', agentType: 'lead' }],
        }),
      })),
    };
    const reader = createReader(projectResolver);
    vi.spyOn(readerPrivate(reader), 'getLeadSessionJsonlPaths').mockImplementation(
      async (projectDir) =>
        projectDir === '/actual-project'
          ? new Map([['lead-1', '/actual-project/lead-1.jsonl']])
          : new Map()
    );
    vi.spyOn(readerPrivate(reader), 'extractLeadSessionTextsFromJsonl').mockResolvedValue([
      {
        from: 'actual-lead',
        text: 'Fallback path recovered lead thought from the repaired context.',
        timestamp: '2026-04-18T10:00:00.000Z',
        read: true,
        source: 'lead_session',
        leadSessionId: 'lead-1',
        messageId: 'lead-fallback-1',
      },
    ]);

    const messages = await reader.read('my-team', config());

    expect(projectResolver.getContext).toHaveBeenCalledWith('my-team', {
      includeTeamSubagentSessionDiscovery: false,
    });
    expect(messages.some((message) => message.messageId === 'lead-fallback-1')).toBe(true);
  });

  it('prefers the current lead session over older session history', async () => {
    const inputConfig = config({
      leadSessionId: 'lead-current',
      sessionHistory: ['lead-history'],
    });
    const projectResolver: TeamLeadSessionMessageReaderProjectResolver = {
      getLiveBaseContext: vi.fn(async () => ({
        projectDir: '/history-project',
        config: config({
          members: [{ name: 'history-lead', agentType: 'lead' }],
          leadSessionId: 'lead-current',
          sessionHistory: ['lead-history'],
        }),
      })),
      getContext: vi.fn(async () => ({
        projectDir: '/current-project',
        config: config({
          members: [{ name: 'current-lead', agentType: 'lead' }],
          leadSessionId: 'lead-current',
          sessionHistory: ['lead-history'],
        }),
      })),
    };
    const reader = createReader(projectResolver);
    vi.spyOn(readerPrivate(reader), 'getLeadSessionJsonlPaths').mockImplementation(
      async (projectDir) =>
        projectDir === '/current-project'
          ? new Map([['lead-current', '/current-project/lead-current.jsonl']])
          : new Map([['lead-history', '/history-project/lead-history.jsonl']])
    );
    const extractSpy = vi
      .spyOn(readerPrivate(reader), 'extractLeadSessionTextsFromJsonl')
      .mockResolvedValue([
        {
          from: 'current-lead',
          text: 'Current lead session wins over older session history.',
          timestamp: '2026-04-18T10:00:00.000Z',
          read: true,
          source: 'lead_session',
          leadSessionId: 'lead-current',
          messageId: 'lead-current-1',
        },
      ]);

    const messages = await reader.read('my-team', inputConfig);

    expect(projectResolver.getContext).toHaveBeenCalledWith('my-team', {
      includeTeamSubagentSessionDiscovery: false,
    });
    expect(extractSpy).toHaveBeenCalledWith(
      '/current-project/lead-current.jsonl',
      'current-lead',
      'lead-current',
      150
    );
    expect(messages.some((message) => message.messageId === 'lead-current-1')).toBe(true);
  });

  it('refreshes lead paths when fallback keeps the same project directory', async () => {
    const inputConfig = config({
      leadSessionId: 'lead-current',
      sessionHistory: ['lead-history'],
    });
    const projectResolver: TeamLeadSessionMessageReaderProjectResolver = {
      getLiveBaseContext: vi.fn(async () => ({
        projectDir: '/same-project',
        config: config({
          members: [{ name: 'history-lead', agentType: 'lead' }],
          leadSessionId: 'lead-current',
          sessionHistory: ['lead-history'],
        }),
      })),
      getContext: vi.fn(async () => ({
        projectDir: '/same-project',
        config: config({
          members: [{ name: 'current-lead', agentType: 'lead' }],
          leadSessionId: 'lead-current',
          sessionHistory: ['lead-history'],
        }),
      })),
    };
    const reader = createReader(projectResolver);
    const getPathsSpy = vi
      .spyOn(readerPrivate(reader), 'getLeadSessionJsonlPaths')
      .mockResolvedValueOnce(new Map([['lead-history', '/same-project/lead-history.jsonl']]))
      .mockResolvedValueOnce(new Map([['lead-current', '/same-project/lead-current.jsonl']]));
    const extractSpy = vi
      .spyOn(readerPrivate(reader), 'extractLeadSessionTextsFromJsonl')
      .mockResolvedValue([
        {
          from: 'current-lead',
          text: 'Same-directory fallback refreshed the lead session path list.',
          timestamp: '2026-04-18T10:00:00.000Z',
          read: true,
          source: 'lead_session',
          leadSessionId: 'lead-current',
          messageId: 'lead-same-project-1',
        },
      ]);

    const messages = await reader.read('my-team', inputConfig);

    expect(getPathsSpy).toHaveBeenCalledTimes(2);
    expect(extractSpy).toHaveBeenCalledWith(
      '/same-project/lead-current.jsonl',
      'current-lead',
      'lead-current',
      150
    );
    expect(messages.some((message) => message.messageId === 'lead-same-project-1')).toBe(true);
  });

  it('loads lead-session messages and repairs a stale projectPath', async () => {
    const fixture = await createResolverBackedLeadFixture();
    const reader = createResolverBackedReader();

    const messages = await reader.read(fixture.teamName, fixture.config);
    const persistedConfig = JSON.parse(await fs.readFile(fixture.configPath, 'utf8')) as TeamConfig;

    expect(
      messages.find((message) => message.text.includes('recovered through the transcript resolver'))
    ).toBeTruthy();
    expect(persistedConfig.projectPath).toBe(fixture.actualProjectPath);
  });

  it('still returns messages when projectPath repair persistence fails', async () => {
    const fixture = await createResolverBackedLeadFixture();
    const originalWriteFile = nodeFs.promises.writeFile.bind(nodeFs.promises);
    const teamTmpPrefix = path.join(fixture.claudeRoot, 'teams', fixture.teamName, '.tmp.');
    vi.spyOn(nodeFs.promises, 'writeFile').mockImplementation(
      async (...args: Parameters<typeof nodeFs.promises.writeFile>) => {
        const [targetPath] = args;
        if (typeof targetPath === 'string' && targetPath.startsWith(teamTmpPrefix)) {
          throw new Error('simulated atomic write failure');
        }
        return originalWriteFile(...args);
      }
    );
    const reader = createResolverBackedReader();

    const messages = await reader.read(fixture.teamName, fixture.config);
    const persistedConfig = JSON.parse(await fs.readFile(fixture.configPath, 'utf8')) as TeamConfig;

    expect(
      messages.find((message) => message.text.includes('recovered through the transcript resolver'))
    ).toBeTruthy();
    expect(persistedConfig.projectPath).toBe(fixture.staleProjectPath);
  });

  it('does not guess lead sessions from resolver-discovered session ids', async () => {
    const fixture = await createResolverBackedLeadFixture({
      leadSessionId: '',
      sessionFileId: 'lead-discovered',
    });
    const reader = createResolverBackedReader();

    const messages = await reader.read(
      fixture.teamName,
      config({
        projectPath: fixture.staleProjectPath,
        leadSessionId: undefined,
        sessionHistory: undefined,
      })
    );

    expect(messages).toEqual([]);
  });

  it('does not mix resolver-discovered member sessions into lead-session messages', async () => {
    const fixture = await createResolverBackedLeadFixture();
    await fs.writeFile(
      path.join(fixture.actualProjectDir, 'member-1.jsonl'),
      `${JSON.stringify({
        teamName: fixture.teamName,
        type: 'assistant',
        timestamp: '2026-04-18T10:05:00.000Z',
        cwd: fixture.actualProjectPath,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Member bootstrap noise that should never appear as a lead_session thought in the team activity timeline.',
            },
          ],
        },
      })}\n`,
      'utf8'
    );
    const reader = createResolverBackedReader();

    const messages = await reader.read(fixture.teamName, fixture.config);

    expect(
      messages.some((message) => message.text.includes('recovered through the transcript resolver'))
    ).toBe(true);
    expect(
      messages.some((message) =>
        message.text.includes('Member bootstrap noise that should never appear')
      )
    ).toBe(false);
    expect(new Set(messages.map((message) => message.leadSessionId))).toEqual(new Set(['lead-1']));
  });

  it('reads session history newest-first, preserves chronological output, and caps at 150', async () => {
    const projectResolver: TeamLeadSessionMessageReaderProjectResolver = {
      getLiveBaseContext: vi.fn(async () => ({
        projectDir: '/project',
        config: config({ members: [{ name: 'captain', role: 'Lead' }] }),
      })),
      getContext: vi.fn(async () => null),
    };
    const reader = createReader(projectResolver);
    vi.spyOn(readerPrivate(reader), 'getLeadSessionJsonlPaths').mockResolvedValue(
      new Map([
        ['lead-current', '/project/lead-current.jsonl'],
        ['lead-oldest', '/project/lead-oldest.jsonl'],
        ['lead-newest-history', '/project/lead-newest-history.jsonl'],
      ])
    );
    const calls: Array<{ sessionId: string; maxTexts: number }> = [];
    vi.spyOn(readerPrivate(reader), 'extractLeadSessionTextsFromJsonl').mockImplementation(
      async (_jsonlPath, leadName, sessionId, maxTexts) => {
        calls.push({ sessionId, maxTexts });
        const count = sessionId === 'lead-current' ? 149 : 1;
        return Array.from({ length: count }, (_, index) => ({
          from: leadName,
          text: `${sessionId}-${index}`,
          timestamp: new Date(
            Date.parse('2026-04-18T10:00:00.000Z') +
              (sessionId === 'lead-current' ? index + 100 : index) * 1_000
          ).toISOString(),
          read: true,
          source: 'lead_session' as const,
          leadSessionId: sessionId,
          messageId: `${sessionId}-${index}`,
        }));
      }
    );

    const messages = await reader.read(
      'my-team',
      config({
        leadSessionId: 'lead-current',
        sessionHistory: ['lead-oldest', 'lead-newest-history', 'lead-current'],
      })
    );

    expect(calls).toEqual([
      { sessionId: 'lead-current', maxTexts: 150 },
      { sessionId: 'lead-newest-history', maxTexts: 1 },
    ]);
    expect(messages).toHaveLength(150);
    expect(messages[0]?.messageId).toBe('lead-newest-history-0');
    expect(messages.at(-1)?.messageId).toBe('lead-current-148');
  });

  it('returns an empty projection without invoking dependencies when no lead ids are known', async () => {
    const projectResolver: TeamLeadSessionMessageReaderProjectResolver = {
      getLiveBaseContext: vi.fn(async () => {
        throw new Error('must not be called');
      }),
      getContext: vi.fn(async () => {
        throw new Error('must not be called');
      }),
    };
    const reader = createReader(projectResolver);

    await expect(
      reader.read('my-team', config({ leadSessionId: undefined, sessionHistory: [] }))
    ).resolves.toEqual([]);
    expect(projectResolver.getLiveBaseContext).not.toHaveBeenCalled();
    expect(projectResolver.getContext).not.toHaveBeenCalled();
  });
});

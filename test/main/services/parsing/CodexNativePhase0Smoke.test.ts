// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalFileSystemProvider } from '../../../../src/main/services/infrastructure/LocalFileSystemProvider';
import { SessionParser } from '../../../../src/main/services/parsing/SessionParser';
import { BoardTaskExactLogStrictParser } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser';

const tempDirs: string[] = [];

const mockProjectScanner = {
  scan: vi.fn(),
  getSessionPath: vi.fn(),
  listSessionsPaginated: vi.fn(),
  listSessions: vi.fn(),
  listSubagentFiles: vi.fn(),
  getSession: vi.fn(),
  listWorktreeSessions: vi.fn(),
  scanWithWorktreeGrouping: vi.fn(),
  getFileSystemProvider: vi.fn().mockReturnValue(new LocalFileSystemProvider()),
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map(async (dirPath) => {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
    }),
  );
});

describe('codex-native phase 0 smoke', () => {
  let parser: SessionParser;

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error test partial
    parser = new SessionParser(mockProjectScanner);
  });

  it('keeps native projected runtime truth parseable through session and exact-log readers', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-phase0-smoke-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'native-phase0-session.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          userType: 'external',
          cwd: '/tmp/project',
          sessionId: 'session-native-smoke',
          version: '1.0.0',
          gitBranch: 'main',
          type: 'system',
          uuid: 'native-running',
          timestamp: '2026-04-19T10:00:00.000Z',
          subtype: 'codex_native_thread_status',
          level: 'info',
          isMeta: false,
          content: 'Codex native thread started: thread-smoke',
          codexNativeThreadStatus: 'running',
          codexNativeThreadId: 'thread-smoke',
        }),
        JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          userType: 'external',
          cwd: '/tmp/project',
          sessionId: 'session-native-smoke',
          version: '1.0.0',
          gitBranch: 'main',
          type: 'system',
          uuid: 'native-warning',
          timestamp: '2026-04-19T10:00:01.000Z',
          subtype: 'codex_native_warning',
          level: 'warning',
          isMeta: false,
          content: 'thread/read failed while backfilling turn items for turn completion',
          codexNativeWarningSource: 'history',
          codexNativeThreadId: 'thread-smoke',
        }),
        JSON.stringify({
          parentUuid: 'user-smoke-1',
          isSidechain: false,
          userType: 'external',
          cwd: '/tmp/project',
          sessionId: 'session-native-smoke',
          version: '1.0.0',
          gitBranch: 'main',
          type: 'assistant',
          uuid: 'assistant-smoke',
          requestId: 'request-smoke',
          timestamp: '2026-04-19T10:00:02.000Z',
          message: {
            role: 'assistant',
            model: 'gpt-5.4-mini',
            id: 'msg-native-smoke',
            type: 'message',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 12,
              cache_read_input_tokens: 4,
              output_tokens: 2,
            },
            content: [{ type: 'text', text: 'OK' }],
          },
        }),
        JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          userType: 'external',
          cwd: '/tmp/project',
          sessionId: 'session-native-smoke',
          version: '1.0.0',
          gitBranch: 'main',
          type: 'system',
          uuid: 'native-summary',
          timestamp: '2026-04-19T10:00:03.000Z',
          subtype: 'codex_native_execution_summary',
          level: 'info',
          isMeta: false,
          content:
            'Codex native execution summary: thread=thread-smoke, completion=ephemeral, history=live-only, usageAuthority=live-turn-completed, binary=codex-cli 0.117.0',
          codexNativeThreadId: 'thread-smoke',
          codexNativeCompletionPolicy: 'ephemeral',
          codexNativeHistoryCompleteness: 'live-only',
          codexNativeFinalUsageAuthority: 'live-turn-completed',
          codexNativeExecutableSource: 'system-path',
          codexNativeExecutableVersion: 'codex-cli 0.117.0',
        }),
        JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          userType: 'external',
          cwd: '/tmp/project',
          sessionId: 'session-native-smoke',
          version: '1.0.0',
          gitBranch: 'main',
          type: 'system',
          uuid: 'native-completed',
          timestamp: '2026-04-19T10:00:04.000Z',
          subtype: 'codex_native_thread_status',
          level: 'info',
          isMeta: false,
          content: 'Codex native thread completed: thread-smoke',
          codexNativeThreadStatus: 'completed',
          codexNativeThreadId: 'thread-smoke',
        }),
      ].join('\n'),
      'utf8',
    );

    const parsed = await parser.parseSessionFile(filePath);
    const exact = await new BoardTaskExactLogStrictParser().parseFiles([filePath]);
    const exactRows = exact.get(filePath) ?? [];

    expect(parsed.byType.assistant).toMatchObject([
      {
        uuid: 'assistant-smoke',
        requestId: 'request-smoke',
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 4,
          output_tokens: 2,
        },
      },
    ]);
    expect(parsed.byType.system).toMatchObject([
      {
        uuid: 'native-running',
        subtype: 'codex_native_thread_status',
        codexNativeThreadStatus: 'running',
      },
      {
        uuid: 'native-warning',
        subtype: 'codex_native_warning',
        codexNativeWarningSource: 'history',
      },
      {
        uuid: 'native-summary',
        subtype: 'codex_native_execution_summary',
        codexNativeCompletionPolicy: 'ephemeral',
        codexNativeHistoryCompleteness: 'live-only',
      },
      {
        uuid: 'native-completed',
        subtype: 'codex_native_thread_status',
        codexNativeThreadStatus: 'completed',
      },
    ]);
    expect(exactRows.map((row) => row.uuid)).toEqual([
      'native-running',
      'native-warning',
      'assistant-smoke',
      'native-summary',
      'native-completed',
    ]);
    expect(exactRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uuid: 'native-warning',
          subtype: 'codex_native_warning',
          codexNativeWarningSource: 'history',
        }),
        expect.objectContaining({
          uuid: 'native-summary',
          subtype: 'codex_native_execution_summary',
          codexNativeExecutableVersion: 'codex-cli 0.117.0',
        }),
      ]),
    );
  });
});

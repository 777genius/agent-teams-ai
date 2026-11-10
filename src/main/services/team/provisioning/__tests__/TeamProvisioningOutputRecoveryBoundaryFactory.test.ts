import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOutputRecoveryBoundary,
  type TeamProvisioningOutputRecoveryBoundaryRun,
  type TeamProvisioningOutputRecoveryServiceAdapter,
} from '../TeamProvisioningOutputRecoveryBoundaryFactory';

import type { TeamProvisioningProgress } from '@shared/types';

type TestStream = EventEmitter & {
  on(event: 'data', listener: (chunk: Buffer) => void): TestStream;
};

interface TestRun extends TeamProvisioningOutputRecoveryBoundaryRun {
  child: {
    stdout: TestStream;
    stderr: TestStream;
  } | null;
}

interface ReceiverBoundServiceAdapter extends TeamProvisioningOutputRecoveryServiceAdapter<TestRun> {
  appended: string[];
  parsedMessages: Record<string, unknown>[];
  cleanedRuns: string[];
}

function progress(overrides: Partial<TeamProvisioningProgress> = {}): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    state: 'spawning',
    message: 'Starting',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    progress: progress(),
    stdoutBuffer: '',
    stderrBuffer: '',
    claudeLogLines: [],
    provisioningOutputParts: [],
    provisioningOutputIndexByMessageId: new Map(),
    provisioningTraceLines: [],
    lastProvisioningTraceKey: null,
    stdoutParserCarry: '',
    stdoutParserCarryIsCompleteJson: false,
    stdoutParserCarryLooksLikeClaudeJson: false,
    processKilled: false,
    cancelRequested: false,
    provisioningComplete: false,
    child: {
      stdout: new EventEmitter() as TestStream,
      stderr: new EventEmitter() as TestStream,
    },
    onProgress: vi.fn(),
    expectedMembers: [],
    request: {},
    lastLogProgressAt: 0,
    lastDataReceivedAt: 0,
    lastStdoutReceivedAt: 0,
    stallCheckHandle: null,
    stallWarningIndex: null,
    preStallMessage: null,
    lastRetryAt: 0,
    apiRetryWarningIndex: null,
    apiErrorWarningEmitted: false,
    authFailureRetried: false,
    authRetryInProgress: false,
    isLaunch: false,
    memberSpawnStatuses: new Map(),
    ...overrides,
  };
}

function makeServiceAdapter(): ReceiverBoundServiceAdapter {
  return {
    appended: [],
    parsedMessages: [],
    cleanedRuns: [],
    updateProgress(run, state, message, extras) {
      run.progress = {
        ...run.progress,
        state,
        message,
        updatedAt: '2026-01-01T00:00:01.000Z',
        error: extras?.error,
        cliLogsTail: extras?.cliLogsTail,
      };
      return run.progress;
    },
    emitLogsProgress: vi.fn(),
    killTeamProcess: vi.fn(),
    cleanupRun(this: ReceiverBoundServiceAdapter, run) {
      this.cleanedRuns.push(run.runId);
    },
    respawnAfterAuthFailure: vi.fn(async () => undefined),
    appendCliLogs(this: ReceiverBoundServiceAdapter, _run, stream, text) {
      this.appended.push(`${stream}:${text}`);
    },
    handleStreamJsonMessage(this: ReceiverBoundServiceAdapter, _run, msg) {
      this.parsedMessages.push(msg);
    },
    shiftProvisioningOutputIndexesAfterRemoval(run, removedIndex) {
      for (const [messageId, index] of run.provisioningOutputIndexByMessageId.entries()) {
        if (index > removedIndex) {
          run.provisioningOutputIndexByMessageId.set(messageId, index - 1);
        }
      }
    },
  };
}

describe('TeamProvisioningOutputRecoveryBoundaryFactory', () => {
  it('preserves service-adapter receiver binding for stdout plumbing', () => {
    const service = makeServiceAdapter();
    const boundary = createTeamProvisioningOutputRecoveryBoundary({
      service,
      logger: { warn: vi.fn(), error: vi.fn() },
      nowMs: () => 2_500,
      nowIso: () => '2026-01-01T00:00:02.500Z',
    });
    const run = makeRun();

    boundary.attachStdoutHandler(run);
    run.child?.stdout.emit('data', Buffer.from('{"type":"assistant"}\n'));

    expect(service.appended).toEqual(['stdout:{"type":"assistant"}\n']);
    expect(service.parsedMessages).toEqual([expect.objectContaining({ type: 'assistant' })]);
    expect(run.lastDataReceivedAt).toBe(2_500);
    expect(run.lastStdoutReceivedAt).toBe(2_500);
  });

  it('routes fatal API recovery through service callbacks', () => {
    const service = makeServiceAdapter();
    const boundary = createTeamProvisioningOutputRecoveryBoundary({
      service,
      logger: { warn: vi.fn(), error: vi.fn() },
      nowIso: () => '2026-01-01T00:00:02.500Z',
    });
    const run = makeRun({
      stderrBuffer: 'api error: 500 overloaded',
    });

    boundary.failProvisioningWithApiError(run, 'api error: 500 overloaded');

    expect(run.progress.state).toBe('failed');
    expect(run.progress.message).toContain('API Error 500');
    expect(run.processKilled).toBe(true);
    expect(run.cancelRequested).toBe(true);
    expect(service.killTeamProcess).toHaveBeenCalledWith(run.child);
    expect(service.cleanedRuns).toEqual(['run-1']);
  });
});

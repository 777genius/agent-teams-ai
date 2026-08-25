import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import { buildCombinedLogs } from '../TeamProvisioningCliExitPresentation';
import {
  buildStallProgressMessage,
  buildStallWarningText,
  extractApiErrorSnippet,
  hasApiError,
  isAuthFailureWarning,
} from '../TeamProvisioningOutputErrorPolicy';
import {
  createTeamProvisioningOutputRecoveryHelper,
  type TeamProvisioningOutputRecoveryPorts,
  type TeamProvisioningOutputRecoveryRun,
} from '../TeamProvisioningOutputRecovery';
import { boundStdoutParserCarry } from '../TeamProvisioningProgressBuffers';
import { looksLikeClaudeStdoutJsonFragment } from '../TeamProvisioningProgressState';

import type { TeamProvisioningProgress } from '@shared/types';

type TestStream = EventEmitter & {
  on(event: 'data', listener: (chunk: Buffer) => void): TestStream;
};

interface TestRun extends TeamProvisioningOutputRecoveryRun {
  child: {
    stdout: TestStream;
    stderr: TestStream;
  } | null;
}

function progress(): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    state: 'spawning',
    message: 'Starting',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
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
    expectedMembers: ['lead', 'worker', 'skipped'],
    request: { model: 'claude-sonnet', effort: 'high' },
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
    memberSpawnStatuses: new Map([
      ['lead', { bootstrapConfirmed: true }],
      ['skipped', { skippedForLaunch: true }],
    ]),
    ...overrides,
  };
}

function makePorts(now = 1_000): TeamProvisioningOutputRecoveryPorts<TestRun> & {
  handleStreamJsonMessage: ReturnType<typeof vi.fn>;
  respawnAfterAuthFailure: ReturnType<typeof vi.fn>;
  cleanupRun: ReturnType<typeof vi.fn>;
  killTeamProcess: ReturnType<typeof vi.fn>;
  emitLogsProgress: ReturnType<typeof vi.fn>;
  appendCliLogs: ReturnType<typeof vi.fn>;
  logger: {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  tickStallWatchdog(): void;
} {
  let intervalCallback: (() => void) | null = null;
  const ports = {
    logger: { warn: vi.fn(), error: vi.fn() },
    nowMs: vi.fn(() => now),
    nowIso: vi.fn(() => '2026-01-01T00:00:01.000Z'),
    setInterval: vi.fn((callback: () => void) => {
      intervalCallback = callback;
      return { id: 'timer' } as unknown as NodeJS.Timeout;
    }),
    clearInterval: vi.fn(),
    buildCombinedLogs,
    extractApiErrorSnippet,
    hasApiError,
    isAuthFailureWarning,
    buildStallWarningText,
    buildStallProgressMessage,
    boundStdoutParserCarry,
    looksLikeClaudeStdoutJsonFragment,
    boundRunProvisioningOutputParts: vi.fn(),
    buildProvisioningLiveOutput: vi.fn((run: TestRun) => run.provisioningOutputParts.join('\n')),
    extractCliLogsFromRun: vi.fn((run: TestRun) =>
      buildCombinedLogs(run.stdoutBuffer, run.stderrBuffer)
    ),
    updateProgress: vi.fn((run: TestRun, state, message, extras) => {
      run.progress = {
        ...run.progress,
        state,
        message,
        updatedAt: '2026-01-01T00:00:01.000Z',
        error: extras?.error,
        cliLogsTail: extras?.cliLogsTail,
        pid: extras?.pid,
      };
      return run.progress;
    }),
    emitLogsProgress: vi.fn(),
    killTeamProcess: vi.fn(),
    cleanupRun: vi.fn(),
    respawnAfterAuthFailure: vi.fn(async () => undefined),
    appendCliLogs: vi.fn(),
    handleStreamJsonMessage: vi.fn(),
    shiftProvisioningOutputIndexesAfterRemoval: vi.fn((run: TestRun, removedIndex: number) => {
      for (const [messageId, index] of run.provisioningOutputIndexByMessageId.entries()) {
        if (index > removedIndex) {
          run.provisioningOutputIndexByMessageId.set(messageId, index - 1);
        }
      }
    }),
    tickStallWatchdog: () => {
      intervalCallback?.();
    },
  } satisfies TeamProvisioningOutputRecoveryPorts<TestRun> & { tickStallWatchdog(): void };
  return ports;
}

function makeHelper(ports = makePorts()) {
  return createTeamProvisioningOutputRecoveryHelper(ports, {
    stderrRingLimit: 16,
    stdoutRingLimit: 16,
    logProgressThrottleMs: 1_000,
    stallCheckIntervalMs: 10_000,
    stallWarningThresholdMs: 20_000,
    preflightAuthRetryDelayMs: 2_000,
  });
}

describe('team provisioning output recovery helper', () => {
  it('tracks stdout carry diagnostics and flushes complete final JSON', () => {
    const run = makeRun();
    const ports = makePorts();
    const helper = makeHelper(ports);

    helper.updateStdoutParserCarry(run, ' {"type":"result","subtype":"success","seq":7} ');

    expect(run.stdoutParserCarryIsCompleteJson).toBe(true);
    expect(run.stdoutParserCarryLooksLikeClaudeJson).toBe(true);
    expect(helper.buildStdoutCarryDiagnostic(run)).toMatchObject({
      runId: 'run-1',
      stdoutCarryCompleteJson: true,
      stdoutCarryLooksLikeClaudeJson: true,
      messageType: 'result',
      messageSubtype: 'success',
      sequence: 7,
    });

    helper.flushStdoutParserCarry(run);

    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[team-a] Flushing final stream-json stdout carry before process close handling',
      expect.objectContaining({ messageType: 'result' })
    );
    expect(ports.handleStreamJsonMessage).toHaveBeenCalledWith(
      run,
      expect.objectContaining({ type: 'result', subtype: 'success' })
    );
    expect(run.stdoutParserCarry).toBe('');
  });

  it('parses stdout lines, preserves carry, emits API retry warnings, and detects auth retry', () => {
    const run = makeRun();
    const ports = makePorts(2_500);
    const helper = makeHelper(ports);

    helper.attachStdoutHandler(run);
    run.child?.stdout.emit('data', Buffer.from('{"type":"system"}\npartial'));
    run.child?.stdout.emit('data', Buffer.from(' api error: 429 cooldown\nnot authenticated\n'));

    expect(ports.handleStreamJsonMessage).toHaveBeenCalledWith(
      run,
      expect.objectContaining({ type: 'system' })
    );
    expect(run.stdoutParserCarry).toBe('');
    expect(run.provisioningOutputParts[0]).toContain('**API Error 429 — SDK is retrying**');
    expect(run.authRetryInProgress).toBe(true);
    expect(ports.respawnAfterAuthFailure).toHaveBeenCalledWith(run);
    expect(run.stdoutBuffer).toBe('t authenticated\n');
    expect(ports.emitLogsProgress).toHaveBeenCalled();
  });

  it('clears stall warnings when assistant or result stdout arrives', () => {
    const run = makeRun({
      progress: { ...progress(), message: 'Waiting', messageSeverity: 'warning' },
      provisioningOutputParts: ['stall', 'next'],
      provisioningOutputIndexByMessageId: new Map([['next-id', 1]]),
      stallWarningIndex: 0,
      preStallMessage: 'Starting',
    });
    const ports = makePorts(9_000);
    const helper = makeHelper(ports);

    helper.handleParsedStdoutJsonMessage(run, { type: 'assistant' });

    expect(run.lastStdoutReceivedAt).toBe(9_000);
    expect(run.provisioningOutputParts).toEqual(['next']);
    expect(run.stallWarningIndex).toBeNull();
    expect(run.progress.message).toBe('Starting');
    expect(run.progress.messageSeverity).toBeUndefined();
    expect(run.provisioningOutputIndexByMessageId.get('next-id')).toBe(0);
    expect(ports.handleStreamJsonMessage).toHaveBeenCalledWith(run, { type: 'assistant' });
  });

  it('fails fast on a repeated auth failure without respawning again', () => {
    const run = makeRun({ authFailureRetried: true });
    const ports = makePorts();
    const helper = makeHelper(ports);

    helper.handleAuthFailureInOutput(run, 'please run /login first', 'stderr');

    expect(run.processKilled).toBe(true);
    expect(ports.respawnAfterAuthFailure).not.toHaveBeenCalled();
    expect(ports.killTeamProcess).toHaveBeenCalledWith(run.child);
    expect(run.progress).toMatchObject({
      state: 'failed',
      message: 'Authentication failed — CLI requires login',
    });
    expect(ports.cleanupRun).toHaveBeenCalledWith(run);
  });

  it('handles stderr API warnings and first auth-failure respawn through ports', () => {
    const run = makeRun();
    const ports = makePorts(3_000);
    const helper = makeHelper(ports);

    helper.attachStderrHandler(run);
    run.child?.stderr.emit('data', Buffer.from('api error: 500 overloaded\n'));
    run.child?.stderr.emit('data', Buffer.from('please run /login first\n'));

    expect(ports.appendCliLogs).toHaveBeenCalledWith(run, 'stderr', 'api error: 500 overloaded\n');
    expect(run.provisioningOutputParts[0]).toContain('**API Error 500 — SDK is retrying**');
    expect(run.authRetryInProgress).toBe(true);
    expect(ports.respawnAfterAuthFailure).toHaveBeenCalledWith(run);
    expect(run.stderrBuffer).toBe('un /login first\n');
    expect(ports.emitLogsProgress).toHaveBeenCalled();
  });

  it('updates and stops the stall watchdog through timer ports', () => {
    const run = makeRun({ lastStdoutReceivedAt: 0 });
    const ports = makePorts(21_000);
    const helper = makeHelper(ports);

    helper.startStallWatchdog(run);
    ports.tickStallWatchdog();

    expect(run.stallWarningIndex).toBe(0);
    expect(run.provisioningOutputParts[0]).toContain('silent for 21s');
    expect(run.progress.message).toBe(
      'Waiting for model response for 21s - logs can be delayed, this is still OK'
    );

    helper.stopStallWatchdog(run);

    expect(ports.clearInterval).toHaveBeenCalled();
    expect(run.stallCheckHandle).toBeNull();
  });

  it('reports unconfirmed bootstrap members only', () => {
    const helper = makeHelper();
    const run = makeRun();

    expect(helper.getUnconfirmedBootstrapMemberNames(run)).toEqual(['worker']);
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  TeamProvisioningOutputRecoveryFacade,
  type TeamProvisioningOutputRecoveryFacadeServiceAdapter,
} from '../TeamProvisioningOutputRecoveryFacade';

import type { TeamProvisioningOutputRecoveryBoundary } from '../TeamProvisioningOutputRecoveryBoundaryFactory';
import type { TeamProvisioningOutputRecoveryFacadeRun } from '../TeamProvisioningOutputRecoveryFacade';
import type { TeamProvisioningProgress } from '@shared/types';

const mocks = vi.hoisted(() => {
  const outputBoundary = {
    failProvisioningWithApiError: vi.fn(),
    emitApiErrorWarning: vi.fn(),
    startStallWatchdog: vi.fn(),
    stopStallWatchdog: vi.fn(),
    handleAuthFailureInOutput: vi.fn(),
    attachStdoutHandler: vi.fn(),
    updateStdoutParserCarry: vi.fn(),
    flushStdoutParserCarry: vi.fn(),
    buildStdoutCarryDiagnostic: vi.fn(() => ({ carry: true })),
    getUnconfirmedBootstrapMemberNames: vi.fn(() => ['worker']),
    handleStdoutParserLine: vi.fn(),
    handleParsedStdoutJsonMessage: vi.fn(),
    attachStderrHandler: vi.fn(),
  };
  const authRetryBoundary = {
    respawnAfterAuthFailure: vi.fn(async () => undefined),
  };

  return {
    outputBoundary,
    authRetryBoundary,
    createOutputBoundary: vi.fn(() => outputBoundary),
    createAuthRetryBoundary: vi.fn(() => authRetryBoundary),
  };
});

vi.mock('../TeamProvisioningOutputRecoveryBoundaryFactory', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../TeamProvisioningOutputRecoveryBoundaryFactory')>();
  return {
    ...actual,
    createTeamProvisioningOutputRecoveryBoundary: mocks.createOutputBoundary,
  };
});

vi.mock('../TeamProvisioningAuthRetryRecoveryBoundaryFactory', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../TeamProvisioningAuthRetryRecoveryBoundaryFactory')>();
  return {
    ...actual,
    createTeamProvisioningAuthRetryRecoveryBoundary: mocks.createAuthRetryBoundary,
  };
});

type TestRun = TeamProvisioningOutputRecoveryFacadeRun;
interface OutputBoundaryDepsForTest {
  service: {
    respawnAfterAuthFailure(run: TestRun): Promise<void>;
  };
}
interface AuthRetryBoundaryDepsForTest {
  service: {
    stopStallWatchdog(run: TestRun): void;
    attachStdoutHandler(run: TestRun): void;
    attachStderrHandler(run: TestRun): void;
    startStallWatchdog(run: TestRun): void;
    stopFilesystemMonitor(run: TestRun): void;
    startFilesystemMonitor(run: TestRun, request: TestRun['request']): void;
    tryCompleteAfterTimeout(run: TestRun): Promise<boolean>;
    handleProcessExit(run: TestRun, code: number | null): Promise<void> | void;
  };
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

function makeRun(): TestRun {
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
    child: null,
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
    timeoutHandle: null,
    stdoutLogLineBuf: '',
    stderrLogLineBuf: '',
    lastClaudeLogStream: null,
    spawnContext: null,
    mcpConfigPath: null,
    bootstrapUserPromptPath: null,
    processClosed: false,
    finalizingByTimeout: false,
    deterministicBootstrap: false,
    effectiveMembers: [],
  } as TestRun;
}

function makeService(): TeamProvisioningOutputRecoveryFacadeServiceAdapter<TestRun> & {
  events: string[];
} {
  return {
    events: [],
    updateProgress: vi.fn((run: TestRun) => run.progress),
    emitLogsProgress: vi.fn(),
    killTeamProcess: vi.fn(),
    cleanupRun: vi.fn(),
    appendCliLogs: vi.fn(),
    handleStreamJsonMessage: vi.fn(),
    shiftProvisioningOutputIndexesAfterRemoval: vi.fn(),
    getStopAllTeamsGeneration: vi.fn(() => 7),
    stopFilesystemMonitor(this: { events: string[] }) {
      this.events.push('stop-fs');
    },
    startFilesystemMonitor(this: { events: string[] }) {
      this.events.push('start-fs');
    },
    async tryCompleteAfterTimeout(this: { events: string[] }) {
      this.events.push('timeout');
      return false;
    },
    async handleProcessExit(this: { events: string[] }) {
      this.events.push('exit');
    },
  };
}

function makeFacade(service = makeService()): TeamProvisioningOutputRecoveryFacade<TestRun> {
  return new TeamProvisioningOutputRecoveryFacade<TestRun>({
    service,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    mcpConfigBuilder: { writeConfigFile: vi.fn(async () => '/workspace/mcp.json') },
    providerRuntime: {
      validateAgentTeamsMcpRuntime: vi.fn(async () => undefined),
    },
    killTeamProcess: vi.fn(),
    updateProgress: vi.fn((run: TestRun) => run.progress),
    nowIso: () => '2026-01-01T00:00:00.000Z',
  });
}

describe('TeamProvisioningOutputRecoveryFacade', () => {
  it('delegates output recovery methods through the output boundary', () => {
    const facade = makeFacade();
    const run = makeRun();

    facade.attachStdoutHandler(run);
    facade.attachStderrHandler(run);
    facade.startStallWatchdog(run);
    facade.stopStallWatchdog(run);
    facade.failProvisioningWithApiError(run, 'api error: 500');
    facade.emitApiErrorWarning(run, 'api error: 429');
    facade.handleAuthFailureInOutput(run, 'please run /login first', 'stderr');
    facade.updateStdoutParserCarry(run, '{"type":"assistant"}');
    facade.flushStdoutParserCarry(run);
    facade.handleStdoutParserLine(run, '{"type":"system"}');
    facade.handleParsedStdoutJsonMessage(run, { type: 'result' });

    expect(mocks.outputBoundary.attachStdoutHandler).toHaveBeenCalledWith(run);
    expect(mocks.outputBoundary.attachStderrHandler).toHaveBeenCalledWith(run);
    expect(mocks.outputBoundary.startStallWatchdog).toHaveBeenCalledWith(run);
    expect(mocks.outputBoundary.stopStallWatchdog).toHaveBeenCalledWith(run);
    expect(mocks.outputBoundary.failProvisioningWithApiError).toHaveBeenCalledWith(
      run,
      'api error: 500'
    );
    expect(mocks.outputBoundary.emitApiErrorWarning).toHaveBeenCalledWith(run, 'api error: 429');
    expect(mocks.outputBoundary.handleAuthFailureInOutput).toHaveBeenCalledWith(
      run,
      'please run /login first',
      'stderr'
    );
    expect(mocks.outputBoundary.updateStdoutParserCarry).toHaveBeenCalledWith(
      run,
      '{"type":"assistant"}'
    );
    expect(mocks.outputBoundary.flushStdoutParserCarry).toHaveBeenCalledWith(run);
    expect(mocks.outputBoundary.handleStdoutParserLine).toHaveBeenCalledWith(
      run,
      '{"type":"system"}'
    );
    expect(mocks.outputBoundary.handleParsedStdoutJsonMessage).toHaveBeenCalledWith(run, {
      type: 'result',
    });
    expect(facade.buildStdoutCarryDiagnostic(run)).toEqual({ carry: true });
    expect(facade.getUnconfirmedBootstrapMemberNames(run)).toEqual(['worker']);
  });

  it('wires output auth retry requests into the auth retry boundary', async () => {
    makeFacade();
    const run = makeRun();

    const outputCalls = mocks.createOutputBoundary.mock
      .calls as unknown as [OutputBoundaryDepsForTest][];
    const outputDeps = outputCalls.at(-1)?.[0];
    await outputDeps?.service.respawnAfterAuthFailure(run);

    expect(mocks.authRetryBoundary.respawnAfterAuthFailure).toHaveBeenCalledWith(run);
  });

  it('wires auth retry stream and watchdog callbacks back through output recovery', async () => {
    const service = makeService();
    makeFacade(service);
    const run = makeRun();

    const authRetryCalls = mocks.createAuthRetryBoundary.mock
      .calls as unknown as [AuthRetryBoundaryDepsForTest][];
    const authRetryDeps = authRetryCalls.at(-1)?.[0];
    authRetryDeps?.service.stopStallWatchdog(run);
    authRetryDeps?.service.attachStdoutHandler(run);
    authRetryDeps?.service.attachStderrHandler(run);
    authRetryDeps?.service.startStallWatchdog(run);
    authRetryDeps?.service.stopFilesystemMonitor(run);
    authRetryDeps?.service.startFilesystemMonitor(run, run.request);
    await authRetryDeps?.service.tryCompleteAfterTimeout(run);
    await authRetryDeps?.service.handleProcessExit(run, 0);

    expect(mocks.outputBoundary.stopStallWatchdog).toHaveBeenCalledWith(run);
    expect(mocks.outputBoundary.attachStdoutHandler).toHaveBeenCalledWith(run);
    expect(mocks.outputBoundary.attachStderrHandler).toHaveBeenCalledWith(run);
    expect(mocks.outputBoundary.startStallWatchdog).toHaveBeenCalledWith(run);
    expect(service.events).toEqual(['stop-fs', 'start-fs', 'timeout', 'exit']);
  });

  it('keeps facade shape assignable to output-recovery ports', () => {
    const facade: TeamProvisioningOutputRecoveryBoundary<TestRun> = makeFacade();

    expect(facade).toBeInstanceOf(TeamProvisioningOutputRecoveryFacade);
  });
});

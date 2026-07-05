import { describe, expect, it, vi } from 'vitest';

import {
  respawnCliAfterAuthFailure,
  type TeamProvisioningAuthRetryRun,
} from '../TeamProvisioningAuthRetryRecovery';
import {
  createTeamProvisioningAuthRetryRecoveryBoundary,
  type TeamProvisioningAuthRetryRecoveryServiceAdapter,
} from '../TeamProvisioningAuthRetryRecoveryBoundaryFactory';
import { PREFLIGHT_AUTH_RETRY_DELAY_MS } from '../TeamProvisioningProviderDiagnostics';

import type { TeamProvisioningProgress } from '@shared/types';

vi.mock('../TeamProvisioningAuthRetryRecovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../TeamProvisioningAuthRetryRecovery')>();
  return {
    ...actual,
    respawnCliAfterAuthFailure: vi.fn(async () => undefined),
  };
});

type TestRun = TeamProvisioningAuthRetryRun;

interface ReceiverBoundServiceAdapter extends TeamProvisioningAuthRetryRecoveryServiceAdapter<TestRun> {
  events: string[];
  stopAllGeneration: number;
}

interface ReceiverBoundProviderRuntime {
  calls: string[];
  validateAgentTeamsMcpRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    mcpConfigPath: string,
    options: { isCancelled(): boolean }
  ): Promise<void>;
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
    stdoutParserCarry: '',
    stdoutParserCarryIsCompleteJson: false,
    stdoutParserCarryLooksLikeClaudeJson: false,
    processKilled: false,
    cancelRequested: false,
    provisioningComplete: false,
    child: null,
    onProgress: vi.fn(),
    expectedMembers: [],
    request: {
      teamName: 'team-a',
      cwd: '/project',
      members: [],
    } as TestRun['request'],
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
  };
}

function makeServiceAdapter(): ReceiverBoundServiceAdapter {
  return {
    events: [],
    stopAllGeneration: 11,
    getStopAllTeamsGeneration(this: ReceiverBoundServiceAdapter) {
      return this.stopAllGeneration;
    },
    stopFilesystemMonitor(this: ReceiverBoundServiceAdapter) {
      this.events.push('stop-fs');
    },
    stopStallWatchdog(this: ReceiverBoundServiceAdapter) {
      this.events.push('stop-stall');
    },
    cleanupRun(this: ReceiverBoundServiceAdapter) {
      this.events.push('cleanup');
    },
    attachStdoutHandler(this: ReceiverBoundServiceAdapter) {
      this.events.push('stdout');
    },
    attachStderrHandler(this: ReceiverBoundServiceAdapter) {
      this.events.push('stderr');
    },
    startStallWatchdog(this: ReceiverBoundServiceAdapter) {
      this.events.push('start-stall');
    },
    startFilesystemMonitor(this: ReceiverBoundServiceAdapter) {
      this.events.push('start-fs');
    },
    async tryCompleteAfterTimeout(this: ReceiverBoundServiceAdapter) {
      this.events.push('timeout');
      return false;
    },
    async handleProcessExit(this: ReceiverBoundServiceAdapter) {
      this.events.push('exit');
    },
  };
}

describe('TeamProvisioningAuthRetryRecoveryBoundaryFactory', () => {
  it('builds auth retry ports and preserves service/provider receiver binding', async () => {
    const run = makeRun();
    const service = makeServiceAdapter();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const mcpConfigBuilder = {
      writeConfigFile: vi.fn(async () => '/mcp'),
    };
    const providerRuntime: ReceiverBoundProviderRuntime = {
      calls: [],
      async validateAgentTeamsMcpRuntime(this: ReceiverBoundProviderRuntime, claudePath) {
        this.calls.push(claudePath);
      },
    };
    const killTeamProcess = vi.fn();
    const updateProgress = vi.fn((targetRun: TestRun) => targetRun.progress);
    const boundary = createTeamProvisioningAuthRetryRecoveryBoundary<TestRun>({
      service,
      logger,
      mcpConfigBuilder,
      providerRuntime,
      killTeamProcess,
      updateProgress,
    });

    await boundary.respawnAfterAuthFailure(run);

    const mockedRespawn = vi.mocked(respawnCliAfterAuthFailure);
    expect(mockedRespawn).toHaveBeenCalledWith(
      run,
      expect.objectContaining({
        logger,
        mcpConfigBuilder,
        killTeamProcess,
        updateProgress,
      }),
      { preflightAuthRetryDelayMs: PREFLIGHT_AUTH_RETRY_DELAY_MS }
    );
    const ports = mockedRespawn.mock.calls[0][1];
    expect(ports.getStopAllTeamsGeneration()).toBe(11);
    expect(ports.isStopAllTeamsGenerationChanged(11)).toBe(false);

    service.stopAllGeneration = 12;
    expect(ports.isStopAllTeamsGenerationChanged(11)).toBe(true);
    ports.stopFilesystemMonitor(run);
    ports.stopStallWatchdog(run);
    ports.cleanupRun(run);
    ports.attachStdoutHandler(run);
    ports.attachStderrHandler(run);
    ports.startStallWatchdog(run);
    ports.startFilesystemMonitor(run, run.request);
    await ports.tryCompleteAfterTimeout(run);
    await ports.handleProcessExit(run, 0);
    await ports.validateAgentTeamsMcpRuntime('/bin/claude', '/project', {}, '/mcp', {
      isCancelled: () => false,
    });

    expect(service.events).toEqual([
      'stop-fs',
      'stop-stall',
      'cleanup',
      'stdout',
      'stderr',
      'start-stall',
      'start-fs',
      'timeout',
      'exit',
    ]);
    expect(providerRuntime.calls).toEqual(['/bin/claude']);
  });
});

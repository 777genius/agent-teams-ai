import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  killProcessTree: vi.fn(),
}));

vi.mock('@main/utils/childProcess', () => ({
  killProcessTree: hoisted.killProcessTree,
}));

import {
  emitLogsProgress,
  killTeamProcess,
  updateProgress,
} from '../TeamProvisioningRunProgress';

import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type { TeamProvisioningProgress } from '@shared/types';
import type { ChildProcess } from 'child_process';

function progress(
  overrides: Partial<TeamProvisioningProgress> = {}
): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team',
    state: 'spawning',
    message: 'Spawning',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function run(overrides: Partial<ProvisioningRun> = {}): ProvisioningRun {
  return {
    progress: progress(),
    stdoutBuffer: '',
    stderrBuffer: '',
    claudeLogLines: [],
    provisioningTraceLines: [],
    lastProvisioningTraceKey: null,
    provisioningOutputParts: [],
    provisioningOutputIndexByMessageId: new Map(),
    stallWarningIndex: null,
    apiRetryWarningIndex: null,
    isLaunch: false,
    memberSpawnStatuses: new Map(),
    onProgress: vi.fn(),
    ...overrides,
  } as ProvisioningRun;
}

describe('TeamProvisioningRunProgress', () => {
  beforeEach(() => {
    hoisted.killProcessTree.mockReset();
  });

  it('kills team processes with SIGKILL', () => {
    const child = { pid: 1234 } as ChildProcess;

    killTeamProcess(child);

    expect(hoisted.killProcessTree).toHaveBeenCalledWith(child, 'SIGKILL');
  });

  it('updates progress without dropping run identity or retained payload fields', () => {
    const targetRun = run({
      progress: progress({
        pid: 1234,
        cliLogsTail: 'previous logs',
        configReady: false,
      }),
    });

    const next = updateProgress(targetRun, 'configuring', 'Configuring team', {
      warnings: ['watching config'],
      configReady: true,
    });

    expect(next).toMatchObject({
      runId: 'run-1',
      teamName: 'team',
      state: 'configuring',
      message: 'Configuring team',
      pid: 1234,
      cliLogsTail: 'previous logs',
      configReady: true,
      warnings: ['watching config'],
    });
    expect(next.assistantOutput).toContain('Configuring team');
  });

  it('emits bounded log progress from retained line-buffer logs', () => {
    const onProgress = vi.fn();
    const targetRun = run({
      claudeLogLines: ['[stdout] first', '[stderr] second'],
      onProgress,
    });

    emitLogsProgress(targetRun);

    expect(targetRun.progress).toMatchObject({
      runId: 'run-1',
      teamName: 'team',
      cliLogsTail: '[stdout] first\n[stderr] second',
    });
    expect(onProgress).toHaveBeenCalledWith(targetRun.progress);
  });
});

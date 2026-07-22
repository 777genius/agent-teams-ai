import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  killProcessTree: vi.fn(),
  killProcessTreeAndWait: vi.fn<() => Promise<void>>(),
}));

vi.mock('@main/utils/childProcess', () => ({
  killProcessTree: hoisted.killProcessTree,
  killProcessTreeAndWait: hoisted.killProcessTreeAndWait,
}));

import {
  emitLogsProgress,
  killTeamProcess,
  killTeamProcessAndWait,
  updateProgress,
} from '../TeamProvisioningRunProgress';

import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type { TeamProvisioningProgress } from '@shared/types';
import type { ChildProcess } from 'child_process';

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  });
}

function progress(overrides: Partial<TeamProvisioningProgress> = {}): TeamProvisioningProgress {
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
    hoisted.killProcessTreeAndWait.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('kills team processes with SIGKILL', () => {
    const child = { pid: 1234, exitCode: null, signalCode: null } as ChildProcess;

    killTeamProcess(child);

    expect(hoisted.killProcessTree).toHaveBeenCalledWith(child, 'SIGKILL');
  });

  it('does not signal an exited child that retains its pid', () => {
    const child = { pid: 1234, exitCode: 0, signalCode: null } as ChildProcess;

    killTeamProcess(child);

    expect(hoisted.killProcessTree).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'linux'] as const)(
    'still delegates strict tree proof after the root child has exited on %s',
    async (platform) => {
      setPlatform(platform);
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 1234, exitCode: 0, signalCode: null });

      await killTeamProcessAndWait(child);

      expect(hoisted.killProcessTreeAndWait).toHaveBeenCalledWith(child, 'SIGKILL');
    }
  );

  it('does not pass an already-exited Windows root PID to tree termination', async () => {
    setPlatform('win32');
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 1234, exitCode: 0, signalCode: null });

    await killTeamProcessAndWait(child);

    expect(hoisted.killProcessTreeAndWait).not.toHaveBeenCalled();
  });

  it('does not resolve strict team-process termination before child exit', async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 1234, exitCode: null, signalCode: null });
    let settled = false;

    const stopping = killTeamProcessAndWait(child).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(hoisted.killProcessTreeAndWait).toHaveBeenCalledWith(child, 'SIGKILL');
    expect(settled).toBe(false);

    child.emit('close', null, 'SIGKILL');
    await stopping;
    expect(settled).toBe(true);
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

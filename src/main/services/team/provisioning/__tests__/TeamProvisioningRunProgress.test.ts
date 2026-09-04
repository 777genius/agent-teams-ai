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
  createTeamProvisioningLaunchStateCompatibilityBoundaryFromService,
  type TeamProvisioningLaunchStateCompatibilityServiceHost,
} from '../TeamProvisioningLaunchStateCompatibilityFacade';
import { createInitialMemberSpawnStatusEntry } from '../TeamProvisioningMemberSpawnStatusPolicy';
import {
  emitLogsProgress,
  killTeamProcess,
  killTeamProcessAndWait,
  publishConfirmedLaunchProgress,
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

  it('publishes late OpenCode readiness before notification dedupe and preserves unrelated warnings', () => {
    const target = confirmedLaunchRun();
    target.teamLaunchedNotificationFired = true;
    const lane = target.mixedSecondaryLanes[0];
    lane.state = 'launching';
    const previous = target.progress;
    expect(publishConfirmedLaunchProgress(target)).toBe(false);
    expect(target.progress).toBe(previous);
    expect(target.onProgress).not.toHaveBeenCalled();

    lane.state = 'finished';
    expect(publishConfirmedLaunchProgress(target)).toBe(true);
    expect(target.progress).toMatchObject({
      state: 'ready',
      message: 'Team launched - all 3 teammates joined and are ready for tasks.',
      warnings: ['Unrelated advisory'],
      cliLogsTail: 'retained diagnostics',
    });
    expect(target.progress.messageSeverity).toBeUndefined();
    expect(target.onProgress).toHaveBeenCalledWith(target.progress);
    expect(publishConfirmedLaunchProgress(target)).toBe(true);
    expect(target.onProgress).toHaveBeenCalledTimes(1);
  });

  it('projects confirmation at initial ready promotion when the final lane event preceded it', async () => {
    const target = confirmedLaunchRun();
    target.progress.state = 'assembling';
    let promoted = false;
    const fireNotification = vi.fn(async () => {
      expect(target.progress.message).toContain('all 3 teammates joined');
      expect(target.progress.messageSeverity).toBeUndefined();
    });
    const boundary = createTeamProvisioningLaunchStateCompatibilityBoundaryFromService({
      isProvisioningRunPromotedToAlive: () => promoted,
      launchNotifications: { fireTeamLaunchedNotification: fireNotification },
    } as unknown as TeamProvisioningLaunchStateCompatibilityServiceHost);
    await boundary.maybeFireTeamLaunchedNotificationWhenAllMembersJoined(target);
    expect(target.onProgress).not.toHaveBeenCalled();
    promoted = true;
    target.progress.state = 'ready';
    await boundary.fireTeamLaunchedNotification(target);
    expect(fireNotification).toHaveBeenCalledTimes(1);
    expect(target.onProgress).toHaveBeenCalledWith(target.progress);
  });

  it.each(['cancelled', 'killed', 'stale-lane', 'unconfirmed', 'hard-failure', 'disconnected'])(
    'does not clear joining diagnostics for %s evidence',
    (condition) => {
      const target = confirmedLaunchRun();
      if (condition === 'cancelled') target.cancelRequested = true;
      if (condition === 'killed') target.processKilled = true;
      if (condition === 'disconnected') target.progress.state = 'disconnected';
      const lane = target.mixedSecondaryLanes[0];
      if (condition === 'stale-lane') lane.runId = 'new-secondary-run';
      if (condition === 'unconfirmed')
        lane.result!.members['opencode-worker'].bootstrapConfirmed = false;
      if (condition === 'hard-failure') lane.result!.members['opencode-worker'].hardFailure = true;
      const previous = target.progress;
      expect(publishConfirmedLaunchProgress(target)).toBe(false);
      expect(target.progress).toBe(previous);
      expect(target.onProgress).not.toHaveBeenCalled();
    }
  );
});

function confirmedLaunchRun(): ProvisioningRun {
  const members = ['codex-worker', 'haiku-worker', 'opencode-worker'];
  return run({
    isLaunch: true,
    expectedMembers: members,
    progress: progress({
      state: 'ready',
      message: 'Team provisioned - 2/3 teammates made contact, 1 still joining',
      messageSeverity: 'warning',
      warnings: ['Unrelated advisory'],
      cliLogsTail: 'retained diagnostics',
    }),
    memberSpawnStatuses: new Map(
      members.map((name) => [
        name,
        {
          ...createInitialMemberSpawnStatusEntry(),
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
        },
      ])
    ),
    mixedSecondaryLanes: [
      {
        laneId: 'secondary:opencode:opencode-worker',
        providerId: 'opencode',
        member: { name: 'opencode-worker', role: 'developer' },
        runId: 'secondary-run',
        state: 'finished',
        warnings: [],
        diagnostics: [],
        result: {
          runId: 'secondary-run',
          teamName: 'team',
          launchPhase: 'finished',
          teamLaunchState: 'clean_success',
          members: {
            'opencode-worker': {
              memberName: 'opencode-worker',
              providerId: 'opencode',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              diagnostics: [],
            },
          },
          warnings: [],
          diagnostics: [],
        },
      },
    ],
  });
}

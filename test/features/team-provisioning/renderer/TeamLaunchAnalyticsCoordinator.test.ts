import { describe, expect, it, vi } from 'vitest';

import { TeamLaunchAnalyticsCoordinator } from '../../../../src/features/team-provisioning/renderer/utils/TeamLaunchAnalyticsCoordinator';

import type {
  TeamLaunchAnalyticsCoordinatorDependencies,
  TeamLaunchAnalyticsErrorClass,
} from '../../../../src/features/team-provisioning/renderer/ports/TeamLaunchAnalyticsPorts';
import type {
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProvisioningProgress,
  TeamViewSnapshot,
} from '@shared/types';

function progress(
  state: TeamProvisioningProgress['state'],
  overrides: Partial<TeamProvisioningProgress> = {}
): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'sandbox-team',
    state,
    message: state,
    startedAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:00:01.000Z',
    ...overrides,
  };
}

function snapshot(providerIds: ('anthropic' | 'codex')[] = ['anthropic']): TeamViewSnapshot {
  return {
    teamName: 'sandbox-team',
    config: { name: 'Sandbox Team' },
    tasks: [],
    members: providerIds.map((providerId, index) => ({
      name: `member-${index}`,
      currentTaskId: null,
      taskCount: 0,
      providerId,
    })),
    kanbanState: { teamName: 'sandbox-team', reviewers: [], tasks: {} },
    processes: [],
  };
}

function createHarness() {
  const recorder = {
    recordCreate: vi.fn(),
    recordLaunchEnd: vi.fn(),
    recordLaunchStepEnd: vi.fn(),
  };
  const metrics: TeamLaunchAnalyticsCoordinatorDependencies['metrics'] = {
    classifyError: (error): TeamLaunchAnalyticsErrorClass =>
      String(error).includes('timeout') ? 'timeout' : 'unknown',
    elapsedMsBetweenIso: (startedAt, endedAt) => {
      const start = startedAt ? Date.parse(startedAt) : Number.NaN;
      const end = endedAt ? Date.parse(endedAt) : Number.NaN;
      return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
    },
    elapsedMsSince: (startedAtMs) => 10_000 - startedAtMs,
    hasMixedProviders: (providerIds) =>
      new Set(providerIds.filter((providerId) => providerId != null)).size > 1,
  };
  const coordinator = new TeamLaunchAnalyticsCoordinator({
    metrics,
    nowMs: () => Date.parse('2026-07-24T10:00:10.000Z'),
    recorder,
  });

  return { coordinator, recorder };
}

describe('TeamLaunchAnalyticsCoordinator', () => {
  it('records create acceptance through the launch port and retains its run context', () => {
    const { coordinator, recorder } = createHarness();
    const launchPort = coordinator.createLaunchPort();
    const request = {
      teamName: 'sandbox-team',
      cwd: '/sandbox/project',
      providerId: 'codex',
      members: [{ name: 'alice' }, { name: 'bob', providerId: 'anthropic' }],
    } satisfies TeamCreateRequest;
    const context = launchPort.createContext(request, 1_000);

    launchPort.recordCreateAccepted(request, 'run-1', context);
    coordinator.recordTerminalProgress(progress('ready'), null);

    expect(recorder.recordCreate).toHaveBeenCalledWith({
      source: 'dialog',
      memberCount: 2,
      providerIds: ['codex', 'anthropic'],
      multimodelEnabled: true,
    });
    expect(recorder.recordLaunchEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        memberCount: 2,
        providerIds: ['codex', 'anthropic'],
        success: true,
      })
    );
  });

  it('deduplicates repeated step and terminal events for one run', () => {
    const { coordinator, recorder } = createHarness();
    const validating = progress('validating', {
      updatedAt: '2026-07-24T10:00:00.000Z',
    });
    const spawning = progress('spawning', {
      updatedAt: '2026-07-24T10:00:02.000Z',
    });

    coordinator.recordStepTransition(undefined, validating, snapshot());
    coordinator.recordStepTransition(validating, spawning, snapshot());
    coordinator.recordStepTransition(validating, spawning, snapshot());
    coordinator.recordTerminalProgress(progress('ready'), snapshot());
    coordinator.recordTerminalProgress(progress('ready'), snapshot());

    expect(recorder.recordLaunchStepEnd).toHaveBeenCalledTimes(1);
    expect(recorder.recordLaunchStepEnd).toHaveBeenCalledWith({
      step: 'config_validation',
      success: true,
      durationMs: 2_000,
      memberCount: 1,
      providerIds: ['anthropic'],
      errorClass: 'none',
      partialFailure: false,
    });
    expect(recorder.recordLaunchEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps a shared analytics step open across provisioning state changes', () => {
    const { coordinator, recorder } = createHarness();
    const configuring = progress('configuring', {
      updatedAt: '2026-07-24T10:00:02.000Z',
    });
    const assembling = progress('assembling', {
      updatedAt: '2026-07-24T10:00:04.000Z',
    });
    const finalizing = progress('finalizing', {
      updatedAt: '2026-07-24T10:00:07.000Z',
    });

    coordinator.recordStepTransition(undefined, configuring, snapshot());
    coordinator.recordStepTransition(configuring, assembling, snapshot());
    coordinator.recordStepTransition(assembling, finalizing, snapshot());

    expect(recorder.recordLaunchStepEnd).toHaveBeenCalledTimes(1);
    expect(recorder.recordLaunchStepEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'member_spawn',
        durationMs: 7_000,
      })
    );
  });

  it('keeps concurrent run contexts isolated when progress arrives out of order', () => {
    const { coordinator, recorder } = createHarness();
    const launchPort = coordinator.createLaunchPort();
    const codexRequest = {
      teamName: 'sandbox-team',
      cwd: '/sandbox/project',
      providerId: 'codex',
    } satisfies TeamLaunchRequest;
    const anthropicRequest = {
      ...codexRequest,
      teamName: 'other-team',
      providerId: 'anthropic',
    } satisfies TeamLaunchRequest;

    coordinator.recordStepTransition(
      undefined,
      progress('spawning', { runId: 'run-early' }),
      snapshot(['anthropic'])
    );
    launchPort.recordLaunchAccepted(
      'run-early',
      launchPort.launchContext(codexRequest, null, 1_000)
    );
    launchPort.recordLaunchAccepted(
      'run-other',
      launchPort.launchContext(anthropicRequest, null, 2_000)
    );
    coordinator.recordTerminalProgress(progress('ready', { runId: 'run-other' }), null);
    coordinator.recordTerminalProgress(progress('ready', { runId: 'run-early' }), null);

    expect(recorder.recordLaunchEnd.mock.calls.map(([event]) => event.providerIds)).toEqual([
      ['anthropic'],
      ['codex'],
    ]);
  });

  it('records disconnected step failures with classified error and partial failure', () => {
    const { coordinator, recorder } = createHarness();
    const spawning = progress('spawning', {
      updatedAt: '2026-07-24T10:00:04.000Z',
    });
    const disconnected = progress('disconnected', {
      error: 'runtime timeout',
      updatedAt: '2026-07-24T10:00:02.000Z',
      launchDiagnostics: [
        {
          id: 'diagnostic-1',
          severity: 'error',
          code: 'runtime_not_found',
          label: 'Runtime not found',
          observedAt: '2026-07-24T10:00:02.000Z',
        },
      ],
    });

    coordinator.recordStepTransition(undefined, spawning, snapshot());
    coordinator.recordStepTransition(spawning, disconnected, snapshot());

    expect(recorder.recordLaunchStepEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 2_000,
        errorClass: 'timeout',
        partialFailure: true,
        success: false,
      })
    );
  });

  it('reports IPC failure from the captured context without registering a terminal run', () => {
    const { coordinator, recorder } = createHarness();
    const launchPort = coordinator.createLaunchPort();
    const context = {
      startedAtMs: 8_000,
      memberCount: 2,
      providerIds: ['codex'],
    };

    launchPort.recordIpcFailure(context, new Error('request timeout'));

    expect(recorder.recordLaunchEnd).toHaveBeenCalledWith({
      success: false,
      durationMs: 2_000,
      memberCount: 2,
      providerIds: ['codex'],
      failureReasonClass: 'timeout',
      partialFailure: false,
    });
  });

  it('reset releases dedupe state so the same run can be asserted independently', () => {
    const { coordinator, recorder } = createHarness();
    const ready = progress('ready');

    coordinator.recordTerminalProgress(ready, snapshot());
    coordinator.reset();
    coordinator.recordTerminalProgress(ready, snapshot());

    expect(recorder.recordLaunchEnd).toHaveBeenCalledTimes(2);
  });

  it('clearRun releases step and terminal dedupe state for a reused run id', () => {
    const { coordinator, recorder } = createHarness();
    const validating = progress('validating', {
      updatedAt: '2026-07-24T10:00:00.000Z',
    });
    const spawning = progress('spawning', {
      updatedAt: '2026-07-24T10:00:02.000Z',
    });
    const ready = progress('ready');

    coordinator.recordStepTransition(undefined, validating, snapshot());
    coordinator.recordStepTransition(validating, spawning, snapshot());
    coordinator.recordTerminalProgress(ready, snapshot());
    coordinator.clearRun('run-1');
    coordinator.recordStepTransition(undefined, validating, snapshot());
    coordinator.recordStepTransition(validating, spawning, snapshot());
    coordinator.recordTerminalProgress(ready, snapshot());

    expect(recorder.recordLaunchStepEnd).toHaveBeenCalledTimes(2);
    expect(recorder.recordLaunchEnd).toHaveBeenCalledTimes(2);
  });
});

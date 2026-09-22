import { describe, expect, it, vi } from 'vitest';

import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import {
  applyPrimaryBootstrapTruthToLaunchReportingSnapshot,
  overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState,
  type PrimaryBootstrapTruthReportingPorts,
  type PrimaryBootstrapTruthRunLike,
} from '../TeamProvisioningPrimaryBootstrapTruthReporting';

import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

const startedAt = '2026-01-01T00:00:00.000Z';
const staleBootstrapAt = '2025-12-31T23:59:59.000Z';
const bootstrapUpdatedAt = '2026-01-01T00:00:05.000Z';
const observedAt = '2026-01-01T00:00:06.000Z';
const helperNow = '2026-01-01T00:00:07.000Z';

function status(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'offline',
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    updatedAt: startedAt,
    ...overrides,
  };
}

function member(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'Builder',
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: startedAt,
    ...overrides,
  };
}

function run(overrides: Partial<PrimaryBootstrapTruthRunLike> = {}): PrimaryBootstrapTruthRunLike {
  return {
    teamName: 'demo',
    runId: 'run-1',
    startedAt,
    isLaunch: true,
    effectiveMembers: [{ name: 'Builder' }],
    expectedMembers: ['Builder'],
    mixedSecondaryLanes: [],
    memberSpawnStatuses: new Map<string, MemberSpawnStatusEntry>(),
    pendingMemberRestarts: new Map<string, unknown>([['Builder', {}]]),
    ...overrides,
  };
}

function snapshot(input: {
  updatedAt?: string;
  members?: Record<string, PersistedTeamLaunchMemberState>;
  bootstrapExpectedMembers?: readonly string[];
}): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName: 'demo',
    expectedMembers: ['Builder'],
    bootstrapExpectedMembers: input.bootstrapExpectedMembers ?? ['Builder'],
    launchPhase: 'active',
    members: input.members,
    updatedAt: input.updatedAt ?? bootstrapUpdatedAt,
  });
}

function confirmedBootstrapSnapshot(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchSnapshot {
  return snapshot({
    members: {
      Builder: member({
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        firstSpawnAcceptedAt: bootstrapUpdatedAt,
        lastHeartbeatAt: observedAt,
        lastRuntimeAliveAt: observedAt,
        lastEvaluatedAt: observedAt,
        ...overrides,
      }),
    },
  });
}

function ports(
  bootstrapSnapshot: PersistedTeamLaunchSnapshot | null
): PrimaryBootstrapTruthReportingPorts<PrimaryBootstrapTruthRunLike> {
  return {
    readBootstrapLaunchSnapshot: vi.fn(async () => bootstrapSnapshot),
    nowIso: () => helperNow,
    isOpenCodeSecondaryLaneMemberInRun: vi.fn(() => false),
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    syncMemberLaunchGraceCheck: vi.fn(),
  };
}

describe('primary bootstrap truth reporting', () => {
  it('leaves run statuses and reporting snapshots unchanged when bootstrap state is missing', async () => {
    const targetRun = run({
      memberSpawnStatuses: new Map([['Builder', status({ runtimeDiagnostic: 'waiting' })]]),
    });
    const targetSnapshot = snapshot({
      members: { Builder: member({ runtimeDiagnostic: 'waiting' }) },
    });
    const missingPorts = ports(null);

    await overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(targetRun, missingPorts);
    const reconciled = await applyPrimaryBootstrapTruthToLaunchReportingSnapshot(
      targetRun,
      targetSnapshot,
      missingPorts
    );

    expect(targetRun.memberSpawnStatuses.get('Builder')).toMatchObject({
      launchState: 'starting',
      runtimeDiagnostic: 'waiting',
    });
    expect(reconciled).toBe(targetSnapshot);
    expect(missingPorts.syncMemberTaskActivityForRuntimeTransition).not.toHaveBeenCalled();
    expect(missingPorts.syncMemberLaunchGraceCheck).not.toHaveBeenCalled();
  });

  it('keeps the existing state when bootstrap state cannot be read', async () => {
    const targetRun = run({
      memberSpawnStatuses: new Map([['Builder', status({ runtimeDiagnostic: 'waiting' })]]),
    });
    const failingPorts = {
      ...ports(null),
      readBootstrapLaunchSnapshot: vi.fn(async () => {
        throw new Error('unreadable');
      }),
    };
    const targetSnapshot = snapshot({
      members: { Builder: member({ runtimeDiagnostic: 'waiting' }) },
    });

    await overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(targetRun, failingPorts);
    const reconciled = await applyPrimaryBootstrapTruthToLaunchReportingSnapshot(
      targetRun,
      targetSnapshot,
      failingPorts
    );

    expect(targetRun.memberSpawnStatuses.get('Builder')?.launchState).toBe('starting');
    expect(reconciled).toBe(targetSnapshot);
  });

  it('ignores stale or incomplete bootstrap evidence', async () => {
    const staleRun = run({
      memberSpawnStatuses: new Map([['Builder', status()]]),
    });
    const stalePorts = ports(
      snapshot({
        updatedAt: staleBootstrapAt,
        members: {
          Builder: member({ bootstrapConfirmed: true, lastHeartbeatAt: observedAt }),
        },
      })
    );
    await overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(staleRun, stalePorts);
    expect(staleRun.memberSpawnStatuses.get('Builder')?.launchState).toBe('starting');

    const incompleteRun = run({
      memberSpawnStatuses: new Map([['Builder', status()]]),
    });
    const incompletePorts = ports(
      snapshot({
        members: {
          Builder: member({ agentToolAccepted: true, bootstrapConfirmed: false }),
        },
      })
    );
    const targetSnapshot = snapshot({
      members: { Builder: member({ agentToolAccepted: true, bootstrapConfirmed: false }) },
    });

    await overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(
      incompleteRun,
      incompletePorts
    );
    const reconciled = await applyPrimaryBootstrapTruthToLaunchReportingSnapshot(
      incompleteRun,
      targetSnapshot,
      incompletePorts
    );

    expect(incompleteRun.memberSpawnStatuses.get('Builder')?.launchState).toBe('starting');
    expect(reconciled).toBe(targetSnapshot);
  });

  it('overlays confirmed primary bootstrap truth into live run statuses', async () => {
    const current = status({
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Teammate did not join within the launch grace window.',
      runtimeDiagnostic: 'Teammate did not join within the launch grace window.',
    });
    const pendingRestarts = new Map<string, unknown>([['Builder', {}]]);
    const targetRun = run({
      memberSpawnStatuses: new Map([['Builder', current]]),
      pendingMemberRestarts: pendingRestarts,
    });
    const helperPorts = ports(confirmedBootstrapSnapshot());

    await overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(targetRun, helperPorts);

    expect(targetRun.memberSpawnStatuses.get('Builder')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      hardFailureReason: undefined,
      livenessSource: 'heartbeat',
      firstSpawnAcceptedAt: bootstrapUpdatedAt,
      lastHeartbeatAt: observedAt,
      livenessLastCheckedAt: helperNow,
    });
    expect(pendingRestarts.has('Builder')).toBe(false);
    expect(helperPorts.syncMemberTaskActivityForRuntimeTransition).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      current,
      expect.objectContaining({ launchState: 'confirmed_alive' }),
      helperNow
    );
    expect(helperPorts.syncMemberLaunchGraceCheck).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      expect.objectContaining({ launchState: 'confirmed_alive' })
    );
  });

  it('applies confirmed primary bootstrap truth to launch reporting while preserving warnings', async () => {
    const targetRun = run();
    const targetSnapshot = snapshot({
      members: {
        Builder: member({
          runtimeDiagnostic: 'operator warning remains visible',
          runtimeDiagnosticSeverity: 'warning',
          diagnostics: ['launch preview diagnostic'],
          sources: { hardFailureSignal: true },
        }),
      },
    });

    const reconciled = await applyPrimaryBootstrapTruthToLaunchReportingSnapshot(
      targetRun,
      targetSnapshot,
      ports(confirmedBootstrapSnapshot())
    );

    expect(reconciled).not.toBe(targetSnapshot);
    expect(reconciled?.members.Builder).toMatchObject({
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      runtimeDiagnostic: 'operator warning remains visible',
      runtimeDiagnosticSeverity: 'warning',
      firstSpawnAcceptedAt: bootstrapUpdatedAt,
      lastHeartbeatAt: observedAt,
      lastRuntimeAliveAt: observedAt,
      lastEvaluatedAt: helperNow,
      sources: {
        nativeHeartbeat: true,
        hardFailureSignal: undefined,
      },
      diagnostics: undefined,
    });
  });

  it('reports confirmed primary bootstrap truth as runtime alive', async () => {
    const targetRun = run();
    const targetSnapshot = snapshot({
      members: { Builder: member({ runtimeAlive: false }) },
    });

    const reconciled = await applyPrimaryBootstrapTruthToLaunchReportingSnapshot(
      targetRun,
      targetSnapshot,
      ports(confirmedBootstrapSnapshot({ runtimeAlive: false }))
    );

    expect(reconciled?.members.Builder).toMatchObject({
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
    });
  });

  it('is stable when the same primary bootstrap truth is applied repeatedly', async () => {
    const targetRun = run({
      memberSpawnStatuses: new Map([['Builder', status()]]),
    });
    const helperPorts = ports(confirmedBootstrapSnapshot());

    await overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(targetRun, helperPorts);
    const firstStatus = targetRun.memberSpawnStatuses.get('Builder');
    await overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(targetRun, helperPorts);
    expect(targetRun.memberSpawnStatuses.get('Builder')).toEqual(firstStatus);

    const targetSnapshot = snapshot({
      members: { Builder: member() },
    });
    const firstSnapshot = await applyPrimaryBootstrapTruthToLaunchReportingSnapshot(
      targetRun,
      targetSnapshot,
      helperPorts
    );
    const secondSnapshot = await applyPrimaryBootstrapTruthToLaunchReportingSnapshot(
      targetRun,
      firstSnapshot,
      helperPorts
    );

    expect(secondSnapshot).toEqual(firstSnapshot);
  });
});

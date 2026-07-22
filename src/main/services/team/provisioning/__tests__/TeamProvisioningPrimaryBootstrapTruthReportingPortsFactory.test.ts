import { describe, expect, it, vi } from 'vitest';

import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import {
  createTeamProvisioningPrimaryBootstrapTruthReportingBoundary,
  createTeamProvisioningPrimaryBootstrapTruthReportingDepsFromService,
  type TeamProvisioningPrimaryBootstrapTruthReportingServiceAdapter,
  type TeamProvisioningPrimaryBootstrapTruthReportingServiceHost,
} from '../TeamProvisioningPrimaryBootstrapTruthReportingPortsFactory';

import type { PrimaryBootstrapTruthRunLike } from '../TeamProvisioningPrimaryBootstrapTruthReporting';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

const startedAt = '2026-01-01T00:00:00.000Z';
const bootstrapUpdatedAt = '2026-01-01T00:00:05.000Z';
const observedAt = '2026-01-01T00:00:06.000Z';
const factoryNow = '2026-01-01T00:00:07.000Z';

type TestRun = PrimaryBootstrapTruthRunLike;
type TestServiceAdapter = TeamProvisioningPrimaryBootstrapTruthReportingServiceAdapter<TestRun>;

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

function run(overrides: Partial<TestRun> = {}): TestRun {
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
}): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName: 'demo',
    expectedMembers: ['Builder'],
    bootstrapExpectedMembers: ['Builder'],
    launchPhase: 'active',
    members: input.members,
    updatedAt: input.updatedAt ?? bootstrapUpdatedAt,
  });
}

function confirmedBootstrapSnapshot(): PersistedTeamLaunchSnapshot {
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
      }),
    },
  });
}

function createServiceAdapter(overrides: Partial<TestServiceAdapter> = {}): TestServiceAdapter {
  return {
    isOpenCodeSecondaryLaneMemberInRun: vi.fn(() => false),
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    syncMemberLaunchGraceCheck: vi.fn(),
    syncRunMemberSpawnStatusesFromSnapshot: vi.fn(),
    ...overrides,
  };
}

function createBoundary(input: {
  service?: TestServiceAdapter;
  bootstrapSnapshot?: PersistedTeamLaunchSnapshot | null;
  writeLaunchStateSnapshot?: (
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ) => Promise<PersistedTeamLaunchSnapshot>;
  warn?: (message: string) => void;
}) {
  const service = input.service ?? createServiceAdapter();
  const readBootstrapLaunchSnapshot = vi.fn(async () => input.bootstrapSnapshot ?? null);
  const writeLaunchStateSnapshot = vi.fn(
    input.writeLaunchStateSnapshot ?? (async (_teamName, nextSnapshot) => nextSnapshot)
  );
  const warn = vi.fn(input.warn ?? (() => undefined));

  return {
    boundary: createTeamProvisioningPrimaryBootstrapTruthReportingBoundary({
      service,
      readBootstrapLaunchSnapshot,
      writeLaunchStateSnapshot,
      nowIso: () => factoryNow,
      logger: { warn },
    }),
    service,
    readBootstrapLaunchSnapshot,
    writeLaunchStateSnapshot,
    warn,
  };
}

describe('TeamProvisioningPrimaryBootstrapTruthReportingPortsFactory', () => {
  it('builds primary bootstrap truth deps from service-shaped host wiring', async () => {
    const targetRun = run();
    const previous = status({ launchState: 'starting' });
    const next = status({ launchState: 'confirmed_alive' });
    const targetSnapshot = confirmedBootstrapSnapshot();
    const persistedSnapshot = snapshot({ members: { Builder: member() } });
    const service = {
      syncMemberTaskActivityForRuntimeTransition: vi.fn(),
      syncMemberLaunchGraceCheck: vi.fn(),
      syncRunMemberSpawnStatusesFromSnapshot: vi.fn(),
      writeLaunchStateSnapshot: vi.fn(async () => persistedSnapshot),
    } as unknown as TeamProvisioningPrimaryBootstrapTruthReportingServiceHost<TestRun>;
    const isOpenCodeSecondaryLaneMemberInRun = vi.fn(() => true);
    const readBootstrapLaunchSnapshot = vi.fn(async () => targetSnapshot);
    const warn = vi.fn();

    const deps = createTeamProvisioningPrimaryBootstrapTruthReportingDepsFromService(service, {
      isOpenCodeSecondaryLaneMemberInRun,
      readBootstrapLaunchSnapshot,
      nowIso: () => factoryNow,
      logger: { warn },
    });

    expect(deps.service.isOpenCodeSecondaryLaneMemberInRun(targetRun, 'Builder')).toBe(true);
    deps.service.syncMemberTaskActivityForRuntimeTransition(
      targetRun,
      'Builder',
      previous,
      next,
      observedAt
    );
    deps.service.syncMemberLaunchGraceCheck(targetRun, 'Builder', next);
    deps.service.syncRunMemberSpawnStatusesFromSnapshot(targetRun, targetSnapshot);
    await expect(deps.readBootstrapLaunchSnapshot('demo')).resolves.toBe(targetSnapshot);
    await expect(deps.writeLaunchStateSnapshot('demo', targetSnapshot)).resolves.toBe(
      persistedSnapshot
    );

    expect(deps.nowIso()).toBe(factoryNow);
    deps.logger.warn('warning');
    expect(warn).toHaveBeenCalledWith('warning');
    expect(isOpenCodeSecondaryLaneMemberInRun).toHaveBeenCalledWith(targetRun, 'Builder');
    expect(service.syncMemberTaskActivityForRuntimeTransition).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      previous,
      next,
      observedAt
    );
    expect(service.syncMemberLaunchGraceCheck).toHaveBeenCalledWith(targetRun, 'Builder', next);
    expect(service.syncRunMemberSpawnStatusesFromSnapshot).toHaveBeenCalledWith(
      targetRun,
      targetSnapshot
    );
    expect(readBootstrapLaunchSnapshot).toHaveBeenCalledWith('demo');
    expect(service.writeLaunchStateSnapshot).toHaveBeenCalledWith('demo', targetSnapshot);
  });

  it('wires primary bootstrap truth overlay through service callbacks', async () => {
    const targetRun = run({
      memberSpawnStatuses: new Map([['Builder', status()]]),
    });
    const { boundary, service, readBootstrapLaunchSnapshot } = createBoundary({
      bootstrapSnapshot: confirmedBootstrapSnapshot(),
    });

    await boundary.overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(targetRun);

    expect(readBootstrapLaunchSnapshot).toHaveBeenCalledWith('demo');
    expect(service.isOpenCodeSecondaryLaneMemberInRun).toHaveBeenCalledWith(targetRun, 'Builder');
    expect(service.syncMemberTaskActivityForRuntimeTransition).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      expect.objectContaining({ launchState: 'starting' }),
      expect.objectContaining({ launchState: 'confirmed_alive' }),
      factoryNow
    );
    expect(service.syncMemberLaunchGraceCheck).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      expect.objectContaining({ launchState: 'confirmed_alive' })
    );
    expect(targetRun.memberSpawnStatuses.get('Builder')).toMatchObject({
      launchState: 'confirmed_alive',
      updatedAt: factoryNow,
    });
  });

  it('reconciles final launch reporting through snapshot sync and persistence ports', async () => {
    const targetRun = run();
    const targetSnapshot = snapshot({
      members: { Builder: member() },
    });
    const { boundary, service, writeLaunchStateSnapshot } = createBoundary({
      bootstrapSnapshot: confirmedBootstrapSnapshot(),
    });

    const reconciled = await boundary.reconcileFinalLaunchReportingSnapshot(
      targetRun,
      targetSnapshot
    );

    expect(reconciled?.members.Builder.launchState).toBe('confirmed_alive');
    expect(service.syncRunMemberSpawnStatusesFromSnapshot).toHaveBeenCalledWith(
      targetRun,
      reconciled
    );
    expect(writeLaunchStateSnapshot).toHaveBeenCalledWith('demo', reconciled);
  });

  it('returns the reconciled snapshot and warns when final launch reporting persistence fails', async () => {
    const targetRun = run();
    const targetSnapshot = snapshot({
      members: { Builder: member() },
    });
    const { boundary, service, warn, writeLaunchStateSnapshot } = createBoundary({
      bootstrapSnapshot: confirmedBootstrapSnapshot(),
      writeLaunchStateSnapshot: async () => {
        throw new Error('disk full');
      },
    });

    const reconciled = await boundary.reconcileFinalLaunchReportingSnapshot(
      targetRun,
      targetSnapshot
    );

    expect(reconciled?.members.Builder.launchState).toBe('confirmed_alive');
    expect(service.syncRunMemberSpawnStatusesFromSnapshot).toHaveBeenCalledWith(
      targetRun,
      reconciled
    );
    expect(writeLaunchStateSnapshot).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[demo] Failed to persist reconciled launch reporting snapshot: disk full'
    );
  });
});

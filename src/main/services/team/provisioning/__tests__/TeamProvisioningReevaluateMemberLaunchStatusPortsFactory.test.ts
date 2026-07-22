import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningReevaluateMemberLaunchStatusBoundary,
  createTeamProvisioningReevaluateMemberLaunchStatusDepsFromService,
  createTeamProvisioningReevaluateMemberLaunchStatusPorts,
  type TeamProvisioningReevaluateMemberLaunchStatusServiceHost,
} from '../TeamProvisioningReevaluateMemberLaunchStatusPortsFactory';

import type { ReevaluateMemberLaunchStatusRunLike } from '../TeamProvisioningReevaluateMemberLaunchStatus';
import type { LiveTeamAgentRuntimeMetadata } from '../TeamProvisioningRuntimeMetadataPolicy';
import type { MemberSpawnStatusEntry } from '@shared/types';

const NOW = '2026-01-01T00:10:00.000Z';
const NOW_MS = Date.parse(NOW);
const ACCEPTED_AT = '2026-01-01T00:00:00.000Z';

function status(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'starting',
    firstSpawnAcceptedAt: ACCEPTED_AT,
    updatedAt: ACCEPTED_AT,
    ...overrides,
  };
}

function run(
  statuses: [string, MemberSpawnStatusEntry][] = [['Worker', status()]]
): ReevaluateMemberLaunchStatusRunLike {
  return {
    runId: 'run-1',
    teamName: 'Team',
    request: { cwd: '/workspace/team' },
    provisioningOutputParts: [],
    memberSpawnStatuses: new Map(statuses),
    pendingMemberRestarts: new Map(),
    progress: {} as never,
    onProgress: vi.fn(),
    isLaunch: true,
    provisioningComplete: false,
  };
}

function createReconciliationPorts() {
  return {
    buildOpenCodeSecondaryBootstrapStallDiagnostic: vi.fn(async () => 'diagnostic'),
    setOpenCodeRuntimePendingBootstrapStatus: vi.fn(),
    maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt: vi.fn(async () => undefined),
    scheduleOpenCodeBootstrapStallReevaluation: vi.fn(),
    setOpenCodeSecondaryBootstrapStalledStatus: vi.fn(),
  };
}

describe('createTeamProvisioningReevaluateMemberLaunchStatusPorts', () => {
  it('wires reevaluate member launch status ports to the service adapter', async () => {
    const targetRun = run();
    const previous = status();
    const next = status({ runtimeAlive: false });
    const reconciliationPorts = createReconciliationPorts();
    const service = {
      refreshMemberSpawnStatusesFromLeadInbox: vi.fn(async () => undefined),
      maybeAuditMemberSpawnStatuses: vi.fn(async () => undefined),
      getLiveTeamAgentRuntimeMetadata: vi.fn(async () => new Map()),
      isOpenCodeSecondaryLaneMemberInRun: vi.fn(() => false),
      getOpenCodeBootstrapStallReconciliationPorts: vi.fn(() => reconciliationPorts),
      setMemberSpawnStatus: vi.fn(),
      emitMemberSpawnChange: vi.fn(),
      scheduleOpenCodeBootstrapStallReevaluation: vi.fn(),
      syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    };

    const ports = createTeamProvisioningReevaluateMemberLaunchStatusPorts({
      nowIso: () => NOW,
      nowMs: () => NOW_MS,
      service,
    });

    await ports.refreshMemberSpawnStatusesFromLeadInbox(targetRun);
    await ports.maybeAuditMemberSpawnStatuses(targetRun, { force: true });
    await ports.getLiveTeamAgentRuntimeMetadata('Team');
    ports.isOpenCodeSecondaryLaneMemberInRun(targetRun, 'Worker');
    ports.setMemberSpawnStatus(targetRun, 'Worker', 'online', undefined, 'process');
    ports.emitMemberSpawnChange(targetRun, 'Worker');
    ports.scheduleOpenCodeBootstrapStallReevaluation(targetRun, 'Worker', ACCEPTED_AT);
    ports.syncMemberTaskActivityForRuntimeTransition(targetRun, 'Worker', previous, next, NOW);

    expect(ports.nowIso()).toBe(NOW);
    expect(ports.nowMs()).toBe(NOW_MS);
    expect(ports.reconcileOpenCodeBootstrapStallPorts).toBe(reconciliationPorts);
    expect(service.getOpenCodeBootstrapStallReconciliationPorts).toHaveBeenCalledTimes(1);
    expect(service.refreshMemberSpawnStatusesFromLeadInbox).toHaveBeenCalledWith(targetRun);
    expect(service.maybeAuditMemberSpawnStatuses).toHaveBeenCalledWith(targetRun, {
      force: true,
    });
    expect(service.getLiveTeamAgentRuntimeMetadata).toHaveBeenCalledWith('Team');
    expect(service.isOpenCodeSecondaryLaneMemberInRun).toHaveBeenCalledWith(targetRun, 'Worker');
    expect(service.setMemberSpawnStatus).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      'online',
      undefined,
      'process'
    );
    expect(service.emitMemberSpawnChange).toHaveBeenCalledWith(targetRun, 'Worker');
    expect(service.scheduleOpenCodeBootstrapStallReevaluation).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      ACCEPTED_AT
    );
    expect(service.syncMemberTaskActivityForRuntimeTransition).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      previous,
      next,
      NOW
    );
  });

  it('builds reevaluate member launch status deps from service-shaped dependencies', async () => {
    const targetRun = run();
    const reconciliationPorts = createReconciliationPorts();
    const isOpenCodeSecondaryLaneMemberInRun = vi.fn(() => true);
    const service = {
      refreshMemberSpawnStatusesFromLeadInbox: vi.fn(async () => undefined),
      maybeAuditMemberSpawnStatuses: vi.fn(async () => undefined),
      getLiveTeamAgentRuntimeMetadata: vi.fn(async () => new Map()),
      getOpenCodeBootstrapStallReconciliationPorts: vi.fn(() => reconciliationPorts),
      setMemberSpawnStatus: vi.fn(),
      emitMemberSpawnChange: vi.fn(),
      scheduleOpenCodeBootstrapStallReevaluation: vi.fn(),
      syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    } satisfies TeamProvisioningReevaluateMemberLaunchStatusServiceHost<ReevaluateMemberLaunchStatusRunLike>;

    const ports = createTeamProvisioningReevaluateMemberLaunchStatusPorts(
      createTeamProvisioningReevaluateMemberLaunchStatusDepsFromService(service, {
        nowIso: () => NOW,
        nowMs: () => NOW_MS,
        isOpenCodeSecondaryLaneMemberInRun,
      })
    );

    await ports.refreshMemberSpawnStatusesFromLeadInbox(targetRun);
    await ports.maybeAuditMemberSpawnStatuses(targetRun, { force: true });
    ports.isOpenCodeSecondaryLaneMemberInRun(targetRun, 'Worker');
    ports.setMemberSpawnStatus(targetRun, 'Worker', 'online');
    ports.emitMemberSpawnChange(targetRun, 'Worker');
    ports.scheduleOpenCodeBootstrapStallReevaluation(targetRun, 'Worker', ACCEPTED_AT);

    expect(ports.nowIso()).toBe(NOW);
    expect(ports.nowMs()).toBe(NOW_MS);
    expect(ports.reconcileOpenCodeBootstrapStallPorts).toBe(reconciliationPorts);
    expect(service.refreshMemberSpawnStatusesFromLeadInbox).toHaveBeenCalledWith(targetRun);
    expect(service.maybeAuditMemberSpawnStatuses).toHaveBeenCalledWith(targetRun, {
      force: true,
    });
    expect(isOpenCodeSecondaryLaneMemberInRun).toHaveBeenCalledWith(targetRun, 'Worker');
    expect(service.setMemberSpawnStatus).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      'online',
      undefined,
      undefined
    );
    expect(service.emitMemberSpawnChange).toHaveBeenCalledWith(targetRun, 'Worker');
    expect(service.scheduleOpenCodeBootstrapStallReevaluation).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      ACCEPTED_AT
    );
  });
});

describe('createTeamProvisioningReevaluateMemberLaunchStatusBoundary', () => {
  it('reevaluates through callback adapters without requiring unbound service methods', async () => {
    class Host {
      readonly calls: string[] = [];
      readonly runtime: ReadonlyMap<string, LiveTeamAgentRuntimeMetadata> = new Map([
        ['Worker', { alive: true, livenessKind: 'runtime_process' }],
      ]);

      async refreshMemberSpawnStatusesFromLeadInbox(
        _targetRun: ReevaluateMemberLaunchStatusRunLike
      ): Promise<void> {
        this.calls.push('refresh');
      }

      async maybeAuditMemberSpawnStatuses(
        _targetRun: ReevaluateMemberLaunchStatusRunLike,
        _options: { force: true }
      ): Promise<void> {
        this.calls.push('audit');
      }

      async getLiveTeamAgentRuntimeMetadata(
        _teamName: string
      ): Promise<ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>> {
        this.calls.push('metadata');
        return this.runtime;
      }

      setMemberSpawnStatus(
        targetRun: ReevaluateMemberLaunchStatusRunLike,
        memberName: string
      ): void {
        this.calls.push(`set:${targetRun.teamName}:${memberName}`);
      }
    }

    const host = new Host();
    const targetRun = run();
    const boundary = createTeamProvisioningReevaluateMemberLaunchStatusBoundary({
      nowIso: () => NOW,
      nowMs: () => NOW_MS,
      service: {
        refreshMemberSpawnStatusesFromLeadInbox: (targetRun) =>
          host.refreshMemberSpawnStatusesFromLeadInbox(targetRun),
        maybeAuditMemberSpawnStatuses: (targetRun, options) =>
          host.maybeAuditMemberSpawnStatuses(targetRun, options),
        getLiveTeamAgentRuntimeMetadata: (teamName) =>
          host.getLiveTeamAgentRuntimeMetadata(teamName),
        isOpenCodeSecondaryLaneMemberInRun: () => false,
        getOpenCodeBootstrapStallReconciliationPorts: createReconciliationPorts,
        setMemberSpawnStatus: (targetRun, memberName) =>
          host.setMemberSpawnStatus(targetRun, memberName),
        emitMemberSpawnChange: vi.fn(),
        scheduleOpenCodeBootstrapStallReevaluation: vi.fn(),
        syncMemberTaskActivityForRuntimeTransition: vi.fn(),
      },
    });

    await boundary.reevaluateMemberLaunchStatus(targetRun, 'Worker');

    expect(host.calls).toEqual(['refresh', 'audit', 'metadata', 'set:Team:Worker']);
  });
});

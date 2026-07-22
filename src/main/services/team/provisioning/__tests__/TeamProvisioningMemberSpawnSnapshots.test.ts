import { describe, expect, it, vi } from 'vitest';

import {
  createMemberSpawnStatusAuditPortsFromService,
  createMemberSpawnStatusMutationPortsFromService,
  type MemberSpawnStatusAuditRun,
  type MemberSpawnStatusAuditServiceHost,
  type MemberSpawnStatusMutationPorts,
  type MemberSpawnStatusMutationServiceHost,
  type MemberSpawnStatusRun,
  setMemberSpawnStatusForRun,
} from '../TeamProvisioningMemberSpawnSnapshots';

import type { MemberSpawnStatusEntry } from '@shared/types';

const baseStatus = (overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry => ({
  status: 'waiting',
  launchState: 'runtime_pending_bootstrap',
  agentToolAccepted: true,
  runtimeAlive: false,
  bootstrapConfirmed: false,
  hardFailure: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  firstSpawnAcceptedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const createRun = (): MemberSpawnStatusRun => ({
  runId: 'run-1',
  teamName: 'team-a',
  progress: {} as never,
  onProgress: vi.fn(),
  expectedMembers: ['api'],
  isLaunch: true,
  provisioningComplete: false,
  memberSpawnStatuses: new Map([['api', baseStatus()]]),
});

const createPorts = (): MemberSpawnStatusMutationPorts<MemberSpawnStatusRun> => ({
  nowIso: () => '2026-01-01T00:01:00.000Z',
  syncMemberTaskActivityForRuntimeTransition: vi.fn(),
  syncMemberLaunchGraceCheck: vi.fn(),
  updateLaunchDiagnostics: vi.fn(),
  appendMemberBootstrapDiagnostic: vi.fn(),
  isCurrentTrackedRun: vi.fn(() => true),
  emitMemberSpawnChange: vi.fn(),
  persistLaunchStateSnapshot: vi.fn(async () => undefined),
  reportBackgroundPersistenceError: vi.fn(),
});

describe('member spawn snapshot mutations', () => {
  it('builds mutation ports from service-shaped host wiring', async () => {
    const run = createRun();
    const previous = baseStatus({ status: 'waiting' });
    const next = baseStatus({ status: 'online' });
    const service = {
      syncMemberTaskActivityForRuntimeTransition: vi.fn(),
      syncMemberLaunchGraceCheck: vi.fn(),
      appendMemberBootstrapDiagnostic: vi.fn(),
      isCurrentTrackedRun: vi.fn(() => true),
      emitMemberSpawnChange: vi.fn(),
      persistLaunchStateSnapshot: vi.fn(async () => undefined),
    } satisfies MemberSpawnStatusMutationServiceHost<MemberSpawnStatusRun>;

    const ports = createMemberSpawnStatusMutationPortsFromService(service, {
      nowIso: () => '2026-01-01T00:03:00.000Z',
      buildLaunchDiagnostics: () => [
        {
          id: 'diag-api',
          memberName: 'api',
          severity: 'warning',
          code: 'runtime_process_detected',
          label: 'Runtime process detected',
          observedAt: '2026-01-01T00:03:00.000Z',
        },
      ],
      reportBackgroundPersistenceError: vi.fn(),
    });

    expect(ports.nowIso()).toBe('2026-01-01T00:03:00.000Z');
    ports.syncMemberTaskActivityForRuntimeTransition(
      run,
      'api',
      previous,
      next,
      '2026-01-01T00:03:01.000Z'
    );
    ports.syncMemberLaunchGraceCheck(run, 'api', next);
    ports.updateLaunchDiagnostics(run);
    ports.appendMemberBootstrapDiagnostic(run, 'api', 'diagnostic');
    expect(ports.isCurrentTrackedRun(run)).toBe(true);
    ports.emitMemberSpawnChange(run, 'api');
    await ports.persistLaunchStateSnapshot(run, 'active');

    expect(service.syncMemberTaskActivityForRuntimeTransition).toHaveBeenCalledWith(
      run,
      'api',
      previous,
      next,
      '2026-01-01T00:03:01.000Z'
    );
    expect(service.syncMemberLaunchGraceCheck).toHaveBeenCalledWith(run, 'api', next);
    expect(run.progress).toMatchObject({
      updatedAt: '2026-01-01T00:03:00.000Z',
      launchDiagnostics: [
        {
          id: 'diag-api',
          memberName: 'api',
          severity: 'warning',
        },
      ],
    });
    expect(run.onProgress).toHaveBeenCalledWith(run.progress);
    expect(service.appendMemberBootstrapDiagnostic).toHaveBeenCalledWith(run, 'api', 'diagnostic');
    expect(service.emitMemberSpawnChange).toHaveBeenCalledWith(run, 'api');
    expect(service.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'active');
  });

  it('builds audit ports from service-shaped host wiring', async () => {
    const run = { ...createRun(), lastMemberSpawnAuditAt: 0 } as MemberSpawnStatusAuditRun;
    const current = baseStatus();
    const service = {
      auditMemberSpawnStatuses: vi.fn(async () => undefined),
      findBootstrapTranscriptFailureReason: vi.fn(async () => 'failed'),
      findBootstrapRuntimeProofObservedAt: vi.fn(async () => '2026-01-01T00:02:00.000Z'),
      findBootstrapTranscriptOutcome: vi.fn(async () => ({
        kind: 'success',
        observedAt: '2026-01-01T00:02:00.000Z',
      })),
      setMemberSpawnStatus: vi.fn(),
      confirmMemberSpawnStatusFromTranscript: vi.fn(),
    } satisfies MemberSpawnStatusAuditServiceHost<MemberSpawnStatusAuditRun>;
    const isOpenCodeSecondaryLaneMemberInRun = vi.fn(() => true);

    const ports = createMemberSpawnStatusAuditPortsFromService(service, {
      nowMs: () => 123,
      minAuditIntervalMs: 456,
      isOpenCodeSecondaryLaneMemberInRun,
    });

    expect(ports.nowMs()).toBe(123);
    expect(ports.minAuditIntervalMs).toBe(456);
    await ports.auditMemberSpawnStatuses(run);
    await expect(ports.findBootstrapTranscriptFailureReason('team-a', 'api', 1)).resolves.toBe(
      'failed'
    );
    await expect(ports.findBootstrapRuntimeProofObservedAt('team-a', 'api', current)).resolves.toBe(
      '2026-01-01T00:02:00.000Z'
    );
    await expect(ports.findBootstrapTranscriptOutcome('team-a', 'api', 1)).resolves.toMatchObject({
      kind: 'success',
    });
    ports.setMemberSpawnStatus(run, 'api', 'error', 'error');
    ports.confirmMemberSpawnStatusFromTranscript(run, 'api', '2026-01-01T00:02:00.000Z');
    expect(ports.isOpenCodeSecondaryLaneMemberInRun(run, 'api')).toBe(true);

    expect(service.auditMemberSpawnStatuses).toHaveBeenCalledWith(run);
    expect(service.findBootstrapRuntimeProofObservedAt).toHaveBeenCalledWith(
      'team-a',
      'api',
      current
    );
    expect(service.setMemberSpawnStatus).toHaveBeenCalledWith(run, 'api', 'error', 'error');
    expect(service.confirmMemberSpawnStatusFromTranscript).toHaveBeenCalledWith(
      run,
      'api',
      '2026-01-01T00:02:00.000Z',
      undefined
    );
    expect(isOpenCodeSecondaryLaneMemberInRun).toHaveBeenCalledWith(run, 'api');
  });

  it('emits and persists changed online transitions without diagnostic text', () => {
    const run = createRun();
    const ports = createPorts();

    setMemberSpawnStatusForRun(
      {
        run,
        memberName: 'api',
        status: 'online',
      },
      ports
    );

    expect(run.memberSpawnStatuses.get('api')).toMatchObject({
      status: 'online',
      runtimeAlive: true,
    });
    expect(ports.appendMemberBootstrapDiagnostic).not.toHaveBeenCalled();
    expect(ports.emitMemberSpawnChange).toHaveBeenCalledWith(run, 'api');
    expect(ports.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'active');
  });

  it('reports rejected background persistence instead of leaking an unhandled rejection', async () => {
    const run = createRun();
    const ports = createPorts();
    const persistenceError = new Error('launch publication failed');
    vi.mocked(ports.persistLaunchStateSnapshot).mockRejectedValueOnce(persistenceError);

    setMemberSpawnStatusForRun(
      {
        run,
        memberName: 'api',
        status: 'online',
      },
      ports
    );

    await vi.waitFor(() =>
      expect(ports.reportBackgroundPersistenceError).toHaveBeenCalledWith(run, persistenceError)
    );
  });
});

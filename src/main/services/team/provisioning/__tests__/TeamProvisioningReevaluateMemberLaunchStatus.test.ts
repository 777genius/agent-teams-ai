import { describe, expect, it, vi } from 'vitest';

import { MEMBER_BOOTSTRAP_STALL_MS } from '../TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import {
  reevaluateMemberLaunchStatus,
  type ReevaluateMemberLaunchStatusPorts,
  type ReevaluateMemberLaunchStatusRunLike,
} from '../TeamProvisioningReevaluateMemberLaunchStatus';

import type { LiveTeamAgentRuntimeMetadata } from '../TeamProvisioningRuntimeMetadataPolicy';
import type { MemberSpawnStatusEntry } from '@shared/types';

const NOW = '2026-01-01T00:10:00.000Z';
const NOW_MS = Date.parse(NOW);
const ACCEPTED_AT = '2026-01-01T00:00:00.000Z';
const RECENT_ACCEPTED_AT = new Date(NOW_MS - MEMBER_BOOTSTRAP_STALL_MS + 10_000).toISOString();

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

function makePorts(
  input: {
    runtime?: ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>;
    isOpenCodeSecondary?: boolean;
  } = {}
): ReevaluateMemberLaunchStatusPorts<ReevaluateMemberLaunchStatusRunLike> & {
  openCodeSetPending: ReturnType<typeof vi.fn>;
  openCodeSetStalled: ReturnType<typeof vi.fn>;
  openCodeRetryPrompt: ReturnType<typeof vi.fn>;
  openCodeScheduleReevaluation: ReturnType<typeof vi.fn>;
} {
  const openCodeSetPending = vi.fn();
  const openCodeSetStalled = vi.fn();
  const openCodeRetryPrompt = vi.fn(async () => undefined);
  const openCodeScheduleReevaluation = vi.fn();

  return {
    nowIso: vi.fn(() => NOW),
    nowMs: vi.fn(() => NOW_MS),
    isCurrentTrackedRun: vi.fn(() => true),
    refreshMemberSpawnStatusesFromLeadInbox: vi.fn(async () => undefined),
    maybeAuditMemberSpawnStatuses: vi.fn(async () => undefined),
    getLiveTeamAgentRuntimeMetadata: vi.fn(async () => input.runtime ?? new Map()),
    isOpenCodeSecondaryLaneMemberInRun: vi.fn(() => input.isOpenCodeSecondary ?? false),
    reconcileOpenCodeBootstrapStallPorts: {
      buildOpenCodeSecondaryBootstrapStallDiagnostic: vi.fn(async () => 'transcript stall'),
      setOpenCodeRuntimePendingBootstrapStatus: openCodeSetPending,
      maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt: openCodeRetryPrompt,
      scheduleOpenCodeBootstrapStallReevaluation: openCodeScheduleReevaluation,
      setOpenCodeSecondaryBootstrapStalledStatus: openCodeSetStalled,
    },
    setMemberSpawnStatus: vi.fn(),
    emitMemberSpawnChange: vi.fn(),
    scheduleOpenCodeBootstrapStallReevaluation: vi.fn(),
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    openCodeSetPending,
    openCodeSetStalled,
    openCodeRetryPrompt,
    openCodeScheduleReevaluation,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('reevaluateMemberLaunchStatus', () => {
  it('does nothing when the member has no launch status', async () => {
    const targetRun = run([]);
    const ports = makePorts();

    await reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);

    expect(ports.refreshMemberSpawnStatusesFromLeadInbox).not.toHaveBeenCalled();
    expect(ports.getLiveTeamAgentRuntimeMetadata).not.toHaveBeenCalled();
  });

  it('stops after lead inbox or audit confirms the launch', async () => {
    const targetRun = run();
    const ports = makePorts();
    vi.mocked(ports.refreshMemberSpawnStatusesFromLeadInbox).mockImplementation(async () => {
      targetRun.memberSpawnStatuses.set(
        'Worker',
        status({ launchState: 'confirmed_alive', status: 'online' })
      );
    });

    await reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);

    expect(ports.maybeAuditMemberSpawnStatuses).toHaveBeenCalledWith(targetRun, { force: true });
    expect(ports.getLiveTeamAgentRuntimeMetadata).not.toHaveBeenCalled();
    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });

  it('marks a primary member online when runtime process metadata matches exactly', async () => {
    const targetRun = run();
    const ports = makePorts({
      runtime: new Map([['Worker', { alive: true, livenessKind: 'runtime_process' }]]),
    });

    await reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);

    expect(ports.setMemberSpawnStatus).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      'online',
      undefined,
      'process'
    );
    expect(ports.openCodeSetPending).not.toHaveBeenCalled();
  });

  it('uses observed member identity aliases when resolving runtime metadata', async () => {
    const targetRun = run();
    const ports = makePorts({
      runtime: new Map([['Worker-2', { alive: true, livenessKind: 'runtime_process' }]]),
    });

    await reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);

    expect(ports.setMemberSpawnStatus).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      'online',
      undefined,
      'process'
    );
  });

  it('routes secondary OpenCode runtime processes through bootstrap reconciliation', async () => {
    const targetRun = run([['Worker', status({ firstSpawnAcceptedAt: RECENT_ACCEPTED_AT })]]);
    const ports = makePorts({
      isOpenCodeSecondary: true,
      runtime: new Map([
        [
          'Worker',
          {
            alive: true,
            livenessKind: 'runtime_process',
            runtimeDiagnostic: 'runtime is up',
            runtimeDiagnosticSeverity: 'info',
            runtimeSessionId: 'session-1',
          },
        ],
      ]),
    });

    await reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);

    expect(ports.openCodeSetPending).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      targetRun.memberSpawnStatuses.get('Worker'),
      {
        bootstrapStalled: false,
        runtimeDiagnostic: 'runtime is up',
        runtimeDiagnosticSeverity: 'info',
      }
    );
    expect(ports.openCodeScheduleReevaluation).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      RECENT_ACCEPTED_AT
    );
    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });

  it('records pending permission state and emits a member change', async () => {
    const targetRun = run();
    const ports = makePorts({
      runtime: new Map([
        [
          'Worker',
          {
            alive: true,
            livenessKind: 'permission_blocked',
            runtimeDiagnosticSeverity: 'error',
          },
        ],
      ]),
    });

    await reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);

    expect(targetRun.memberSpawnStatuses.get('Worker')).toMatchObject({
      launchState: 'runtime_pending_permission',
      livenessKind: 'permission_blocked',
      runtimeDiagnostic: 'waiting for permission approval',
      runtimeDiagnosticSeverity: 'error',
      livenessLastCheckedAt: NOW,
    });
    expect(ports.emitMemberSpawnChange).toHaveBeenCalledWith(targetRun, 'Worker');
  });

  it('records a recoverable runtime candidate before the bootstrap stall window', async () => {
    const targetRun = run([['Worker', status({ firstSpawnAcceptedAt: RECENT_ACCEPTED_AT })]]);
    const ports = makePorts({
      runtime: new Map([['Worker', { alive: true, livenessKind: 'runtime_process_candidate' }]]),
    });

    await reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);

    expect(targetRun.memberSpawnStatuses.get('Worker')).toMatchObject({
      livenessKind: 'runtime_process_candidate',
      runtimeDiagnostic: 'Runtime process candidate detected, but bootstrap is unconfirmed.',
      runtimeDiagnosticSeverity: 'warning',
      livenessLastCheckedAt: NOW,
    });
    expect(ports.scheduleOpenCodeBootstrapStallReevaluation).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      RECENT_ACCEPTED_AT
    );
  });

  it('marks secondary OpenCode pending bootstrap statuses as stalled after the window', async () => {
    const targetRun = run([
      [
        'Worker',
        status({
          launchState: 'runtime_pending_bootstrap',
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      ],
    ]);
    const ports = makePorts({ isOpenCodeSecondary: true });

    await reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);

    expect(ports.openCodeSetStalled).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      targetRun.memberSpawnStatuses.get('Worker'),
      'transcript stall'
    );
    expect(ports.openCodeRetryPrompt).toHaveBeenCalledWith({
      run: targetRun,
      memberName: 'Worker',
      current: targetRun.memberSpawnStatuses.get('Worker'),
      runtimeDiagnostic: 'transcript stall',
      runtimeSessionId: undefined,
    });
    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });

  it('marks runtime lost when the team directory yields no runtime metadata after grace', async () => {
    const targetRun = run();
    const ports = makePorts();

    await reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);

    expect(ports.syncMemberTaskActivityForRuntimeTransition).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      expect.objectContaining({ launchState: 'starting' }),
      expect.objectContaining({
        runtimeAlive: false,
        bootstrapConfirmed: false,
        livenessLastCheckedAt: NOW,
      }),
      NOW
    );
    expect(ports.setMemberSpawnStatus).toHaveBeenCalledWith(
      targetRun,
      'Worker',
      'error',
      'Teammate did not join within the launch grace window.'
    );
  });

  it('does not continue when the run is replaced during the lead inbox refresh', async () => {
    const targetRun = run();
    const refresh = deferred<void>();
    let current = true;
    const ports = makePorts();
    vi.mocked(ports.isCurrentTrackedRun).mockImplementation(() => current);
    vi.mocked(ports.refreshMemberSpawnStatusesFromLeadInbox).mockReturnValue(refresh.promise);

    const reevaluation = reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);
    current = false;
    refresh.resolve();
    await reevaluation;

    expect(ports.maybeAuditMemberSpawnStatuses).not.toHaveBeenCalled();
    expect(ports.getLiveTeamAgentRuntimeMetadata).not.toHaveBeenCalled();
    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });

  it('does not continue when the member is relaunched during the audit', async () => {
    const targetRun = run();
    const audit = deferred<void>();
    const ports = makePorts();
    vi.mocked(ports.maybeAuditMemberSpawnStatuses).mockReturnValue(audit.promise);

    const reevaluation = reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);
    targetRun.memberSpawnStatuses.set(
      'Worker',
      status({ firstSpawnAcceptedAt: '2026-01-01T00:05:00.000Z' })
    );
    audit.resolve();
    await reevaluation;

    expect(ports.getLiveTeamAgentRuntimeMetadata).not.toHaveBeenCalled();
    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });

  it('does not mutate a newer status while runtime metadata is pending', async () => {
    const targetRun = run();
    const metadata = deferred<ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>>();
    const ports = makePorts();
    vi.mocked(ports.getLiveTeamAgentRuntimeMetadata).mockReturnValue(metadata.promise);

    const reevaluation = reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);
    const newer = status({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
    });
    targetRun.memberSpawnStatuses.set('Worker', newer);
    metadata.resolve(new Map([['Worker', { alive: false, livenessKind: 'shell_only' }]]));
    await reevaluation;

    expect(targetRun.memberSpawnStatuses.get('Worker')).toBe(newer);
    expect(ports.syncMemberTaskActivityForRuntimeTransition).not.toHaveBeenCalled();
    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });

  it('does not apply a stale OpenCode diagnostic after a member relaunch', async () => {
    const targetRun = run();
    const diagnostic = deferred<string>();
    const ports = makePorts({
      isOpenCodeSecondary: true,
      runtime: new Map([['Worker', { alive: true, livenessKind: 'runtime_process' }]]),
    });
    vi.mocked(
      ports.reconcileOpenCodeBootstrapStallPorts.buildOpenCodeSecondaryBootstrapStallDiagnostic
    ).mockReturnValue(diagnostic.promise);

    const reevaluation = reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);
    const newer = status({ firstSpawnAcceptedAt: '2026-01-01T00:05:00.000Z' });
    targetRun.memberSpawnStatuses.set('Worker', newer);
    diagnostic.resolve('stale diagnostic');
    await reevaluation;

    expect(targetRun.memberSpawnStatuses.get('Worker')).toBe(newer);
    expect(ports.openCodeSetPending).not.toHaveBeenCalled();
    expect(ports.openCodeRetryPrompt).not.toHaveBeenCalled();
    expect(ports.openCodeScheduleReevaluation).not.toHaveBeenCalled();
  });

  it('does not mutate status after task activity synchronization makes the run stale', async () => {
    const targetRun = run();
    let current = true;
    const ports = makePorts();
    vi.mocked(ports.isCurrentTrackedRun).mockImplementation(() => current);
    vi.mocked(ports.syncMemberTaskActivityForRuntimeTransition).mockImplementation(() => {
      current = false;
    });
    const original = targetRun.memberSpawnStatuses.get('Worker');

    await reevaluateMemberLaunchStatus(targetRun, 'Worker', ports);

    expect(ports.syncMemberTaskActivityForRuntimeTransition).toHaveBeenCalledOnce();
    expect(targetRun.memberSpawnStatuses.get('Worker')).toBe(original);
    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });
});

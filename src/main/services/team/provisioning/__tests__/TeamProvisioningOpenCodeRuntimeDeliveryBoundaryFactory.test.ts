import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundary,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts,
} from '../TeamProvisioningOpenCodeRuntimeDelivery';
import {
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromHost,
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromPorts,
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHostFactoryService,
} from '../TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactory';

import type { OpenCodeRuntimeCheckinRun } from '../TeamProvisioningOpenCodeRuntimeCheckin';

const createBoundaryMock = vi.mocked(createTeamProvisioningOpenCodeRuntimeDeliveryBoundary);
const testProjectPath = '/safe-test/project';
const testTeamsBasePath = '/safe-test/teams';

vi.mock('../TeamProvisioningOpenCodeRuntimeDelivery', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../TeamProvisioningOpenCodeRuntimeDelivery')>();
  return {
    ...actual,
    createTeamProvisioningOpenCodeRuntimeDeliveryBoundary: vi.fn(),
  };
});

describe('TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactory', () => {
  beforeEach(() => {
    createBoundaryMock.mockReset();
  });

  it('returns the underlying delivery boundary so service forwarders keep the same operations', async () => {
    const fakeBoundary = createFakeBoundary();
    createBoundaryMock.mockReturnValue(fakeBoundary);

    const boundary = createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromPorts(createPorts());
    const raw = { teamName: 'Team', runId: 'run-1' };

    await boundary.recordOpenCodeRuntimeBootstrapCheckin(raw);
    await boundary.deliverOpenCodeRuntimeMessage(raw);
    await boundary.recordOpenCodeRuntimeTaskEvent(raw);
    await boundary.recordOpenCodeRuntimeHeartbeat(raw);
    boundary.createOpenCodePromptDeliveryLedger('Team', 'lane-1');
    await boundary.getOpenCodeRuntimeDeliveryStatus('Team', 'message-1');
    await boundary.tryGetActiveOpenCodePromptDeliveryRecord({
      teamName: 'Team',
      memberName: 'Builder',
    });
    await boundary.getOpenCodeMemberDeliveryBusyStatus({
      teamName: 'Team',
      memberName: 'Builder',
      nowIso: '2026-01-01T00:00:00.000Z',
    });
    boundary.scheduleOpenCodeMemberInboxDeliveryWake({
      teamName: 'Team',
      memberName: 'Builder',
      messageId: 'message-1',
    });
    await boundary.recoverOpenCodeRuntimeDeliveryJournal('Team');

    expect(boundary).toBe(fakeBoundary);
    expect(fakeBoundary.recordOpenCodeRuntimeBootstrapCheckin).toHaveBeenCalledWith(raw);
    expect(fakeBoundary.deliverOpenCodeRuntimeMessage).toHaveBeenCalledWith(raw);
    expect(fakeBoundary.recordOpenCodeRuntimeTaskEvent).toHaveBeenCalledWith(raw);
    expect(fakeBoundary.recordOpenCodeRuntimeHeartbeat).toHaveBeenCalledWith(raw);
    expect(fakeBoundary.createOpenCodePromptDeliveryLedger).toHaveBeenCalledWith('Team', 'lane-1');
    expect(fakeBoundary.getOpenCodeRuntimeDeliveryStatus).toHaveBeenCalledWith('Team', 'message-1');
    expect(fakeBoundary.tryGetActiveOpenCodePromptDeliveryRecord).toHaveBeenCalledWith({
      teamName: 'Team',
      memberName: 'Builder',
    });
    expect(fakeBoundary.getOpenCodeMemberDeliveryBusyStatus).toHaveBeenCalledWith({
      teamName: 'Team',
      memberName: 'Builder',
      nowIso: '2026-01-01T00:00:00.000Z',
    });
    expect(fakeBoundary.scheduleOpenCodeMemberInboxDeliveryWake).toHaveBeenCalledWith({
      teamName: 'Team',
      memberName: 'Builder',
      messageId: 'message-1',
    });
    expect(fakeBoundary.recoverOpenCodeRuntimeDeliveryJournal).toHaveBeenCalledWith('Team');
  });

  it('passes TeamProvisioning ports through with the same delivery semantics', async () => {
    const fakeBoundary = createFakeBoundary();
    createBoundaryMock.mockReturnValue(fakeBoundary);
    const run = createRun();
    const ports = createPorts({
      getTrackedRunId: vi.fn(() => 'run-1'),
      getRun: vi.fn(() => run),
      readLaunchState: vi
        .fn()
        .mockResolvedValueOnce({ teamName: 'Team' })
        .mockRejectedValueOnce(new Error('read failed')),
    });

    createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromPorts(ports);

    expect(createBoundaryMock).toHaveBeenCalledTimes(1);
    const boundaryPorts = createBoundaryMock.mock.calls[0]?.[0] as
      | TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts<OpenCodeRuntimeCheckinRun>
      | undefined;
    expect(boundaryPorts).toBeDefined();
    if (!boundaryPorts) {
      return;
    }

    await expect(
      boundaryPorts.resolveOpenCodeRuntimeLaneId({
        teamName: 'Team',
        runId: 'run-1',
        memberName: 'Builder',
      })
    ).resolves.toBe('lane-1');
    await expect(boundaryPorts.resolveCurrentOpenCodeRuntimeRunId('Team', 'lane-1')).resolves.toBe(
      'run-1'
    );
    await expect(boundaryPorts.readLaunchState('Team')).resolves.toEqual({ teamName: 'Team' });
    await expect(boundaryPorts.readLaunchStateForDeliveryRecovery('Team')).resolves.toBeNull();
    expect(boundaryPorts.getTrackedRun('Team')).toBe(run);
    expect(boundaryPorts.getTeamsBasePath()).toBe(testTeamsBasePath);

    await boundaryPorts.writeLaunchState('Team', { teamName: 'Team' } as never);
    await boundaryPorts.persistTrackedRunLaunchState(run);

    expect(ports.writeLaunchStateSnapshot).toHaveBeenCalledWith('Team', { teamName: 'Team' });
    expect(ports.getMixedSecondaryLaunchPhase).toHaveBeenCalledWith(run);
    expect(ports.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'active');
    expect(boundaryPorts.sentMessagesStore).toBe(ports.sentMessagesStore);
    expect(boundaryPorts.inboxReader).toBe(ports.inboxReader);
    expect(boundaryPorts.inboxWriter).toBe(ports.inboxWriter);
    expect(boundaryPorts.getCrossTeamSender()).toBe('cross-team-sender');
    expect(boundaryPorts.logger).toBe(ports.logger);
  });

  it('builds the delivery boundary from a TeamProvisioning host without importing the service', async () => {
    const fakeBoundary = createFakeBoundary();
    createBoundaryMock.mockReturnValue(fakeBoundary);
    const run = createRun();
    const teamChangeEmitter = vi.fn();
    const host = createHost({
      run,
      teamChangeEmitter,
      readLaunchState: vi.fn(async () => ({ teamName: 'Team' }) as never),
    });
    const deps = createDeps();

    const boundary = createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromHost(host, deps);

    expect(boundary).toBe(fakeBoundary);
    expect(createBoundaryMock).toHaveBeenCalledTimes(1);
    const boundaryPorts = createBoundaryMock.mock.calls[0]?.[0] as
      | TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts<OpenCodeRuntimeCheckinRun>
      | undefined;
    expect(boundaryPorts).toBeDefined();
    if (!boundaryPorts) {
      return;
    }

    await expect(
      boundaryPorts.resolveOpenCodeRuntimeLaneId({
        teamName: 'Team',
        runId: 'run-1',
        memberName: 'Builder',
      })
    ).resolves.toBe('lane-1');
    await expect(boundaryPorts.resolveCurrentOpenCodeRuntimeRunId('Team', 'lane-1')).resolves.toBe(
      'run-1'
    );
    await expect(boundaryPorts.readLaunchState('Team')).resolves.toEqual({ teamName: 'Team' });
    expect(boundaryPorts.getTrackedRun('Team')).toBe(run);
    expect(boundaryPorts.getTeamsBasePath()).toBe(testTeamsBasePath);

    await boundaryPorts.writeLaunchState('Team', { teamName: 'Team' } as never);
    boundaryPorts.emitTeamChange({ type: 'member-spawn', teamName: 'Team', detail: 'Builder' });
    await boundaryPorts.upsertOpenCodeTaskRecord('Team', { taskId: 'task-1' } as never);

    expect(host.writeLaunchStateSnapshot).toHaveBeenCalledWith('Team', { teamName: 'Team' });
    expect(teamChangeEmitter).toHaveBeenCalledWith({
      type: 'member-spawn',
      teamName: 'Team',
      detail: 'Builder',
    });
    expect(host.openCodeTaskLogAttributionStore.upsertTaskRecord).toHaveBeenCalledWith('Team', {
      taskId: 'task-1',
    });
    expect(boundaryPorts.getCrossTeamSender()).toBe('cross-team-sender');
    expect(boundaryPorts.nowIso()).toBe('2026-01-01T00:00:00.000Z');
    expect(boundaryPorts.logger).toBe(deps.logger);
  });

  it('builds the TeamProvisioning host from service-shaped ports with live emitter lookup', async () => {
    const fakeBoundary = createFakeBoundary();
    createBoundaryMock.mockReturnValue(fakeBoundary);
    const run = createRun();
    const service = createService({
      run,
      readLaunchState: vi.fn(async () => ({ teamName: 'Team' }) as never),
    });
    const deps = createDeps();

    createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromHost(
      createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost(service),
      deps
    );

    const boundaryPorts = createBoundaryMock.mock.calls[0]?.[0] as
      | TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts<OpenCodeRuntimeCheckinRun>
      | undefined;
    expect(boundaryPorts).toBeDefined();
    if (!boundaryPorts) {
      return;
    }

    const event = { type: 'member-spawn', teamName: 'Team', detail: 'Builder' } as const;
    boundaryPorts.emitTeamChange(event);
    const teamChangeEmitter = vi.fn();
    service.teamChangeEmitter = teamChangeEmitter;
    boundaryPorts.emitTeamChange(event);

    await expect(boundaryPorts.resolveCurrentOpenCodeRuntimeRunId('Team', 'lane-1')).resolves.toBe(
      'run-1'
    );
    expect(boundaryPorts.getTrackedRun('Team')).toBe(run);
    expect(boundaryPorts.getCrossTeamSender()).toBe('cross-team-sender');
    expect(teamChangeEmitter).toHaveBeenCalledTimes(1);
    expect(teamChangeEmitter).toHaveBeenCalledWith(event);
  });
});

function createFakeBoundary() {
  return {
    createOpenCodeRuntimeCheckinPorts: vi.fn(),
    recordOpenCodeRuntimeBootstrapCheckin: vi.fn(async () => ({
      ok: true,
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      state: 'accepted',
      idempotencyKey: 'key',
      diagnostics: [],
      observedAt: '2026-01-01T00:00:00.000Z',
    })),
    deliverOpenCodeRuntimeMessage: vi.fn(async () => ({
      ok: true,
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      state: 'delivered',
      idempotencyKey: 'key',
      diagnostics: [],
      observedAt: '2026-01-01T00:00:00.000Z',
    })),
    recordOpenCodeRuntimeTaskEvent: vi.fn(async () => ({
      ok: true,
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      state: 'accepted',
      idempotencyKey: 'key',
      diagnostics: [],
      observedAt: '2026-01-01T00:00:00.000Z',
    })),
    recordOpenCodeRuntimeHeartbeat: vi.fn(async () => ({
      ok: true,
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      state: 'accepted',
      idempotencyKey: 'key',
      diagnostics: [],
      observedAt: '2026-01-01T00:00:00.000Z',
    })),
    createOpenCodeRuntimeDeliveryService: vi.fn(),
    createOpenCodePromptDeliveryLedger: vi.fn(() => ({})),
    getOpenCodeRuntimeDeliveryStatus: vi.fn(async () => null),
    tryGetActiveOpenCodePromptDeliveryRecord: vi.fn(async () => null),
    getOpenCodeMemberDeliveryBusyStatus: vi.fn(async () => ({ busy: false })),
    scheduleOpenCodeMemberInboxDeliveryWake: vi.fn(),
    createOpenCodeRuntimeDeliveryPorts: vi.fn(() => []),
    recoverOpenCodeRuntimeDeliveryJournal: vi.fn(async () => ({ recovered: true })),
  } as unknown as ReturnType<typeof createTeamProvisioningOpenCodeRuntimeDeliveryBoundary>;
}

function createPorts(
  overrides: Partial<
    TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<OpenCodeRuntimeCheckinRun>
  > = {}
): TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<OpenCodeRuntimeCheckinRun> {
  return {
    getTeamsBasePath: vi.fn(() => testTeamsBasePath),
    resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'lane-1'),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-1'),
    readLaunchState: vi.fn(async () => null),
    writeLaunchStateSnapshot: vi.fn(async () => undefined),
    readConfigForStrictDecision: vi.fn(async () => null),
    readMetaMembers: vi.fn(async () => []),
    readPersistedRuntimeMembers: vi.fn(() => []),
    getTrackedRunId: vi.fn(() => null),
    getRun: vi.fn(() => null),
    persistLaunchStateSnapshot: vi.fn(async () => undefined),
    getMixedSecondaryLaunchPhase: vi.fn(() => 'active' as const),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    emitMemberSpawnChange: vi.fn(),
    emitTeamChange: vi.fn(),
    createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(() => {
      throw new Error('unused');
    }),
    upsertOpenCodeTaskRecord: vi.fn(async () => ({ created: true }) as never),
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    syncMemberLaunchGraceCheck: vi.fn(),
    sentMessagesStore: {
      appendMessage: vi.fn(),
      readMessages: vi.fn(),
    },
    inboxReader: {
      getMessagesFor: vi.fn(),
    },
    inboxWriter: {
      sendMessage: vi.fn(),
    },
    getCrossTeamSender: vi.fn(() => 'cross-team-sender' as never),
    isOpenCodeRuntimeRecipient: vi.fn(async () => true),
    getOpenCodeAgendaSyncRecoveryBypassMessageIds: vi.fn(async () => new Set<string>()),
    resolveOpenCodeMemberDeliveryIdentity: vi.fn(async () => ({
      ok: true as const,
      canonicalMemberName: 'Builder',
      laneId: 'lane-1',
    })),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: vi.fn(async () => true),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: vi.fn(async () => true),
    decideOpenCodeRuntimeDeliveryUserFacingAdvisory: vi.fn(async (record) => ({
      record,
      decision: { action: 'defer' as const },
    })),
    isOpenCodePromptDeliveryWatchdogEnabled: vi.fn(() => true),
    scheduleOpenCodePromptDeliveryWatchdog: vi.fn(),
    nowIso: vi.fn(() => '2026-01-01T00:00:00.000Z'),
    logger: {
      warn: vi.fn(),
    },
    ...overrides,
  };
}

function createDeps() {
  return {
    getTeamsBasePath: vi.fn(() => testTeamsBasePath),
    nowIso: vi.fn(() => '2026-01-01T00:00:00.000Z'),
    logger: {
      warn: vi.fn(),
    },
  };
}

function createHost(options: {
  run: OpenCodeRuntimeCheckinRun;
  teamChangeEmitter: ReturnType<typeof vi.fn>;
  readLaunchState: ReturnType<typeof vi.fn>;
}): TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<OpenCodeRuntimeCheckinRun> {
  return {
    resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'lane-1'),
    openCodeRuntimeRecoveryIdentity: {
      resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-1'),
      resolveOpenCodeMemberDeliveryIdentity: vi.fn(async () => ({
        ok: true as const,
        canonicalMemberName: 'Builder',
        laneId: 'lane-1',
      })),
    },
    launchStateStore: {
      read: options.readLaunchState,
    },
    writeLaunchStateSnapshot: vi.fn(async () => undefined),
    readConfigForStrictDecision: vi.fn(async () => null),
    membersMetaStore: {
      getMembers: vi.fn(async () => []),
    },
    readPersistedRuntimeMembers: vi.fn(() => []),
    runTracking: {
      getTrackedRunId: vi.fn(() => 'run-1'),
    },
    runs: {
      get: vi.fn(() => options.run),
    },
    persistLaunchStateSnapshot: vi.fn(async () => undefined),
    getMixedSecondaryLaunchPhase: vi.fn(() => 'active' as const),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    emitMemberSpawnChange: vi.fn(),
    teamChangeEmitter: options.teamChangeEmitter,
    createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(() => {
      throw new Error('unused');
    }),
    openCodeTaskLogAttributionStore: {
      upsertTaskRecord: vi.fn(async () => ({ created: true }) as never),
    },
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    syncMemberLaunchGraceCheck: vi.fn(),
    sentMessagesStore: {
      appendMessage: vi.fn(),
      readMessages: vi.fn(),
    },
    inboxReader: {
      getMessagesFor: vi.fn(),
    },
    inboxWriter: {
      sendMessage: vi.fn(),
    },
    getCrossTeamSender: vi.fn(() => 'cross-team-sender' as never),
    isOpenCodeRuntimeRecipient: vi.fn(async () => true),
    getOpenCodeAgendaSyncRecoveryBypassMessageIds: vi.fn(async () => new Set<string>()),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: vi.fn(async () => true),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: vi.fn(async () => true),
    decideOpenCodeRuntimeDeliveryUserFacingAdvisory: vi.fn(async (record) => ({
      record,
      decision: { action: 'defer' as const },
    })),
    openCodePromptDeliveryWatchdogScheduler: {
      isEnabled: vi.fn(() => true),
    },
    scheduleOpenCodePromptDeliveryWatchdog: vi.fn(),
  };
}

function createService(options: {
  run: OpenCodeRuntimeCheckinRun;
  readLaunchState: ReturnType<typeof vi.fn>;
}): TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHostFactoryService<OpenCodeRuntimeCheckinRun> {
  const host = createHost({
    run: options.run,
    teamChangeEmitter: vi.fn(),
    readLaunchState: options.readLaunchState,
  });
  return {
    resolveOpenCodeRuntimeLaneId: host.resolveOpenCodeRuntimeLaneId,
    openCodeRuntimeRecoveryIdentity: host.openCodeRuntimeRecoveryIdentity,
    launchStateStore: host.launchStateStore,
    writeLaunchStateSnapshot: host.writeLaunchStateSnapshot,
    readConfigForStrictDecision: host.readConfigForStrictDecision,
    membersMetaStore: host.membersMetaStore,
    readPersistedRuntimeMembers: host.readPersistedRuntimeMembers,
    runTracking: host.runTracking,
    runs: host.runs,
    persistLaunchStateSnapshot: host.persistLaunchStateSnapshot,
    getMixedSecondaryLaunchPhase: host.getMixedSecondaryLaunchPhase,
    invalidateRuntimeSnapshotCaches: host.invalidateRuntimeSnapshotCaches,
    emitMemberSpawnChange: host.emitMemberSpawnChange,
    teamChangeEmitter: null,
    createOpenCodeRuntimeBootstrapEvidencePorts: host.createOpenCodeRuntimeBootstrapEvidencePorts,
    openCodeTaskLogAttributionStore: host.openCodeTaskLogAttributionStore,
    syncMemberTaskActivityForRuntimeTransition: host.syncMemberTaskActivityForRuntimeTransition,
    syncMemberLaunchGraceCheck: host.syncMemberLaunchGraceCheck,
    sentMessagesStore: host.sentMessagesStore,
    inboxReader: host.inboxReader,
    inboxWriter: host.inboxWriter,
    getCrossTeamSender: vi.fn(() => 'cross-team-sender' as never),
    isOpenCodeRuntimeRecipient: host.isOpenCodeRuntimeRecipient,
    getOpenCodeAgendaSyncRecoveryBypassMessageIds:
      host.getOpenCodeAgendaSyncRecoveryBypassMessageIds,
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery:
      host.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery,
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive:
      host.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive,
    decideOpenCodeRuntimeDeliveryUserFacingAdvisory:
      host.decideOpenCodeRuntimeDeliveryUserFacingAdvisory,
    openCodePromptDeliveryWatchdogScheduler: host.openCodePromptDeliveryWatchdogScheduler,
    scheduleOpenCodePromptDeliveryWatchdog: host.scheduleOpenCodePromptDeliveryWatchdog,
  };
}

function createRun(): OpenCodeRuntimeCheckinRun {
  return {
    runId: 'run-1',
    teamName: 'Team',
    request: {
      teamName: 'Team',
      cwd: testProjectPath,
      members: [],
    },
    effectiveMembers: [],
    processKilled: false,
    cancelRequested: false,
    mixedSecondaryLanes: [],
    memberSpawnStatuses: new Map(),
  } as OpenCodeRuntimeCheckinRun;
}

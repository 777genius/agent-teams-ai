import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundary,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts,
} from '../TeamProvisioningOpenCodeRuntimeDelivery';
import {
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromPorts,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts,
} from '../TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactory';

import type { OpenCodeRuntimeCheckinRun } from '../TeamProvisioningOpenCodeRuntimeCheckin';

const createBoundaryMock = vi.mocked(createTeamProvisioningOpenCodeRuntimeDeliveryBoundary);

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
    expect(boundaryPorts.getTeamsBasePath()).toBe('/tmp/teams');

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
      observedAt: '2026-01-01T00:00:00.000Z',
    })),
    deliverOpenCodeRuntimeMessage: vi.fn(async () => ({
      ok: true,
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      state: 'delivered',
      idempotencyKey: 'key',
      observedAt: '2026-01-01T00:00:00.000Z',
    })),
    recordOpenCodeRuntimeTaskEvent: vi.fn(async () => ({
      ok: true,
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      state: 'accepted',
      idempotencyKey: 'key',
      observedAt: '2026-01-01T00:00:00.000Z',
    })),
    recordOpenCodeRuntimeHeartbeat: vi.fn(async () => ({
      ok: true,
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      state: 'accepted',
      idempotencyKey: 'key',
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
  } as ReturnType<typeof createTeamProvisioningOpenCodeRuntimeDeliveryBoundary>;
}

function createPorts(
  overrides: Partial<
    TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<OpenCodeRuntimeCheckinRun>
  > = {}
): TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactoryPorts<OpenCodeRuntimeCheckinRun> {
  return {
    getTeamsBasePath: vi.fn(() => '/tmp/teams'),
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
    getMixedSecondaryLaunchPhase: vi.fn(() => 'active'),
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
    getOpenCodeAgendaSyncRecoveryBypassMessageIds: vi.fn(async () => new Set()),
    resolveOpenCodeMemberDeliveryIdentity: vi.fn(async () => ({
      ok: true,
      canonicalMemberName: 'Builder',
      laneId: 'lane-1',
    })),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: vi.fn(async () => true),
    decideOpenCodeRuntimeDeliveryUserFacingAdvisory: vi.fn(async (record) => ({
      record,
      decision: { action: 'defer' },
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

function createRun(): OpenCodeRuntimeCheckinRun {
  return {
    runId: 'run-1',
    teamName: 'Team',
    request: {
      name: 'Team',
      projectPath: '/tmp/project',
      members: [],
    },
    effectiveMembers: [],
    processKilled: false,
    cancelRequested: false,
    mixedSecondaryLanes: [],
    memberSpawnStatuses: new Map(),
  } as OpenCodeRuntimeCheckinRun;
}

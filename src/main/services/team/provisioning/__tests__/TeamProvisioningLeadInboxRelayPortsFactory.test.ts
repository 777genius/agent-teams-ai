import { describe, expect, it, vi } from 'vitest';

import { InboxRelayInFlightTimeoutError } from '../TeamProvisioningInboxRelayCandidates';
import {
  createTeamProvisioningLeadInboxRelayPortsBoundary,
  type TeamProvisioningLeadInboxRelayPortsFactoryDeps,
} from '../TeamProvisioningLeadInboxRelayPortsFactory';

import type {
  LeadInboxRelayFlowPorts,
  LeadInboxRelayFlowRun,
} from '../TeamProvisioningLeadInboxRelayFlow';
import type { InboxMessage, TeamChangeEvent } from '@shared/types';

function createRun(overrides: Partial<LeadInboxRelayFlowRun> = {}): LeadInboxRelayFlowRun {
  return {
    runId: 'run-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    child: {},
    processKilled: false,
    cancelRequested: false,
    provisioningComplete: true,
    leadRelayCapture: null,
    activeCrossTeamReplyHints: [],
    ...overrides,
  };
}

function createDeps(
  overrides: Partial<TeamProvisioningLeadInboxRelayPortsFactoryDeps<LeadInboxRelayFlowRun>> = {}
): TeamProvisioningLeadInboxRelayPortsFactoryDeps<LeadInboxRelayFlowRun> {
  const run = createRun();
  return {
    leadInboxRelayInFlight: new Map(),
    getAliveRunId: vi.fn().mockReturnValue(run.runId),
    getProvisioningRunId: vi.fn().mockReturnValue(null),
    getRun: vi.fn().mockReturnValue(run),
    isCurrentTrackedRun: vi.fn().mockReturnValue(true),
    readConfigForObservation: vi.fn().mockResolvedValue({ members: [] }),
    readLeadInboxMessages: vi.fn().mockResolvedValue([]),
    markInboxMessagesRead: vi.fn().mockResolvedValue(undefined),
    handleTeammatePermissionRequest: vi.fn(),
    refreshMemberSpawnStatusesFromLeadInbox: vi.fn().mockResolvedValue(undefined),
    confirmSameTeamNativeMatches: vi
      .fn()
      .mockResolvedValue({ nativeMatchedMessageIds: new Set<string>(), persisted: true }),
    scheduleSameTeamPersistRetry: vi.fn(),
    scheduleSameTeamDeferredRetry: vi.fn(),
    resolveControlApiBaseUrl: vi.fn().mockResolvedValue('http://127.0.0.1:3000'),
    sendMessageToRun: vi.fn().mockResolvedValue(undefined),
    hasAcceptedLeadWorkSyncReport: vi.fn().mockResolvedValue(true),
    scheduleLeadProofMissingWorkSyncRecovery: vi.fn().mockResolvedValue(false),
    pushLiveLeadTextMessage: vi.fn(),
    pushLiveLeadProcessMessage: vi.fn(),
    persistSentMessage: vi.fn(),
    emitTeamChange: vi.fn(),
    scheduleLeadInboxFollowUpRelay: vi.fn(),
    relayedLeadInboxMessageIds: new Map(),
    trimRelayedSet: vi.fn((relayedIds) => relayedIds),
    pendingCrossTeamFirstReplies: new Map(),
    recentCrossTeamLeadDeliveryMessageIds: new Map(),
    sameTeamRunStartSkewMs: 1_000,
    sameTeamNativeDeliveryGraceMs: 15_000,
    recentCrossTeamDeliveryTtlMs: 600_000,
    logger: { debug: vi.fn(), warn: vi.fn() },
    getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    nowIso: vi.fn().mockReturnValue('2026-01-01T00:01:00.000Z'),
    nowMs: vi.fn().mockReturnValue(123),
    setTimeout: vi.fn().mockReturnValue({} as NodeJS.Timeout),
    clearTimeout: vi.fn(),
    ...overrides,
  };
}

describe('TeamProvisioningLeadInboxRelayPortsFactory', () => {
  it('wires relay flow ports through provisioning service dependencies', async () => {
    let capturedPorts: LeadInboxRelayFlowPorts<LeadInboxRelayFlowRun> | null = null;
    const relayedLeadInboxMessageIds = new Map<string, Set<string>>();
    const pendingCrossTeamFirstReplies = new Map<string, Map<string, number>>();
    const recentCrossTeamLeadDeliveryMessageIds = new Map<string, Map<string, number>>();
    const deps = createDeps({
      relayedLeadInboxMessageIds,
      pendingCrossTeamFirstReplies,
      recentCrossTeamLeadDeliveryMessageIds,
      relayLeadInboxMessagesForTeam: vi.fn(async (_teamName, ports) => {
        capturedPorts = ports;
        return 2;
      }),
    });

    const boundary = createTeamProvisioningLeadInboxRelayPortsBoundary(deps);

    await expect(boundary.relayLeadInboxMessages('alpha')).resolves.toBe(2);
    expect(deps.relayLeadInboxMessagesForTeam).toHaveBeenCalledWith('alpha', expect.any(Object));
    expect(deps.leadInboxRelayInFlight.has('alpha')).toBe(false);
    expect(capturedPorts).not.toBeNull();

    const ports = capturedPorts as unknown as LeadInboxRelayFlowPorts<LeadInboxRelayFlowRun>;
    expect(ports.getAliveRunId('alpha')).toBe('run-1');
    expect(ports.getProvisioningRunId('alpha')).toBeNull();
    expect(ports.getRun('run-1')).toEqual(expect.objectContaining({ runId: 'run-1' }));
    expect(ports.isCurrentTrackedRun(createRun())).toBe(true);
    await expect(ports.readConfigForObservation('alpha')).resolves.toEqual({ members: [] });
    await expect(ports.readLeadInboxMessages('alpha', 'lead')).resolves.toEqual([]);
    await ports.markInboxMessagesRead('alpha', 'lead', [{ messageId: 'msg-1' }]);
    const message = { messageId: 'msg-1', text: 'hello' } as InboxMessage;
    ports.pushLiveLeadProcessMessage('alpha', message);
    ports.persistSentMessage('alpha', message);
    const event: TeamChangeEvent = { type: 'inbox', teamName: 'alpha', detail: 'relay' };
    ports.emitTeamChange(event);

    expect(deps.markInboxMessagesRead).toHaveBeenCalledWith('alpha', 'lead', [
      { messageId: 'msg-1' },
    ]);
    expect(deps.pushLiveLeadProcessMessage).toHaveBeenCalledWith('alpha', message);
    expect(deps.persistSentMessage).toHaveBeenCalledWith('alpha', message);
    expect(deps.emitTeamChange).toHaveBeenCalledWith(event);
    expect(ports.relayedLeadInboxMessageIds).toBe(relayedLeadInboxMessageIds);
    expect(ports.pendingCrossTeamFirstReplies).toBe(pendingCrossTeamFirstReplies);
    expect(ports.recentCrossTeamLeadDeliveryMessageIds).toBe(recentCrossTeamLeadDeliveryMessageIds);
    expect(ports.sameTeamRunStartSkewMs).toBe(1_000);
    expect(ports.sameTeamNativeDeliveryGraceMs).toBe(15_000);
    expect(ports.recentCrossTeamDeliveryTtlMs).toBe(600_000);
  });

  it('shares existing in-flight relay work and clears the matching entry', async () => {
    const existing = Promise.resolve(3);
    const deps = createDeps({
      leadInboxRelayInFlight: new Map([['alpha', existing]]),
      relayLeadInboxMessagesForTeam: vi.fn().mockResolvedValue(1),
    });
    const boundary = createTeamProvisioningLeadInboxRelayPortsBoundary(deps);

    await expect(boundary.relayLeadInboxMessages('alpha')).resolves.toBe(3);

    expect(deps.relayLeadInboxMessagesForTeam).not.toHaveBeenCalled();
    expect(deps.leadInboxRelayInFlight.has('alpha')).toBe(false);
  });

  it('keeps timeout diagnostics and returns zero for in-flight timeout', async () => {
    const existing = new Promise<number>(() => undefined);
    const deps = createDeps({
      leadInboxRelayInFlight: new Map([['alpha', existing]]),
      waitForInboxRelayInFlight: vi
        .fn()
        .mockRejectedValue(
          new InboxRelayInFlightTimeoutError('lead_inbox_relay timed out after 120000ms: alpha')
        ),
    });
    const boundary = createTeamProvisioningLeadInboxRelayPortsBoundary(deps);

    await expect(boundary.relayLeadInboxMessages('alpha')).resolves.toBe(0);

    expect(deps.logger.warn).toHaveBeenCalledWith(
      '[alpha] lead_inbox_relay_timed_out: lead_inbox_relay timed out after 120000ms: alpha'
    );
    expect(deps.leadInboxRelayInFlight.has('alpha')).toBe(false);
  });
});

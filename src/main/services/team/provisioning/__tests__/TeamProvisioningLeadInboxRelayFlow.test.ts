import { describe, expect, it, vi } from 'vitest';

import {
  type LeadInboxRelayFlowPorts,
  type LeadInboxRelayFlowRun,
  relayLeadInboxMessagesForTeam,
} from '../TeamProvisioningLeadInboxRelayFlow';

import type { InboxMessage, TeamChangeEvent } from '@shared/types';

function permissionText(id = 'req-1'): string {
  return JSON.stringify({
    type: 'permission_request',
    request_id: id,
    agent_id: 'dev',
    tool_name: 'Edit',
    tool_use_id: 'tool-1',
    description: 'edit',
    input: {},
    permission_suggestions: [],
  });
}

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

function createMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'user',
    to: 'team-lead',
    text: 'Please check this.',
    timestamp: '2026-01-01T00:01:00.000Z',
    read: false,
    messageId: 'msg-1',
    source: 'user_sent',
    ...overrides,
  };
}

function createPorts(
  run: LeadInboxRelayFlowRun,
  messages: InboxMessage[]
): LeadInboxRelayFlowPorts<LeadInboxRelayFlowRun> & {
  emittedEvents: TeamChangeEvent[];
  persistedMessages: InboxMessage[];
  sentMessages: string[];
} {
  const emittedEvents: TeamChangeEvent[] = [];
  const persistedMessages: InboxMessage[] = [];
  const sentMessages: string[] = [];

  return {
    getAliveRunId: vi.fn().mockReturnValue(run.runId),
    getProvisioningRunId: vi.fn().mockReturnValue(null),
    getRun: vi.fn().mockReturnValue(run),
    isCurrentTrackedRun: vi.fn().mockReturnValue(true),
    readConfigForObservation: vi.fn().mockResolvedValue({
      members: [
        { name: 'team-lead', agentType: 'team-lead' },
        { name: 'dev', role: 'Developer' },
      ],
    }),
    readLeadInboxMessages: vi.fn().mockResolvedValue(messages),
    markInboxMessagesRead: vi.fn().mockResolvedValue(undefined),
    handleTeammatePermissionRequest: vi.fn(),
    refreshMemberSpawnStatusesFromLeadInbox: vi.fn().mockResolvedValue(undefined),
    confirmSameTeamNativeMatches: vi
      .fn()
      .mockResolvedValue({ nativeMatchedMessageIds: new Set<string>(), persisted: true }),
    scheduleSameTeamPersistRetry: vi.fn(),
    scheduleSameTeamDeferredRetry: vi.fn(),
    resolveControlApiBaseUrl: vi.fn().mockResolvedValue(null),
    sendMessageToRun: vi.fn().mockImplementation(async (_run, message: string) => {
      sentMessages.push(message);
      run.leadRelayCapture?.resolveOnce('I created a task for this.');
    }),
    hasAcceptedLeadWorkSyncReport: vi.fn().mockResolvedValue(true),
    scheduleLeadProofMissingWorkSyncRecovery: vi.fn().mockResolvedValue(false),
    pushLiveLeadTextMessage: vi.fn(),
    pushLiveLeadProcessMessage: vi.fn(),
    persistSentMessage: vi.fn((_teamName, message) => {
      persistedMessages.push(message);
    }),
    emitTeamChange: vi.fn((event) => {
      emittedEvents.push(event);
    }),
    scheduleLeadInboxFollowUpRelay: vi.fn(),
    relayedLeadInboxMessageIds: new Map(),
    trimRelayedSet: vi.fn((relayedIds) => relayedIds),
    pendingCrossTeamFirstReplies: new Map(),
    recentCrossTeamLeadDeliveryMessageIds: new Map(),
    sameTeamRunStartSkewMs: 1_000,
    sameTeamNativeDeliveryGraceMs: 0,
    recentCrossTeamDeliveryTtlMs: 10_000,
    logger: { debug: vi.fn() },
    nowIso: vi.fn().mockReturnValue('2026-01-01T00:02:00.000Z'),
    nowMs: vi.fn().mockReturnValue(123),
    setTimeout: vi.fn().mockReturnValue({} as NodeJS.Timeout),
    clearTimeout: vi.fn(),
    emittedEvents,
    persistedMessages,
    sentMessages,
  };
}

describe('lead inbox relay flow', () => {
  it('scans permission requests before provisioning is complete and does not relay', async () => {
    const run = createRun({ provisioningComplete: false });
    const ports = createPorts(run, [createMessage({ text: permissionText(), from: 'dev' })]);

    const relayed = await relayLeadInboxMessagesForTeam('alpha', ports);

    expect(relayed).toBe(0);
    expect(ports.handleTeammatePermissionRequest).toHaveBeenCalledWith(
      run,
      expect.objectContaining({ requestId: 'req-1', agentId: 'dev' }),
      '2026-01-01T00:01:00.000Z'
    );
    expect(ports.markInboxMessagesRead).toHaveBeenCalledWith('alpha', 'team-lead', [
      { messageId: 'msg-1' },
    ]);
    expect(ports.sendMessageToRun).not.toHaveBeenCalled();
  });

  it('relays actionable lead inbox messages and persists user-visible replies', async () => {
    const run = createRun();
    const ports = createPorts(run, [createMessage()]);

    const relayed = await relayLeadInboxMessagesForTeam('alpha', ports);

    expect(relayed).toBe(1);
    expect(ports.sentMessages[0]).toContain('Messages:');
    expect(ports.relayedLeadInboxMessageIds.get('alpha')?.has('msg-1')).toBe(true);
    expect(ports.markInboxMessagesRead).toHaveBeenLastCalledWith(
      'alpha',
      'team-lead',
      expect.arrayContaining([expect.objectContaining({ messageId: 'msg-1' })])
    );
    expect(ports.persistedMessages).toEqual([
      expect.objectContaining({
        from: 'team-lead',
        to: 'user',
        text: 'I created a task for this.',
        source: 'lead_process',
      }),
    ]);
    expect(ports.emittedEvents).toEqual([
      { type: 'inbox', teamName: 'alpha', detail: 'lead-process-reply' },
    ]);
    expect(run.leadRelayCapture).toBeNull();
  });
});

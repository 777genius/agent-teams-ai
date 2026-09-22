import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningLiveMessageRelayCompatibilityFacade } from '../TeamProvisioningLiveMessageRelayCompatibilityFacade';

interface RelayFacadeMock {
  leadInboxRelayInFlight: Map<string, Promise<number>>;
  relayedLeadInboxMessageIds: Map<string, Set<string>>;
  memberInboxRelayInFlight: Map<string, Promise<number>>;
  relayedMemberInboxMessageIds: Map<string, Set<string>>;
  pendingCrossTeamFirstReplies: Map<string, Map<string, number>>;
  recentCrossTeamLeadDeliveryMessageIds: Map<string, Map<string, number>>;
  recentSameTeamNativeFingerprints: Map<string, unknown[]>;
  sameTeamNativeDelivery: { marker: string };
  rememberRecentCrossTeamLeadDeliveryMessageIds: ReturnType<typeof vi.fn>;
  registerPendingCrossTeamReplyExpectation: ReturnType<typeof vi.fn>;
  clearPendingCrossTeamReplyExpectation: ReturnType<typeof vi.fn>;
  getPendingCrossTeamReplyExpectationKeys: ReturnType<typeof vi.fn>;
  getRunLeadName: ReturnType<typeof vi.fn>;
  handleNativeTeammateUserMessage: ReturnType<typeof vi.fn>;
  getMemberRelayKey: ReturnType<typeof vi.fn>;
  getOpenCodeMemberRelayKey: ReturnType<typeof vi.fn>;
  forwardUserDmToTeammate: ReturnType<typeof vi.fn>;
  relayMemberInboxMessages: ReturnType<typeof vi.fn>;
  relayInboxFileToLiveRecipient: ReturnType<typeof vi.fn>;
  relayOpenCodeMemberInboxMessages: ReturnType<typeof vi.fn>;
  relayLeadInboxMessages: ReturnType<typeof vi.fn>;
}

interface RelayHarness {
  leadInboxRelayFacade: RelayFacadeMock;
  leadInboxRelayInFlight: Map<string, Promise<number>>;
  relayedLeadInboxMessageIds: Map<string, Set<string>>;
  memberInboxRelayInFlight: Map<string, Promise<number>>;
  relayedMemberInboxMessageIds: Map<string, Set<string>>;
  pendingCrossTeamFirstReplies: Map<string, Map<string, number>>;
  recentCrossTeamLeadDeliveryMessageIds: Map<string, Map<string, number>>;
  recentSameTeamNativeFingerprints: Map<string, unknown[]>;
  sameTeamNativeDelivery: { marker: string };
  rememberRecentCrossTeamLeadDeliveryMessageIds(
    teamName: string,
    messageIds: readonly string[]
  ): void;
  registerPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void;
  clearPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void;
  getPendingCrossTeamReplyExpectationKeys(teamName: string): Set<string>;
  getRunLeadName(run: unknown): string;
  handleNativeTeammateUserMessage(run: unknown, msg: Record<string, unknown>): void;
  getMemberRelayKey(teamName: string, memberName: string): string;
  getOpenCodeMemberRelayKey(teamName: string, memberName: string): string;
  forwardUserDmToTeammate(
    teamName: string,
    teammateName: string,
    userText: string,
    userSummary?: string
  ): Promise<void>;
  relayMemberInboxMessages(teamName: string, memberName: string): Promise<number>;
  relayInboxFileToLiveRecipient(
    teamName: string,
    inboxName: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  relayLeadInboxMessages(teamName: string): Promise<number>;
  trimRelayedSet(set: Set<string>): Set<string>;
}

function createHarness(): { harness: RelayHarness; relayFacade: RelayFacadeMock } {
  const relayFacade: RelayFacadeMock = {
    leadInboxRelayInFlight: new Map(),
    relayedLeadInboxMessageIds: new Map(),
    memberInboxRelayInFlight: new Map(),
    relayedMemberInboxMessageIds: new Map(),
    pendingCrossTeamFirstReplies: new Map(),
    recentCrossTeamLeadDeliveryMessageIds: new Map(),
    recentSameTeamNativeFingerprints: new Map(),
    sameTeamNativeDelivery: { marker: 'same-team-native' },
    rememberRecentCrossTeamLeadDeliveryMessageIds: vi.fn(),
    registerPendingCrossTeamReplyExpectation: vi.fn(),
    clearPendingCrossTeamReplyExpectation: vi.fn(),
    getPendingCrossTeamReplyExpectationKeys: vi.fn(() => new Set(['peer:conversation'])),
    getRunLeadName: vi.fn(() => 'Lead'),
    handleNativeTeammateUserMessage: vi.fn(),
    getMemberRelayKey: vi.fn(() => 'alpha:worker'),
    getOpenCodeMemberRelayKey: vi.fn(() => 'opencode:alpha:worker'),
    forwardUserDmToTeammate: vi.fn(async () => undefined),
    relayMemberInboxMessages: vi.fn(async () => 2),
    relayInboxFileToLiveRecipient: vi.fn(async () => ({ kind: 'native_lead', relayed: 3 })),
    relayOpenCodeMemberInboxMessages: vi.fn(async () => ({ relayed: 4 })),
    relayLeadInboxMessages: vi.fn(async () => 5),
  };
  const harness = Object.create(
    TeamProvisioningLiveMessageRelayCompatibilityFacade.prototype
  ) as RelayHarness;
  Object.defineProperty(harness, 'leadInboxRelayFacade', {
    configurable: true,
    value: relayFacade,
  });
  return { harness, relayFacade };
}

describe('TeamProvisioningLiveMessageRelayCompatibilityFacade', () => {
  it('delegates public live relay compatibility methods to the lead inbox relay facade', async () => {
    const { harness, relayFacade } = createHarness();
    const options = { force: true };

    harness.registerPendingCrossTeamReplyExpectation('alpha', 'beta', 'conversation-1');
    harness.clearPendingCrossTeamReplyExpectation('alpha', 'beta', 'conversation-1');
    await harness.forwardUserDmToTeammate('alpha', 'worker', 'hello', 'summary');
    await expect(harness.relayMemberInboxMessages('alpha', 'worker')).resolves.toBe(2);
    await expect(
      harness.relayInboxFileToLiveRecipient('alpha', 'team-lead', options)
    ).resolves.toEqual({ kind: 'native_lead', relayed: 3 });
    await expect(
      harness.relayOpenCodeMemberInboxMessages('alpha', 'worker', options)
    ).resolves.toEqual({ relayed: 4 });
    await expect(harness.relayLeadInboxMessages('alpha')).resolves.toBe(5);

    expect(relayFacade.registerPendingCrossTeamReplyExpectation).toHaveBeenCalledWith(
      'alpha',
      'beta',
      'conversation-1'
    );
    expect(relayFacade.clearPendingCrossTeamReplyExpectation).toHaveBeenCalledWith(
      'alpha',
      'beta',
      'conversation-1'
    );
    expect(relayFacade.forwardUserDmToTeammate).toHaveBeenCalledWith(
      'alpha',
      'worker',
      'hello',
      'summary'
    );
    expect(relayFacade.relayInboxFileToLiveRecipient).toHaveBeenCalledWith(
      'alpha',
      'team-lead',
      options
    );
    expect(relayFacade.relayOpenCodeMemberInboxMessages).toHaveBeenCalledWith(
      'alpha',
      'worker',
      options
    );
  });

  it('exposes relay state ports and private service-host helpers from the facade', () => {
    const { harness, relayFacade } = createHarness();
    const run = { runId: 'run-1' };
    const message = { type: 'user', content: [] };

    harness.rememberRecentCrossTeamLeadDeliveryMessageIds('alpha', ['message-1']);
    expect(harness.leadInboxRelayInFlight).toBe(relayFacade.leadInboxRelayInFlight);
    expect(harness.relayedLeadInboxMessageIds).toBe(relayFacade.relayedLeadInboxMessageIds);
    expect(harness.memberInboxRelayInFlight).toBe(relayFacade.memberInboxRelayInFlight);
    expect(harness.relayedMemberInboxMessageIds).toBe(relayFacade.relayedMemberInboxMessageIds);
    expect(harness.pendingCrossTeamFirstReplies).toBe(relayFacade.pendingCrossTeamFirstReplies);
    expect(harness.recentCrossTeamLeadDeliveryMessageIds).toBe(
      relayFacade.recentCrossTeamLeadDeliveryMessageIds
    );
    expect(harness.recentSameTeamNativeFingerprints).toBe(
      relayFacade.recentSameTeamNativeFingerprints
    );
    expect(harness.sameTeamNativeDelivery).toBe(relayFacade.sameTeamNativeDelivery);
    expect(harness.getPendingCrossTeamReplyExpectationKeys('alpha')).toEqual(
      new Set(['peer:conversation'])
    );
    expect(harness.getRunLeadName(run)).toBe('Lead');
    harness.handleNativeTeammateUserMessage(run, message);
    expect(harness.getMemberRelayKey('alpha', 'worker')).toBe('alpha:worker');
    expect(harness.getOpenCodeMemberRelayKey('alpha', 'worker')).toBe('opencode:alpha:worker');

    const oversized = new Set(Array.from({ length: 2001 }, (_value, index) => `msg-${index}`));
    const trimmed = harness.trimRelayedSet(oversized);
    expect(trimmed.size).toBe(2000);
    expect([...trimmed][0]).toBe('msg-1');
    expect(relayFacade.rememberRecentCrossTeamLeadDeliveryMessageIds).toHaveBeenCalledWith(
      'alpha',
      ['message-1']
    );
    expect(relayFacade.handleNativeTeammateUserMessage).toHaveBeenCalledWith(run, message);
  });
});

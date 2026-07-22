import { describe, expect, it, vi } from 'vitest';

import {
  LiveInboxRelayKind,
  type RelayInboxFileToLiveRecipientPorts,
  relayInboxFileToLiveRecipientWithPorts,
} from '../TeamProvisioningLiveInboxRelayRouting';
import { isOpenCodeRuntimeRecipientFromSources } from '../TeamProvisioningRuntimeRecipientResolution';

import type { TeamConfig, TeamMember } from '@shared/types';

function config(members: TeamMember[]): TeamConfig {
  return {
    name: 'team-a',
    members,
  };
}

function createPorts(
  overrides: Partial<RelayInboxFileToLiveRecipientPorts> = {}
): RelayInboxFileToLiveRecipientPorts {
  return {
    readConfigSnapshot: vi
      .fn()
      .mockResolvedValue(config([{ name: 'team-lead' }, { name: 'Worker' }])),
    readMetaMembers: vi.fn().mockResolvedValue([]),
    readInboxMessages: vi.fn().mockResolvedValue([]),
    isOpenCodeRuntimeRecipientFromSources: vi.fn().mockReturnValue(false),
    relayOpenCodeMemberInboxMessages: vi.fn().mockResolvedValue({
      relayed: 0,
      attempted: 0,
      delivered: 0,
      failed: 0,
    }),
    relayLeadInboxMessages: vi.fn().mockResolvedValue(0),
    wasRecentlyDeliveredToLead: vi.fn().mockReturnValue(false),
    hasSuccessfulLeadRecoveryMessage: vi.fn().mockReturnValue(false),
    isLeadRecoveryMessage: vi.fn().mockReturnValue(false),
    isTeamAlive: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

describe('TeamProvisioningLiveInboxRelayRouting', () => {
  it('ignores cross-team inbox pseudo recipients without reading team state', async () => {
    const ports = createPorts();

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'cross_team--peer-team' },
        ports
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.Ignored,
      relayed: 0,
    });

    expect(ports.readConfigSnapshot).not.toHaveBeenCalled();
    expect(ports.readMetaMembers).not.toHaveBeenCalled();
  });

  it('routes native lead inbox files through the lead relay only when the team is alive', async () => {
    const relayLeadInboxMessages = vi.fn().mockResolvedValue(2);
    const ports = createPorts({ relayLeadInboxMessages });

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: ' TEAM-LEAD ' },
        ports
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.NativeLead,
      relayed: 2,
    });
    expect(relayLeadInboxMessages).toHaveBeenCalledWith('team-a');

    const deadTeamPorts = createPorts({
      isTeamAlive: vi.fn().mockReturnValue(false),
      relayLeadInboxMessages,
    });
    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'team-lead' },
        deadTeamPorts
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.NativeLead,
      relayed: 0,
    });
  });

  it('scopes native lead runtime relay to the requested message id', async () => {
    const relayLeadInboxMessages = vi.fn().mockResolvedValue(1);
    const ports = createPorts({ relayLeadInboxMessages });

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'team-lead', options: { onlyMessageId: 'message-1' } },
        ports
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.NativeLead,
      relayed: 1,
      recentlyDeliveredMessageId: 'message-1',
    });
    expect(relayLeadInboxMessages).toHaveBeenCalledWith('team-a', { onlyMessageId: 'message-1' });
    expect(ports.wasRecentlyDeliveredToLead).not.toHaveBeenCalled();
  });

  it('returns exact recent delivery proof for a scoped native lead message', async () => {
    const ports = createPorts({
      wasRecentlyDeliveredToLead: vi.fn((_teamName, messageId) => messageId === 'message-1'),
    });

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'team-lead', options: { onlyMessageId: 'message-1' } },
        ports
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.NativeLead,
      relayed: 0,
      recentlyDeliveredMessageId: 'message-1',
    });

    expect(ports.relayLeadInboxMessages).toHaveBeenCalledWith('team-a', {
      onlyMessageId: 'message-1',
    });
    expect(ports.wasRecentlyDeliveredToLead).toHaveBeenCalledWith('team-a', 'message-1');
  });

  it('does not invent native lead delivery proof for an unconfirmed scoped message', async () => {
    const ports = createPorts();

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'team-lead', options: { onlyMessageId: 'message-1' } },
        ports
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.NativeLead,
      relayed: 0,
    });

    expect(ports.wasRecentlyDeliveredToLead).toHaveBeenCalledWith('team-a', 'message-1');
  });

  it('returns terminal response proof for a successfully completed native recovery relay', async () => {
    const ports = createPorts({
      isLeadRecoveryMessage: vi.fn((_teamName, messageId) => messageId === 'recovery-1'),
      hasSuccessfulLeadRecoveryMessage: vi.fn((_teamName, messageId) => messageId === 'recovery-1'),
    });

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'team-lead', options: { onlyMessageId: 'recovery-1' } },
        ports
      )
    ).resolves.toMatchObject({
      kind: LiveInboxRelayKind.NativeLead,
      relayed: 0,
      lastDelivery: {
        delivered: true,
        accepted: true,
        responsePending: false,
      },
    });
  });

  it('routes OpenCode lead inbox files through OpenCode member delivery', async () => {
    const relayOpenCodeMemberInboxMessages = vi.fn().mockResolvedValue({
      relayed: 1,
      attempted: 1,
      delivered: 1,
      failed: 0,
      diagnostics: ['proof pending'],
      lastDelivery: { delivered: true },
    });
    const deliveryMetadata = {
      replyRecipient: 'user',
      actionMode: 'do' as const,
      taskRefs: [{ taskId: 'task-1', displayId: 'TASK-1', teamName: 'team-a' }],
    };
    const ports = createPorts({
      isOpenCodeRuntimeRecipientFromSources: vi.fn().mockReturnValue(true),
      relayOpenCodeMemberInboxMessages,
    });

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        {
          teamName: 'team-a',
          inboxName: 'team-lead',
          options: { onlyMessageId: 'message-1', deliveryMetadata },
        },
        ports
      )
    ).resolves.toMatchObject({
      kind: LiveInboxRelayKind.OpenCodeMember,
      relayed: 1,
      diagnostics: ['proof pending'],
      lastDelivery: { delivered: true },
    });
    expect(relayOpenCodeMemberInboxMessages).toHaveBeenCalledWith('team-a', 'team-lead', {
      source: 'watcher',
      onlyMessageId: 'message-1',
      deliveryMetadata,
    });
    expect(ports.relayLeadInboxMessages).not.toHaveBeenCalled();
  });

  it('routes OpenCode non-lead inbox files and no-ops native member inbox files', async () => {
    const relayOpenCodeMemberInboxMessages = vi.fn().mockResolvedValue({
      relayed: 3,
      attempted: 3,
      delivered: 3,
      failed: 0,
    });
    const openCodePorts = createPorts({
      isOpenCodeRuntimeRecipientFromSources: vi.fn().mockReturnValue(true),
      relayOpenCodeMemberInboxMessages,
    });

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'worker', options: { source: 'manual' } },
        openCodePorts
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.OpenCodeMember,
      relayed: 3,
      diagnostics: undefined,
      lastDelivery: undefined,
    });
    expect(relayOpenCodeMemberInboxMessages).toHaveBeenCalledWith('team-a', 'Worker', {
      source: 'manual',
    });

    const nativePorts = createPorts();
    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'worker' },
        nativePorts
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.NativeMemberNoop,
      relayed: 0,
    });
    expect(nativePorts.relayLeadInboxMessages).not.toHaveBeenCalled();
  });

  it('proves an exact native member durable inbox handoff without treating noop as proof', async () => {
    const readInboxMessages = vi.fn().mockResolvedValue([
      {
        from: 'source-team.team-lead',
        to: 'Worker',
        text: 'runtime handoff',
        timestamp: '2026-07-22T00:00:00.000Z',
        messageId: 'message-1',
        read: false,
        source: 'cross_team' as const,
      },
    ]);
    const ports = createPorts({ readInboxMessages });

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'worker', options: { onlyMessageId: 'message-1' } },
        ports
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.NativeMemberNoop,
      relayed: 0,
      durablyStoredMessageId: 'message-1',
    });
    expect(readInboxMessages).toHaveBeenCalledWith('team-a', 'Worker');
  });

  it.each([
    {
      label: 'config',
      overrides: {
        readConfigSnapshot: vi.fn().mockRejectedValue(new Error('config unreadable')),
        readMetaMembers: vi.fn().mockResolvedValue([{ name: 'Worker', providerId: 'codex' }]),
      },
      diagnostic: 'config identity read failed: config unreadable',
    },
    {
      label: 'metadata',
      overrides: {
        readConfigSnapshot: vi
          .fn()
          .mockResolvedValue(config([{ name: 'Worker', providerId: 'codex' }])),
        readMetaMembers: vi.fn().mockRejectedValue(new Error('metadata unreadable')),
      },
      diagnostic: 'metadata identity read failed: metadata unreadable',
    },
  ])(
    'fails closed on $label read failure even when the inbox contains exact proof',
    async (test) => {
      const readInboxMessages = vi.fn().mockResolvedValue([
        {
          from: 'source-team.team-lead',
          to: 'Worker',
          text: 'runtime handoff',
          timestamp: '2026-07-22T00:00:00.000Z',
          messageId: 'message-1',
          read: false,
          source: 'cross_team' as const,
        },
      ]);
      const ports = createPorts({ ...test.overrides, readInboxMessages });

      await expect(
        relayInboxFileToLiveRecipientWithPorts(
          { teamName: 'team-a', inboxName: 'Worker', options: { onlyMessageId: 'message-1' } },
          ports
        )
      ).resolves.toEqual({
        kind: LiveInboxRelayKind.Ignored,
        relayed: 0,
        diagnostics: [test.diagnostic],
      });
      expect(readInboxMessages).not.toHaveBeenCalled();
    }
  );

  it('fails closed when no authoritative recipient exists even if an inbox row matches', async () => {
    const readInboxMessages = vi.fn().mockResolvedValue([
      {
        from: 'source-team.team-lead',
        to: 'PossibleOpenCodeMember',
        text: 'runtime handoff',
        timestamp: '2026-07-22T00:00:00.000Z',
        messageId: 'message-1',
        read: false,
        source: 'cross_team' as const,
      },
    ]);
    const ports = createPorts({ readInboxMessages });

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        {
          teamName: 'team-a',
          inboxName: 'PossibleOpenCodeMember',
          options: { onlyMessageId: 'message-1' },
        },
        ports
      )
    ).resolves.toMatchObject({
      kind: LiveInboxRelayKind.Ignored,
      relayed: 0,
      diagnostics: [expect.stringContaining('recipient identity unavailable')],
    });
    expect(readInboxMessages).not.toHaveBeenCalled();
  });

  it('uses metadata lead identity for native lead relay when config has no lead', async () => {
    const relayLeadInboxMessages = vi.fn().mockResolvedValue(1);
    const ports = createPorts({
      readConfigSnapshot: vi.fn().mockResolvedValue(config([{ name: 'Worker' }])),
      readMetaMembers: vi
        .fn()
        .mockResolvedValue([{ name: 'Captain', agentType: 'team-lead', providerId: 'codex' }]),
      relayLeadInboxMessages,
    });

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'Captain', options: { onlyMessageId: 'message-1' } },
        ports
      )
    ).resolves.toMatchObject({
      kind: LiveInboxRelayKind.NativeLead,
      relayed: 1,
      recentlyDeliveredMessageId: 'message-1',
    });
    expect(relayLeadInboxMessages).toHaveBeenCalledWith('team-a', {
      onlyMessageId: 'message-1',
    });
  });

  it('fails closed before provider selection when either authoritative identity source fails', async () => {
    const relayOpenCodeMemberInboxMessages = vi.fn().mockResolvedValue({
      relayed: 1,
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    const ports = createPorts({
      readConfigSnapshot: vi.fn().mockRejectedValue(new Error('config unreadable')),
      readMetaMembers: vi.fn().mockResolvedValue([{ name: 'Builder', providerId: 'opencode' }]),
      isOpenCodeRuntimeRecipientFromSources,
      relayOpenCodeMemberInboxMessages,
    });

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'Builder', options: { onlyMessageId: 'message-1' } },
        ports
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.Ignored,
      relayed: 0,
      diagnostics: ['config identity read failed: config unreadable'],
    });
    expect(relayOpenCodeMemberInboxMessages).not.toHaveBeenCalled();
  });

  it('does not resurrect a config recipient tombstoned by raw metadata', async () => {
    const providerResolver = vi.fn(isOpenCodeRuntimeRecipientFromSources);
    const relayOpenCodeMemberInboxMessages = vi.fn();
    const ports = createPorts({
      readConfigSnapshot: vi.fn().mockResolvedValue(
        config([
          { name: 'team-lead', providerId: 'codex' },
          { name: 'Builder', providerId: 'opencode' },
        ])
      ),
      readMetaMembers: vi
        .fn()
        .mockResolvedValue([{ name: 'builder', providerId: 'opencode', removedAt: 1 }]),
      isOpenCodeRuntimeRecipientFromSources: providerResolver,
      relayOpenCodeMemberInboxMessages,
    });

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'BUILDER', options: { onlyMessageId: 'message-1' } },
        ports
      )
    ).resolves.toMatchObject({
      kind: LiveInboxRelayKind.Ignored,
      relayed: 0,
      diagnostics: [expect.stringContaining('recipient identity unavailable')],
    });
    expect(providerResolver).not.toHaveBeenCalled();
    expect(relayOpenCodeMemberInboxMessages).not.toHaveBeenCalled();
  });

  it('fails closed when active config and metadata providers disagree', async () => {
    const providerResolver = vi.fn(isOpenCodeRuntimeRecipientFromSources);
    const relayOpenCodeMemberInboxMessages = vi.fn();
    const sourceConfig = config([
      { name: 'team-lead', providerId: 'codex' },
      { name: 'Builder', providerId: 'opencode' },
    ]);
    const metaMembers: TeamMember[] = [{ name: 'builder', providerId: 'codex' }];
    const ports = createPorts({
      readConfigSnapshot: vi.fn().mockResolvedValue(sourceConfig),
      readMetaMembers: vi.fn().mockResolvedValue(metaMembers),
      isOpenCodeRuntimeRecipientFromSources: providerResolver,
      relayOpenCodeMemberInboxMessages,
    });

    await expect(
      relayInboxFileToLiveRecipientWithPorts({ teamName: 'team-a', inboxName: 'builder' }, ports)
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.Ignored,
      relayed: 0,
      diagnostics: [
        'runtime identity resolution failed: Ambiguous runtime recipient provider identity for Builder: config=opencode, metadata=codex',
      ],
    });
    expect(providerResolver).toHaveBeenCalledOnce();
    expect(providerResolver).toHaveBeenCalledWith({
      memberName: 'Builder',
      config: sourceConfig,
      metaMembers,
    });
    expect(relayOpenCodeMemberInboxMessages).not.toHaveBeenCalled();
  });

  it('fails closed for an active metadata-only OpenCode recipient', async () => {
    const relayOpenCodeMemberInboxMessages = vi.fn().mockResolvedValue({
      relayed: 1,
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    const ports = createPorts({
      readConfigSnapshot: vi
        .fn()
        .mockResolvedValue(config([{ name: 'team-lead', providerId: 'codex' }])),
      readMetaMembers: vi
        .fn()
        .mockResolvedValue([{ name: 'MetadataBuilder', providerId: 'opencode' }]),
      isOpenCodeRuntimeRecipientFromSources,
      relayOpenCodeMemberInboxMessages,
    });

    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'metadatabuilder' },
        ports
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.Ignored,
      relayed: 0,
      diagnostics: [
        'runtime identity resolution failed: OpenCode runtime recipient MetadataBuilder has no authoritative config identity',
      ],
    });
    expect(relayOpenCodeMemberInboxMessages).not.toHaveBeenCalled();
  });

  it('fails closed when config and metadata name distinct active leads', async () => {
    const providerResolver = vi.fn(isOpenCodeRuntimeRecipientFromSources);
    const ports = createPorts({
      readConfigSnapshot: vi
        .fn()
        .mockResolvedValue(config([{ name: 'Captain', agentType: 'team-lead' }])),
      readMetaMembers: vi.fn().mockResolvedValue([{ name: 'Commander', agentType: 'team-lead' }]),
      isOpenCodeRuntimeRecipientFromSources: providerResolver,
    });

    await expect(
      relayInboxFileToLiveRecipientWithPorts({ teamName: 'team-a', inboxName: 'Captain' }, ports)
    ).resolves.toMatchObject({
      kind: LiveInboxRelayKind.Ignored,
      relayed: 0,
      diagnostics: [expect.stringContaining('Ambiguous active team lead identity')],
    });
    expect(providerResolver).not.toHaveBeenCalled();
  });

  it('rejects missing and corrupt native member durable inbox proof', async () => {
    const missingPorts = createPorts();
    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'worker', options: { onlyMessageId: 'message-1' } },
        missingPorts
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.NativeMemberNoop,
      relayed: 0,
      diagnostics: ['durable inbox message not found: message-1'],
    });

    const corruptPorts = createPorts({
      readInboxMessages: vi.fn().mockResolvedValue([
        {
          messageId: 'message-1',
          source: 'cross_team',
        },
      ] as never),
    });
    await expect(
      relayInboxFileToLiveRecipientWithPorts(
        { teamName: 'team-a', inboxName: 'worker', options: { onlyMessageId: 'message-1' } },
        corruptPorts
      )
    ).resolves.toEqual({
      kind: LiveInboxRelayKind.NativeMemberNoop,
      relayed: 0,
      diagnostics: ['durable inbox message not found: message-1'],
    });
  });
});

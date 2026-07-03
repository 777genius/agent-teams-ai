import { describe, expect, it, vi } from 'vitest';

import {
  LiveInboxRelayKind,
  type RelayInboxFileToLiveRecipientPorts,
  relayInboxFileToLiveRecipientWithPorts,
} from '../TeamProvisioningLiveInboxRelayRouting';

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
    readConfigSnapshot: vi.fn().mockResolvedValue(config([{ name: 'team-lead' }])),
    readMetaMembers: vi.fn().mockResolvedValue([]),
    isOpenCodeRuntimeRecipientFromSources: vi.fn().mockReturnValue(false),
    relayOpenCodeMemberInboxMessages: vi.fn().mockResolvedValue({
      relayed: 0,
      attempted: 0,
      delivered: 0,
      failed: 0,
    }),
    relayLeadInboxMessages: vi.fn().mockResolvedValue(0),
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
      actionMode: 'do',
      taskRefs: [{ taskId: 'task-1', displayId: 'TASK-1', teamName: 'team-a' }],
    } as const;
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
    expect(relayOpenCodeMemberInboxMessages).toHaveBeenCalledWith('team-a', 'worker', {
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
});

import { describe, expect, it, vi } from 'vitest';

import {
  type LeadPermissionScanRun,
  scanLeadInboxPermissionRequests,
} from '../TeamProvisioningLeadPermissionScan';

import type { InboxMessage } from '@shared/types';

function createRun(overrides: Partial<LeadPermissionScanRun> = {}): LeadPermissionScanRun {
  return {
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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

function createMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'dev',
    to: 'team-lead',
    text: permissionText(),
    timestamp: '2026-01-01T00:01:00.000Z',
    read: false,
    messageId: 'msg-1',
    ...overrides,
  };
}

function createPorts(messages: InboxMessage[]) {
  return {
    readLeadInboxMessages: vi.fn().mockResolvedValue(messages),
    handleTeammatePermissionRequest: vi.fn(),
    markInboxMessagesRead: vi.fn().mockResolvedValue(undefined),
  };
}

describe('lead permission scan helpers', () => {
  it('handles current permission requests and marks unread messages read', async () => {
    const run = createRun();
    const ports = createPorts([createMessage()]);

    const result = await scanLeadInboxPermissionRequests(
      { teamName: 'alpha', leadName: 'team-lead', run, isStaleRelayRun: () => false },
      ports
    );

    expect(result).toBe('ok');
    expect(ports.handleTeammatePermissionRequest).toHaveBeenCalledWith(
      run,
      expect.objectContaining({ requestId: 'req-1', agentId: 'dev', toolName: 'Edit' }),
      '2026-01-01T00:01:00.000Z'
    );
    expect(ports.markInboxMessagesRead).toHaveBeenCalledWith('alpha', 'team-lead', [
      { messageId: 'msg-1' },
    ]);
  });

  it('leaves failed permission requests unread while continuing with later messages', async () => {
    const ports = createPorts([
      createMessage(),
      createMessage({ text: permissionText('req-2'), messageId: 'msg-2' }),
    ]);
    ports.handleTeammatePermissionRequest
      .mockImplementationOnce(() => {
        throw new Error('handler failed');
      })
      .mockImplementationOnce(() => {});

    const result = await scanLeadInboxPermissionRequests(
      { teamName: 'alpha', leadName: 'team-lead', run: createRun(), isStaleRelayRun: () => false },
      ports
    );

    expect(result).toBe('ok');
    expect(ports.handleTeammatePermissionRequest).toHaveBeenCalledTimes(2);
    expect(ports.markInboxMessagesRead).toHaveBeenCalledWith('alpha', 'team-lead', [
      { messageId: 'msg-2' },
    ]);
  });

  it('ignores stale permission messages from before the run started', async () => {
    const ports = createPorts([
      createMessage({ timestamp: '2025-12-31T23:59:00.000Z', messageId: 'old' }),
    ]);

    await scanLeadInboxPermissionRequests(
      {
        teamName: 'alpha',
        leadName: 'team-lead',
        run: createRun(),
        isStaleRelayRun: () => false,
      },
      ports
    );

    expect(ports.handleTeammatePermissionRequest).not.toHaveBeenCalled();
    expect(ports.markInboxMessagesRead).not.toHaveBeenCalled();
  });

  it('returns stale when the relay becomes stale after reading inbox messages', async () => {
    const ports = createPorts([createMessage()]);

    const result = await scanLeadInboxPermissionRequests(
      { teamName: 'alpha', leadName: 'team-lead', run: createRun(), isStaleRelayRun: () => true },
      ports
    );

    expect(result).toBe('stale');
    expect(ports.handleTeammatePermissionRequest).not.toHaveBeenCalled();
  });

  it('treats unread messages without stable ids as handled but not markable', async () => {
    const ports = createPorts([createMessage({ messageId: undefined })]);

    const result = await scanLeadInboxPermissionRequests(
      { teamName: 'alpha', leadName: 'team-lead', run: createRun(), isStaleRelayRun: () => false },
      ports
    );

    expect(result).toBe('ok');
    expect(ports.handleTeammatePermissionRequest).toHaveBeenCalledTimes(1);
    expect(ports.markInboxMessagesRead).not.toHaveBeenCalled();
  });

  it('returns unavailable when the lead inbox cannot be read', async () => {
    const ports = {
      readLeadInboxMessages: vi.fn().mockRejectedValue(new Error('missing')),
      handleTeammatePermissionRequest: vi.fn(),
      markInboxMessagesRead: vi.fn(),
    };

    await expect(
      scanLeadInboxPermissionRequests(
        {
          teamName: 'alpha',
          leadName: 'team-lead',
          run: createRun(),
          isStaleRelayRun: () => false,
        },
        ports
      )
    ).resolves.toBe('unavailable');
  });
});

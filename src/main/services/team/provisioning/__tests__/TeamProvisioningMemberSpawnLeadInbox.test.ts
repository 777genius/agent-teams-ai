import { describe, expect, it, vi } from 'vitest';

import {
  applyLeadInboxSpawnSignal,
  type MemberSpawnLeadInboxRun,
  refreshMemberSpawnStatusesFromLeadInbox,
  resolveExpectedLaunchMemberName,
} from '../TeamProvisioningMemberSpawnLeadInbox';

import type { InboxMessage } from '@shared/types';

function createRun(overrides: Partial<MemberSpawnLeadInboxRun> = {}): MemberSpawnLeadInboxRun {
  return {
    teamName: 'alpha',
    startedAt: '2026-01-01T00:00:00.000Z',
    expectedMembers: ['dev', 'qa'],
    memberSpawnLeadInboxCursorByMember: new Map(),
    ...overrides,
  };
}

function createMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'dev',
    to: 'team-lead',
    text: 'Ready for work',
    timestamp: '2026-01-01T00:01:00.000Z',
    read: false,
    messageId: 'msg-1',
    ...overrides,
  };
}

function createPorts(messages: InboxMessage[]) {
  return {
    getRunLeadName: () => 'team-lead',
    readLeadInboxMessages: vi.fn().mockResolvedValue(messages),
    setMemberSpawnStatus: vi.fn(),
  };
}

describe('member spawn lead inbox helpers', () => {
  it('resolves exact and numeric-suffixed expected member names', () => {
    expect(resolveExpectedLaunchMemberName(['dev', 'qa'], 'dev')).toBe('dev');
    expect(resolveExpectedLaunchMemberName(['dev'], 'dev-2')).toBe('dev');
    expect(resolveExpectedLaunchMemberName(['dev', 'dev-2'], 'dev-2')).toBe('dev-2');
    expect(resolveExpectedLaunchMemberName(['dev', 'qa'], 'user')).toBeNull();
  });

  it('applies heartbeat signals from lead inbox messages and advances cursors', async () => {
    const run = createRun();
    const ports = createPorts([createMessage()]);

    await refreshMemberSpawnStatusesFromLeadInbox(run, ports);

    expect(ports.setMemberSpawnStatus).toHaveBeenCalledWith(
      run,
      'dev',
      'online',
      undefined,
      'heartbeat',
      expect.any(String)
    );
    expect(run.memberSpawnLeadInboxCursorByMember.get('dev')).toEqual({
      timestamp: '2026-01-01T00:01:00.000Z',
      messageId: 'msg-1',
    });
  });

  it('skips old, lead, user, system, unknown, and cursor-consumed messages', async () => {
    const run = createRun({
      memberSpawnLeadInboxCursorByMember: new Map([
        ['dev', { timestamp: '2026-01-01T00:02:00.000Z', messageId: 'msg-2' }],
      ]),
    });
    const ports = createPorts([
      createMessage({ from: 'team-lead', messageId: 'lead' }),
      createMessage({ from: 'user', messageId: 'user' }),
      createMessage({ from: 'system', messageId: 'system' }),
      createMessage({ from: 'other', messageId: 'other' }),
      createMessage({ timestamp: '2025-12-31T23:59:00.000Z', messageId: 'old' }),
      createMessage({ timestamp: '2026-01-01T00:01:00.000Z', messageId: 'msg-1' }),
    ]);

    await refreshMemberSpawnStatusesFromLeadInbox(run, ports);

    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });

  it('applies bootstrap failure signals as member errors', () => {
    const run = createRun();
    const ports = createPorts([]);
    const message = createMessage({
      text: 'Bootstrap failed: member_briefing tool not found',
      messageId: 'msg-err',
    }) as InboxMessage & { messageId: string };

    applyLeadInboxSpawnSignal(run, 'dev', message, ports);

    expect(ports.setMemberSpawnStatus).toHaveBeenCalledWith(
      run,
      'dev',
      'error',
      'Bootstrap failed: member_briefing tool not found'
    );
  });

  it('returns without throwing when the inbox cannot be read', async () => {
    const run = createRun();
    const ports = {
      getRunLeadName: () => 'team-lead',
      readLeadInboxMessages: vi.fn().mockRejectedValue(new Error('missing')),
      setMemberSpawnStatus: vi.fn(),
    };

    await refreshMemberSpawnStatusesFromLeadInbox(run, ports);

    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });
});

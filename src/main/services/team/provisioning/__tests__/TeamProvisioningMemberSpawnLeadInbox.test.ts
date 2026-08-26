import { describe, expect, it, vi } from 'vitest';

import {
  applyLeadInboxSpawnSignal,
  type MemberSpawnLeadInboxRun,
  refreshMemberSpawnStatusesFromLeadInbox,
  resolveExpectedLaunchMemberName,
} from '../TeamProvisioningMemberSpawnLeadInbox';

import type { InboxMessage, MemberSpawnStatusEntry } from '@shared/types';

type TestMemberSpawnLeadInboxRun = Omit<MemberSpawnLeadInboxRun, 'memberSpawnStatuses'> & {
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
};

function createRun(
  overrides: Partial<TestMemberSpawnLeadInboxRun> = {}
): TestMemberSpawnLeadInboxRun {
  return {
    teamName: 'alpha',
    startedAt: '2026-01-01T00:00:00.000Z',
    expectedMembers: ['dev', 'qa'],
    memberSpawnStatuses: new Map([
      [
        'dev',
        {
          status: 'waiting',
          launchState: 'starting',
          firstSpawnAcceptedAt: '2026-01-01T00:00:10.000Z',
          updatedAt: '2026-01-01T00:00:10.000Z',
        },
      ],
      [
        'qa',
        {
          status: 'waiting',
          launchState: 'starting',
          firstSpawnAcceptedAt: '2026-01-01T00:00:20.000Z',
          updatedAt: '2026-01-01T00:00:20.000Z',
        },
      ],
    ]),
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
    isCurrentTrackedRun: vi.fn(() => true),
    readLeadInboxMessages: vi.fn().mockResolvedValue(messages),
    setMemberSpawnStatus: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
      isCurrentTrackedRun: vi.fn(() => true),
      readLeadInboxMessages: vi.fn().mockRejectedValue(new Error('missing')),
      setMemberSpawnStatus: vi.fn(),
    };

    await refreshMemberSpawnStatusesFromLeadInbox(run, ports);

    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });

  it('does not apply messages or advance cursors when the run is replaced during the inbox read', async () => {
    const targetRun = createRun();
    const inboxRead = deferred<InboxMessage[]>();
    let current = true;
    const ports = {
      ...createPorts([]),
      isCurrentTrackedRun: vi.fn(() => current),
      readLeadInboxMessages: vi.fn(() => inboxRead.promise),
    };

    const refresh = refreshMemberSpawnStatusesFromLeadInbox(targetRun, ports);
    current = false;
    inboxRead.resolve([createMessage()]);
    await refresh;

    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
    expect(targetRun.memberSpawnLeadInboxCursorByMember.size).toBe(0);
  });

  it('preserves other members while skipping a member relaunched during the inbox read', async () => {
    const targetRun = createRun();
    const inboxRead = deferred<InboxMessage[]>();
    const ports = {
      ...createPorts([]),
      readLeadInboxMessages: vi.fn(() => inboxRead.promise),
    };

    const refresh = refreshMemberSpawnStatusesFromLeadInbox(targetRun, ports);
    targetRun.memberSpawnStatuses.set('dev', {
      status: 'waiting',
      launchState: 'starting',
      firstSpawnAcceptedAt: '2026-01-01T00:00:30.000Z',
      updatedAt: '2026-01-01T00:00:30.000Z',
    });
    inboxRead.resolve([
      createMessage(),
      createMessage({ from: 'qa', messageId: 'qa-1', timestamp: '2026-01-01T00:01:01.000Z' }),
    ]);
    await refresh;

    expect(ports.setMemberSpawnStatus).toHaveBeenCalledTimes(1);
    expect(ports.setMemberSpawnStatus).toHaveBeenCalledWith(
      targetRun,
      'qa',
      'online',
      undefined,
      'heartbeat',
      expect.any(String)
    );
    expect(targetRun.memberSpawnLeadInboxCursorByMember.has('dev')).toBe(false);
    expect(targetRun.memberSpawnLeadInboxCursorByMember.get('qa')).toEqual({
      timestamp: '2026-01-01T00:01:01.000Z',
      messageId: 'qa-1',
    });
  });

  it('does not advance the cursor when the run becomes stale during status mutation', async () => {
    const targetRun = createRun();
    let current = true;
    const ports = createPorts([createMessage()]);
    ports.isCurrentTrackedRun.mockImplementation(() => current);
    ports.setMemberSpawnStatus.mockImplementation(() => {
      current = false;
    });

    await refreshMemberSpawnStatusesFromLeadInbox(targetRun, ports);

    expect(ports.setMemberSpawnStatus).toHaveBeenCalledOnce();
    expect(targetRun.memberSpawnLeadInboxCursorByMember.size).toBe(0);
  });
});

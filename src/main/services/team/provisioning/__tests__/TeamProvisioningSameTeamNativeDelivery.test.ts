import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningSameTeamNativeDeliveryPorts,
  TeamProvisioningSameTeamNativeDelivery,
  type TeamProvisioningSameTeamNativeDeliveryPorts,
} from '../TeamProvisioningSameTeamNativeDelivery';

import type { InboxMessage } from '@shared/types';
import type { ParsedTeammateContent } from '@shared/utils/teammateMessageParser';

const CONFIG = {
  fingerprintTtlMs: 60_000,
  matchWindowMs: 30_000,
  nativeDeliveryGraceMs: 15_000,
  persistRetryMs: 2_000,
};

type MarkInboxMessagesRead = TeamProvisioningSameTeamNativeDeliveryPorts['markInboxMessagesRead'];
type MarkInboxMessagesReadMock = ReturnType<typeof vi.fn> & MarkInboxMessagesRead;

function teammateBlock(overrides: Partial<ParsedTeammateContent> = {}): ParsedTeammateContent {
  return {
    teammateId: 'worker',
    content: 'Done',
    summary: 'ready',
    color: '#00f',
    ...overrides,
  };
}

function inboxMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'worker',
    to: 'lead',
    text: 'Done',
    summary: 'ready',
    timestamp: new Date(1_000).toISOString(),
    read: false,
    messageId: 'msg-1',
    ...overrides,
  };
}

function createHarness(
  options: {
    nowMs?: () => number;
    markInboxMessagesRead?: ReturnType<typeof vi.fn>;
    inboxMessages?: InboxMessage[];
  } = {}
) {
  const pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  const relayedLeadInboxMessageIds = new Map<string, Set<string>>();
  const relayLeadInboxMessages = vi.fn().mockResolvedValue(undefined);
  const markInboxMessagesRead = (options.markInboxMessagesRead ??
    vi.fn().mockResolvedValue(undefined)) as MarkInboxMessagesReadMock;
  const scheduled: Array<{ handler: () => void; ms: number }> = [];
  const service = new TeamProvisioningSameTeamNativeDelivery(
    CONFIG,
    createTeamProvisioningSameTeamNativeDeliveryPorts({
      inboxReader: {
        getMessagesFor: vi.fn().mockResolvedValue(options.inboxMessages ?? []),
      },
      relayedLeadInboxMessageIds,
      pendingTimeouts,
      markInboxMessagesRead,
      relayLeadInboxMessages,
      trimRelayedSet: (set) => set,
      warn: vi.fn(),
      nowMs: options.nowMs ?? (() => 1_000),
      randomId: vi
        .fn()
        .mockReturnValueOnce('fp-1')
        .mockReturnValueOnce('fp-2')
        .mockReturnValue('fp-next'),
      setTimeout: ((handler: () => void, ms: number) => {
        scheduled.push({ handler, ms });
        return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
    })
  );

  return {
    service,
    pendingTimeouts,
    relayedLeadInboxMessageIds,
    relayLeadInboxMessages,
    markInboxMessagesRead,
    scheduled,
  };
}

describe('TeamProvisioningSameTeamNativeDelivery', () => {
  it('remembers normalized same-team fingerprints and drops expired entries', () => {
    let now = 1_000;
    const { service } = createHarness({ nowMs: () => now });

    service.rememberSameTeamNativeFingerprints(' alpha ', [
      teammateBlock({ teammateId: ' worker ', content: ' Done\r\nnow ', summary: ' ready ' }),
    ]);

    now = 62_000;
    service.rememberSameTeamNativeFingerprints('alpha', [
      teammateBlock({ content: 'Fresh', summary: 'next' }),
    ]);

    expect(service.getFreshSameTeamNativeFingerprints('alpha')).toEqual([
      {
        id: 'fp-2',
        from: 'worker',
        text: 'Fresh',
        summary: 'next',
        seenAt: 62_000,
      },
    ]);
  });

  it('persists confirmed native matches, marks them relayed, and consumes fingerprints', async () => {
    const { service, markInboxMessagesRead, relayedLeadInboxMessageIds } = createHarness();
    service.rememberSameTeamNativeFingerprints('alpha', [teammateBlock()]);

    const result = await service.confirmSameTeamNativeMatches('alpha', 'lead', [inboxMessage()]);

    expect([...result.nativeMatchedMessageIds]).toEqual(['msg-1']);
    expect(result.persisted).toBe(true);
    expect(markInboxMessagesRead).toHaveBeenCalledWith('alpha', 'lead', [{ messageId: 'msg-1' }]);
    expect(relayedLeadInboxMessageIds.get('alpha')?.has('msg-1')).toBe(true);
    expect(service.getFreshSameTeamNativeFingerprints('alpha')).toEqual([]);
  });

  it('keeps fingerprints and schedules persist retry when marking confirmed matches read fails', async () => {
    const { service, markInboxMessagesRead, pendingTimeouts, relayLeadInboxMessages, scheduled } =
      createHarness({
        markInboxMessagesRead: vi.fn().mockRejectedValue(new Error('write failed')),
        inboxMessages: [inboxMessage()],
      });
    service.rememberSameTeamNativeFingerprints('alpha', [teammateBlock()]);

    await service.reconcileSameTeamNativeDeliveries('alpha', 'lead');

    expect(markInboxMessagesRead).toHaveBeenCalledWith('alpha', 'lead', [{ messageId: 'msg-1' }]);
    expect(service.getFreshSameTeamNativeFingerprints('alpha')).toHaveLength(1);
    expect(pendingTimeouts.has('same-team-persist:alpha')).toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(CONFIG.persistRetryMs);

    scheduled[0]?.handler();

    expect(pendingTimeouts.has('same-team-persist:alpha')).toBe(false);
    expect(relayLeadInboxMessages).toHaveBeenCalledWith('alpha');
  });

  it('schedules one deferred retry with the native delivery grace delay', () => {
    const { service, pendingTimeouts, scheduled } = createHarness();

    service.scheduleSameTeamDeferredRetry('alpha');
    service.scheduleSameTeamDeferredRetry('alpha');

    expect(pendingTimeouts.has('same-team-deferred:alpha')).toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(CONFIG.nativeDeliveryGraceMs + 1_000);
  });
});

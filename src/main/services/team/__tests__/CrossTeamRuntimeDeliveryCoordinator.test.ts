import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  type CrossTeamOutboxMessage,
  CrossTeamRuntimeDeliveryIdempotencyConflictError,
  type CrossTeamRuntimeDeliveryReceiptStatus,
} from '../CrossTeamOutbox';
import {
  CrossTeamRuntimeDeliveryCoordinator,
  type CrossTeamRuntimeDeliveryInput,
  type CrossTeamRuntimeDeliveryMessagingPort,
  type CrossTeamRuntimeDeliveryOutboxPort,
} from '../CrossTeamRuntimeDeliveryCoordinator';

import type { TeamCrossTeamMessagingApi } from '../contracts/TeamProvisioningMessagingApis';

type RelayResult = Awaited<ReturnType<TeamCrossTeamMessagingApi['relayInboxFileToLiveRecipient']>>;

const ACCEPTED_AT = '2026-07-29T12:00:01.000Z';

function runtimeMessage(
  overrides: Partial<CrossTeamOutboxMessage> = {}
): CrossTeamOutboxMessage & { toMember: string; conversationId: string } {
  return {
    messageId: 'runtime-message-1',
    fromTeam: 'source-team',
    fromMember: 'team-lead',
    toTeam: 'target-team',
    toMember: 'Worker',
    conversationId: 'runtime-key-1',
    text: 'Deliver this runtime payload',
    summary: 'Runtime delivery',
    chainDepth: 0,
    timestamp: '2026-07-29T12:00:00.000Z',
    ...overrides,
  };
}

function createHarness(
  options: {
    relay?: RelayResult;
    duplicate?: CrossTeamOutboxMessage | null;
    appendError?: Error;
  } = {}
): {
  appendIfNotRecent: Mock<CrossTeamRuntimeDeliveryOutboxPort['appendIfNotRecent']>;
  appendSenderCopy: Mock<CrossTeamRuntimeDeliveryInput['appendSenderCopy']>;
  appendToInbox: Mock<CrossTeamRuntimeDeliveryInput['appendToInbox']>;
  coordinator: CrossTeamRuntimeDeliveryCoordinator;
  input: CrossTeamRuntimeDeliveryInput;
  markRuntimeDeliveryAccepted: Mock<
    CrossTeamRuntimeDeliveryOutboxPort['markRuntimeDeliveryAccepted']
  >;
  relayInboxFileToLiveRecipient: Mock<
    CrossTeamRuntimeDeliveryMessagingPort['relayInboxFileToLiveRecipient']
  >;
} {
  const relay =
    options.relay ??
    ({
      kind: 'native_lead',
      relayed: 1,
      recentlyDeliveredMessageId: 'runtime-message-1',
    } satisfies RelayResult);
  const appendToInbox = vi.fn(async () => undefined);
  const appendSenderCopy = vi.fn();
  const appendIfNotRecent = vi.fn<CrossTeamRuntimeDeliveryOutboxPort['appendIfNotRecent']>(
    async (_teamName, _message, onBeforeAppend) => {
      if (options.appendError) {
        throw options.appendError;
      }
      if (options.duplicate) {
        return { duplicate: options.duplicate };
      }
      await onBeforeAppend();
      return { duplicate: null };
    }
  );
  const markRuntimeDeliveryAccepted = vi.fn<
    CrossTeamRuntimeDeliveryOutboxPort['markRuntimeDeliveryAccepted']
  >(async () => undefined);
  const relayInboxFileToLiveRecipient = vi.fn<
    CrossTeamRuntimeDeliveryMessagingPort['relayInboxFileToLiveRecipient']
  >(async () => relay);
  const coordinator = new CrossTeamRuntimeDeliveryCoordinator(
    { relayInboxFileToLiveRecipient },
    { appendIfNotRecent, markRuntimeDeliveryAccepted },
    () => ACCEPTED_AT
  );
  const input: CrossTeamRuntimeDeliveryInput = {
    fromTeam: 'source-team',
    targetMemberName: 'Worker',
    outboxMessage: runtimeMessage(),
    requireRuntimeDelivery: true,
    stableDedupeIdentity: true,
    timestampWasProvided: true,
    callerMessageId: 'runtime-message-1',
    legacyToMember: 'team-lead',
    appendToInbox,
    appendSenderCopy,
  };

  return {
    appendIfNotRecent,
    appendSenderCopy,
    appendToInbox,
    coordinator,
    input,
    markRuntimeDeliveryAccepted,
    relayInboxFileToLiveRecipient,
  };
}

describe('CrossTeamRuntimeDeliveryCoordinator', () => {
  it.each([
    {
      name: 'native lead recent-delivery id',
      relay: {
        kind: 'native_lead',
        relayed: 0,
        recentlyDeliveredMessageId: 'runtime-message-1',
      } satisfies RelayResult,
    },
    {
      name: 'native member durable-inbox id',
      relay: {
        kind: 'native_member_noop',
        relayed: 0,
        durablyStoredMessageId: 'runtime-message-1',
      } satisfies RelayResult,
    },
  ])('accepts exact $name proof', async ({ relay }) => {
    const harness = createHarness({ relay });

    await expect(harness.coordinator.coordinate(harness.input)).resolves.toMatchObject({
      deliveredToInbox: true,
      messageId: 'runtime-message-1',
      toMember: 'Worker',
    });

    expect(harness.relayInboxFileToLiveRecipient).toHaveBeenCalledWith('target-team', 'Worker', {
      onlyMessageId: 'runtime-message-1',
    });
    expect(harness.markRuntimeDeliveryAccepted).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'accepted',
      relay: {
        kind: 'opencode_member',
        relayed: 0,
        lastDelivery: {
          delivered: true,
          accepted: true,
          responsePending: true,
        },
      } satisfies RelayResult,
      accepted: true,
    },
    {
      name: 'acceptance unknown',
      relay: {
        kind: 'opencode_member',
        relayed: 0,
        lastDelivery: {
          delivered: true,
          accepted: true,
          acceptanceUnknown: true,
          reason: 'provider acceptance is unknown',
        },
      } satisfies RelayResult,
      accepted: false,
    },
    {
      name: 'queued behind another message',
      relay: {
        kind: 'opencode_member',
        relayed: 0,
        lastDelivery: {
          delivered: true,
          accepted: true,
          queuedBehindMessageId: 'runtime-message-0',
          reason: 'provider delivery remains queued',
        },
      } satisfies RelayResult,
      accepted: false,
    },
  ])('settles an $name provider result', async ({ relay, accepted }) => {
    const harness = createHarness({ relay });
    const promise = harness.coordinator.coordinate(harness.input);

    if (accepted) {
      await expect(promise).resolves.toMatchObject({ deliveredToInbox: true });
      expect(harness.markRuntimeDeliveryAccepted).toHaveBeenCalledOnce();
      expect(harness.appendSenderCopy).toHaveBeenCalledOnce();
    } else {
      await expect(promise).rejects.toThrow(relay.lastDelivery?.reason);
      expect(harness.markRuntimeDeliveryAccepted).not.toHaveBeenCalled();
      expect(harness.appendSenderCopy).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      name: 'provider reason',
      relay: {
        kind: 'opencode_member',
        relayed: 0,
        diagnostics: ['relay diagnostic'],
        lastDelivery: { delivered: false, reason: 'provider reason' },
      } satisfies RelayResult,
      diagnostic: 'provider reason',
    },
    {
      name: 'relay diagnostic',
      relay: {
        kind: 'ignored',
        relayed: 0,
        diagnostics: ['', 'relay diagnostic'],
      } satisfies RelayResult,
      diagnostic: 'relay diagnostic',
    },
    {
      name: 'provider result fallback',
      relay: {
        kind: 'native_member_noop',
        relayed: 0,
      } satisfies RelayResult,
      diagnostic: 'relay kind native_member_noop relayed 0',
    },
  ])('reports $name when runtime proof is absent', async ({ relay, diagnostic }) => {
    const harness = createHarness({ relay });

    await expect(harness.coordinator.coordinate(harness.input)).rejects.toThrow(diagnostic);
  });

  it.each([
    {
      name: 'without a receipt',
      receipt: undefined,
      expectedRelayCalls: 1,
      expectedMarkCalls: 1,
    },
    {
      name: 'with a receipt',
      receipt: ACCEPTED_AT,
      expectedRelayCalls: 0,
      expectedMarkCalls: 0,
    },
  ])('settles a duplicate $name', async ({ receipt, expectedRelayCalls, expectedMarkCalls }) => {
    const duplicate = runtimeMessage({
      messageId: 'persisted-message-1',
      runtimeDeliveryAcceptedAt: receipt,
    });
    const relay = {
      kind: 'native_member_noop',
      relayed: 0,
      durablyStoredMessageId: 'persisted-message-1',
    } satisfies RelayResult;
    const harness = createHarness({ duplicate, relay });

    await expect(harness.coordinator.coordinate(harness.input)).resolves.toMatchObject({
      messageId: 'persisted-message-1',
      deduplicated: true,
    });

    expect(harness.appendToInbox).not.toHaveBeenCalled();
    expect(harness.relayInboxFileToLiveRecipient).toHaveBeenCalledTimes(expectedRelayCalls);
    expect(harness.markRuntimeDeliveryAccepted).toHaveBeenCalledTimes(expectedMarkCalls);
    expect(harness.appendSenderCopy).toHaveBeenCalledOnce();
    expect(harness.appendSenderCopy).toHaveBeenCalledWith(duplicate);
  });

  it.each([
    {
      name: 'valid receipt',
      receiptStatus: 'valid' as CrossTeamRuntimeDeliveryReceiptStatus,
      expectedMessage: 'different payload',
      expectedCode: 'idempotency_conflict',
    },
    {
      name: 'missing receipt',
      receiptStatus: 'missing' as CrossTeamRuntimeDeliveryReceiptStatus,
      expectedMessage: 'receipt proof is missing or corrupt',
      expectedCode: undefined,
    },
  ])(
    'rejects a divergent stable-id conflict with a $name',
    async ({ receiptStatus, expectedMessage, expectedCode }) => {
      const conflict = new CrossTeamRuntimeDeliveryIdempotencyConflictError(
        runtimeMessage(),
        receiptStatus
      );
      const harness = createHarness({ appendError: conflict });
      harness.input.outboxMessage = runtimeMessage({ text: 'Divergent payload' });

      const error: unknown = await harness.coordinator
        .coordinate(harness.input)
        .catch((candidate: unknown) => candidate);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(expectedMessage);
      if (expectedCode) {
        expect(error).toMatchObject({ code: expectedCode });
      } else {
        expect(error).not.toMatchObject({ code: 'idempotency_conflict' });
      }
      expect(harness.markRuntimeDeliveryAccepted).not.toHaveBeenCalled();
      expect(harness.appendSenderCopy).not.toHaveBeenCalled();
    }
  );

  it('settles an equivalent generated-timestamp retry instead of rejecting the conflict', async () => {
    const existing = runtimeMessage({ timestamp: '2026-07-29T11:59:00.000Z' });
    const conflict = new CrossTeamRuntimeDeliveryIdempotencyConflictError(existing, 'missing');
    const harness = createHarness({ appendError: conflict });
    harness.input.timestampWasProvided = false;

    await expect(harness.coordinator.coordinate(harness.input)).resolves.toMatchObject({
      messageId: existing.messageId,
      deduplicated: true,
    });
    expect(harness.markRuntimeDeliveryAccepted).toHaveBeenCalledOnce();
    expect(harness.appendSenderCopy).toHaveBeenCalledWith(existing);
  });

  it('marks one durable receipt before invoking the sender-copy callback', async () => {
    const order: string[] = [];
    const harness = createHarness();
    harness.markRuntimeDeliveryAccepted.mockImplementation(async () => {
      order.push('mark-receipt');
    });
    harness.appendSenderCopy.mockImplementation(() => {
      order.push('sender-copy');
    });

    await harness.coordinator.coordinate(harness.input);

    expect(harness.markRuntimeDeliveryAccepted).toHaveBeenCalledOnce();
    expect(harness.appendSenderCopy).toHaveBeenCalledOnce();
    expect(order).toEqual(['mark-receipt', 'sender-copy']);
  });

  it('shares concurrent settlement so the durable receipt is marked exactly once', async () => {
    let releaseRelay: (() => void) | undefined;
    const relayPending = new Promise<void>((resolve) => {
      releaseRelay = resolve;
    });
    const harness = createHarness();
    harness.relayInboxFileToLiveRecipient.mockImplementation(async () => {
      await relayPending;
      return {
        kind: 'native_lead',
        relayed: 1,
        recentlyDeliveredMessageId: 'runtime-message-1',
      };
    });

    const first = harness.coordinator.coordinate(harness.input);
    const second = harness.coordinator.coordinate(harness.input);
    await vi.waitFor(() => {
      expect(harness.relayInboxFileToLiveRecipient).toHaveBeenCalledOnce();
    });
    releaseRelay?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(harness.markRuntimeDeliveryAccepted).toHaveBeenCalledOnce();
  });

  it.each([
    { duplicate: false, expectedSenderCopies: 1 },
    { duplicate: true, expectedSenderCopies: 0 },
  ])(
    'invokes the non-runtime sender-copy callback $expectedSenderCopies time(s) when duplicate=$duplicate',
    async ({ duplicate, expectedSenderCopies }) => {
      const harness = createHarness({
        ...(duplicate ? { duplicate: runtimeMessage() } : {}),
      });
      harness.input.requireRuntimeDelivery = false;
      harness.input.stableDedupeIdentity = false;

      await harness.coordinator.coordinate(harness.input);

      expect(harness.appendSenderCopy).toHaveBeenCalledTimes(expectedSenderCopies);
      expect(harness.relayInboxFileToLiveRecipient).not.toHaveBeenCalled();
      expect(harness.markRuntimeDeliveryAccepted).not.toHaveBeenCalled();
    }
  );
});

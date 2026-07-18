import { TeamInboxRuntimeRecoveryDeliveryAdapter } from '@features/team-runtime-recovery/main';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeRecoveryJob } from '@features/team-runtime-recovery/core/application';
import type { InboxMessage, SendMessageRequest } from '@shared/types';

function makeJob(): RuntimeRecoveryJob {
  return {
    id: 'runtime-recovery-job-1',
    signal: {
      id: 'failure-1',
      source: 'agent_error_mailbox',
      phase: 'terminal',
      observedAt: '2026-07-16T10:00:00.000Z',
      contextId: 'local',
      teamName: 'sandbox-team',
      memberName: 'bob',
      targetKind: 'member',
      detail: 'API Error: 529',
      taskRefs: [{ taskId: 'task-123456789' }],
    },
    reasonCode: 'provider_overloaded',
    normalizedDetailHash: 'failure-hash',
    circuitKey: 'circuit',
    status: 'claimed',
    attempt: 0,
    nextAttemptAt: '2026-07-16T10:01:00.000Z',
    expiresAt: '2026-07-16T12:00:00.000Z',
    createdAt: '2026-07-16T10:00:00.000Z',
    updatedAt: '2026-07-16T10:01:00.000Z',
  };
}

function makeAdapter(input?: {
  existing?: InboxMessage[];
  relayKind?: 'native_member_noop' | 'native_lead' | 'opencode_member';
}) {
  const messages = [...(input?.existing ?? [])];
  const sendMessage = vi.fn(async (_teamName: string, request: SendMessageRequest) => {
    messages.push({
      from: request.from ?? 'user',
      to: request.member,
      text: request.text,
      timestamp: request.timestamp ?? new Date().toISOString(),
      read: false,
      messageId: request.messageId,
      messageKind: request.messageKind,
      runtimeRecovery: request.runtimeRecovery,
      taskRefs: request.taskRefs,
    });
    return { deliveredToInbox: true, messageId: request.messageId! };
  });
  const relay = vi.fn(async () => ({
    kind: input?.relayKind ?? ('native_member_noop' as const),
    relayed: input?.relayKind === 'native_lead' ? 1 : 0,
    ...(input?.relayKind === 'opencode_member' || input?.relayKind === 'native_lead'
      ? {
          lastDelivery: {
            delivered: true,
            accepted: true,
            responsePending: false,
            reason: undefined as string | undefined,
            ...(input?.relayKind === 'opencode_member'
              ? { responseState: 'responded_plain_text' }
              : {}),
          },
        }
      : {}),
  }));
  return {
    messages,
    sendMessage,
    relay,
    adapter: new TeamInboxRuntimeRecoveryDeliveryAdapter({
      inboxReader: { getMessagesFor: async () => messages },
      inboxWriter: { sendMessage },
      relay,
      getLeadName: async () => 'team-lead',
    }),
  };
}

describe('TeamInboxRuntimeRecoveryDeliveryAdapter', () => {
  it('writes a stable hidden recovery nudge before provider-aware relay', async () => {
    const { adapter, messages, relay } = makeAdapter();

    const result = await adapter.deliver({
      job: makeJob(),
      memberName: 'bob',
      text: 'Inspect state, then continue only missing work.',
      payloadHash: 'payload-hash',
      reasonCode: 'provider_overloaded',
    });

    expect(result).toMatchObject({ ok: true, accepted: false });
    expect(messages[0]).toMatchObject({
      messageId: 'runtime-recovery-job-1-attempt-1',
      messageKind: 'runtime_recovery_nudge',
      runtimeRecovery: {
        recoveryId: 'runtime-recovery-job-1',
        payloadHash: 'payload-hash',
      },
      taskRefs: [{ taskId: 'task-123456789', displayId: 'task-123', teamName: 'sandbox-team' }],
    });
    expect(relay).toHaveBeenCalledWith('sandbox-team', 'bob', {
      source: 'manual',
      onlyMessageId: 'runtime-recovery-job-1-attempt-1',
    });
  });

  it('rejects a stable message id with a different payload hash', async () => {
    const job = makeJob();
    const { adapter, sendMessage } = makeAdapter({
      existing: [
        {
          from: 'system',
          to: 'bob',
          text: 'different payload',
          timestamp: '2026-07-16T10:01:00.000Z',
          read: false,
          messageId: `${job.id}-attempt-1`,
          messageKind: 'runtime_recovery_nudge',
          runtimeRecovery: {
            schemaVersion: 1,
            recoveryId: job.id,
            sourceFailureId: job.signal.id,
            attempt: 1,
            reasonCode: 'provider_overloaded',
            payloadHash: 'other-hash',
          },
        },
      ],
    });

    await expect(
      adapter.deliver({
        job,
        memberName: 'bob',
        text: 'new payload',
        payloadHash: 'expected-hash',
        reasonCode: 'provider_overloaded',
      })
    ).resolves.toEqual({ ok: false, retryable: false, reason: 'inbox_payload_conflict' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(['native_lead', 'opencode_member'] as const)(
    'recognizes response proof from %s delivery',
    async (relayKind) => {
      const job = makeJob();
      job.signal.targetKind = relayKind === 'native_lead' ? 'lead' : 'member';
      const { adapter } = makeAdapter({ relayKind });

      const result = await adapter.deliver({
        job,
        memberName: relayKind === 'native_lead' ? 'team-lead' : 'bob',
        text: 'continue safely',
        payloadHash: 'hash',
        reasonCode: 'provider_overloaded',
      });

      expect(result).toMatchObject({ ok: true, accepted: true, responseProven: true });
    }
  );

  it('does not treat native lead stdin acceptance as outcome proof', async () => {
    const job = makeJob();
    job.signal.targetKind = 'lead';
    const { adapter, relay } = makeAdapter({ relayKind: 'native_lead' });
    relay.mockResolvedValueOnce({
      kind: 'native_lead',
      relayed: 1,
      lastDelivery: {
        delivered: true,
        accepted: true,
        responsePending: true,
        reason: undefined,
      },
    });

    await expect(
      adapter.deliver({
        job,
        memberName: 'team-lead',
        text: 'continue safely',
        payloadHash: 'hash',
        reasonCode: 'provider_overloaded',
      })
    ).resolves.toMatchObject({ ok: true, accepted: true, responseProven: false });
  });

  it('does not treat an OpenCode terminal error state as response proof', async () => {
    const { adapter, relay } = makeAdapter({ relayKind: 'opencode_member' });
    relay.mockResolvedValueOnce({
      kind: 'opencode_member',
      relayed: 1,
      lastDelivery: {
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'session_error',
        reason: 'API Error: 529 overloaded_error',
      },
    });

    await expect(
      adapter.deliver({
        job: makeJob(),
        memberName: 'bob',
        text: 'continue safely',
        payloadHash: 'hash',
        reasonCode: 'provider_overloaded',
      })
    ).resolves.toMatchObject({ ok: true, accepted: true, responseProven: false });
  });

  it.each(['read', 'write'] as const)(
    'turns an inbox %s exception into a retryable infrastructure result',
    async (failurePoint) => {
      const adapter = new TeamInboxRuntimeRecoveryDeliveryAdapter({
        inboxReader: {
          getMessagesFor: async () => {
            if (failurePoint === 'read') throw new Error('temporary read failure');
            return [];
          },
        },
        inboxWriter: {
          sendMessage: async () => {
            throw new Error('temporary write failure');
          },
        },
        relay: async () => ({ kind: 'native_member_noop', relayed: 0 }),
        getLeadName: async () => 'team-lead',
      });

      await expect(
        adapter.deliver({
          job: makeJob(),
          memberName: 'bob',
          text: 'continue safely',
          payloadHash: 'hash',
          reasonCode: 'provider_overloaded',
        })
      ).resolves.toEqual({
        ok: false,
        retryable: true,
        reason: 'delivery_infrastructure_error',
      });
    }
  );
});

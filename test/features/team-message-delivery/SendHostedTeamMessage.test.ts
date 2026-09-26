import {
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  parseHostedClientMessageId,
  parseHostedMessageId,
} from '@features/team-message-delivery/contracts/hosted';
import { SendHostedTeamMessage } from '@features/team-message-delivery/core/application/use-cases/SendHostedTeamMessage';
import { createQueryContext, parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { HostedTeamMessageSendPort } from '@features/team-message-delivery/core/application/ports/HostedTeamMessagePorts';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const messageId = parseHostedMessageId(`message_${'b'.repeat(32)}`);
const clientMessageId = parseHostedClientMessageId('client_message_send-0001');
const command = Object.freeze({
  schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  teamId,
  clientMessageId,
  text: 'Please continue.',
});

function context() {
  return createQueryContext({
    actorId: 'actor_message-send',
    sessionId: 'session_message-send',
    deploymentId: 'deployment_message-send',
    bootId: 'boot_message-send',
    requestId: 'request_message-send',
    authorizedScope: 'scope_message-send',
    deadlineAtMs: 10_000,
    signal: new AbortController().signal,
  });
}

function receipt(runtimeDelivery: 'delivered' | 'pending' | 'operator_required' = 'delivered') {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
    teamId,
    messageId,
    clientMessageId,
    persistence: 'durable' as const,
    runtimeDelivery,
  });
}

describe('SendHostedTeamMessage', () => {
  it('sends once and reports durable persistence and runtime delivery separately, replay included', async () => {
    const send = vi
      .fn<HostedTeamMessageSendPort['send']>()
      .mockResolvedValueOnce({ kind: 'persisted', receipt: receipt('pending') })
      .mockResolvedValueOnce({ kind: 'idempotent_replay', receipt: receipt('delivered') });
    const useCase = new SendHostedTeamMessage({ send });

    await expect(useCase.execute(command, context())).resolves.toEqual({
      kind: 'persisted',
      receipt: receipt('pending'),
    });
    // A retry replays the stored message and reports the delivery state the owner recorded.
    await expect(useCase.execute(command, context())).resolves.toEqual({
      kind: 'idempotent_replay',
      receipt: receipt('delivered'),
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(command, expect.any(Object));
  });

  it('rejects a recipient outside the owner roster and never trusts an unasked rejection', async () => {
    const send = vi.fn<HostedTeamMessageSendPort['send']>(() =>
      Promise.resolve({ kind: 'invalid_recipient' })
    );
    const useCase = new SendHostedTeamMessage({ send });

    await expect(useCase.execute({ ...command, recipient: 'mallory' }, context())).resolves.toEqual(
      { kind: 'invalid_request' }
    );
    expect(send).toHaveBeenCalledWith({ ...command, recipient: 'mallory' }, expect.any(Object));
    // A lead send cannot be rejected for a recipient it never named.
    await expect(useCase.execute(command, context())).resolves.toEqual({ kind: 'unavailable' });
  });

  it('rejects malformed input and malformed owner results and never leaks detail', async () => {
    const { runtimeDelivery: _missing, ...withoutDelivery } = receipt();
    const send = vi
      .fn<HostedTeamMessageSendPort['send']>()
      .mockResolvedValueOnce({ kind: 'persisted', receipt: { ...receipt(), bad: true } as never })
      .mockResolvedValueOnce({ kind: 'persisted', receipt: withoutDelivery as never })
      .mockResolvedValueOnce({
        kind: 'persisted',
        receipt: { ...receipt(), runtimeDelivery: 'sent' } as never,
      })
      .mockRejectedValueOnce(new Error('provider token at private path'));
    const useCase = new SendHostedTeamMessage({ send });

    await expect(
      useCase.execute({ ...command, authorId: 'member_private' }, context())
    ).resolves.toEqual({ kind: 'invalid_request' });
    expect(send).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await useCase.execute(command, context());
      expect(result).toEqual({ kind: 'unavailable' });
      expect(JSON.stringify(result)).not.toMatch(/provider|token|private|path/);
    }
  });

  it('passes through a stable idempotency conflict', async () => {
    const useCase = new SendHostedTeamMessage({
      send: () => Promise.resolve({ kind: 'conflict' as const, reason: 'idempotency_mismatch' }),
    });
    await expect(useCase.execute(command, context())).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
  });
});

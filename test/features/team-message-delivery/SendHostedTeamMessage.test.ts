import {
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  parseHostedClientMessageId,
  parseHostedMessageId,
} from '@features/team-message-delivery/contracts/hosted';
import { SendHostedTeamMessage } from '@features/team-message-delivery/core/application/use-cases/SendHostedTeamMessage';
import { createQueryContext, parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type {
  HostedTeamMessagePersistencePort,
  HostedTeamMessageRuntimeDeliveryPort,
} from '@features/team-message-delivery/core/application/ports/HostedTeamMessagePorts';

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

function receipt() {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
    teamId,
    messageId,
    clientMessageId,
    persistence: 'durable' as const,
  });
}

describe('SendHostedTeamMessage', () => {
  it('persists before requesting runtime delivery and reports the two outcomes separately', async () => {
    const calls: string[] = [];
    const persist = vi.fn(() => {
      calls.push('persist');
      return Promise.resolve({ kind: 'persisted' as const, receipt: receipt() });
    });
    const deliver = vi.fn(() => {
      calls.push('deliver');
      return Promise.resolve({ kind: 'delivered' as const });
    });
    const useCase = new SendHostedTeamMessage({ persist }, { deliver });

    await expect(useCase.execute(command, context())).resolves.toEqual({
      kind: 'persisted',
      receipt: { ...receipt(), runtimeDelivery: 'delivered' },
    });
    expect(calls).toEqual(['persist', 'deliver']);
    expect(deliver).toHaveBeenCalledWith(
      {
        teamId,
        messageId,
        clientMessageId,
        text: command.text,
      },
      expect.any(Object)
    );
  });

  it('keeps an ambiguous runtime delivery stable across an idempotent replay', async () => {
    const persist = vi
      .fn<HostedTeamMessagePersistencePort['persist']>()
      .mockResolvedValueOnce({ kind: 'persisted', receipt: receipt() })
      .mockResolvedValueOnce({ kind: 'idempotent_replay', receipt: receipt() });
    const deliver = vi
      .fn<HostedTeamMessageRuntimeDeliveryPort['deliver']>()
      .mockResolvedValue({ kind: 'operator_required' });
    const useCase = new SendHostedTeamMessage({ persist }, { deliver });

    await expect(useCase.execute(command, context())).resolves.toMatchObject({
      kind: 'persisted',
      receipt: { persistence: 'durable', runtimeDelivery: 'operator_required' },
    });
    await expect(useCase.execute(command, context())).resolves.toMatchObject({
      kind: 'idempotent_replay',
      receipt: { persistence: 'durable', runtimeDelivery: 'operator_required' },
    });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('contains post-effect runtime failure as operator-required and never leaks detail', async () => {
    const useCase = new SendHostedTeamMessage(
      { persist: () => Promise.resolve({ kind: 'persisted' as const, receipt: receipt() }) },
      { deliver: () => Promise.reject(new Error('provider token at private path')) }
    );

    const result = await useCase.execute(command, context());
    expect(result).toEqual({
      kind: 'persisted',
      receipt: { ...receipt(), runtimeDelivery: 'operator_required' },
    });
    expect(JSON.stringify(result)).not.toMatch(/provider|token|private|path/);
  });

  it('rejects malformed input and malformed persistence results before delivery', async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'persisted' as const, receipt: { ...receipt(), bad: true } })
      .mockResolvedValueOnce({
        kind: 'persisted' as const,
        receipt: receipt(),
        sourcePath: '/private',
      });
    const deliver = vi.fn();
    const useCase = new SendHostedTeamMessage({ persist }, { deliver });

    await expect(
      useCase.execute({ ...command, authorId: 'member_private' }, context())
    ).resolves.toEqual({ kind: 'invalid_request' });
    expect(persist).not.toHaveBeenCalled();

    await expect(useCase.execute(command, context())).resolves.toEqual({ kind: 'unavailable' });
    expect(deliver).not.toHaveBeenCalled();

    await expect(useCase.execute(command, context())).resolves.toEqual({ kind: 'unavailable' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('passes through a stable idempotency conflict without attempting delivery', async () => {
    const deliver = vi.fn();
    const useCase = new SendHostedTeamMessage(
      {
        persist: () =>
          Promise.resolve({ kind: 'conflict' as const, reason: 'idempotency_mismatch' }),
      },
      { deliver }
    );
    await expect(useCase.execute(command, context())).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    expect(deliver).not.toHaveBeenCalled();
  });
});

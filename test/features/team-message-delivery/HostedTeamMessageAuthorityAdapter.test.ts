import {
  parseHostedClientMessageId,
  parseHostedMessageId,
  parseHostedMessageSourceGeneration,
} from '@features/team-message-delivery/contracts/hosted';
import {
  HostedTeamMessageAuthorityAdapter,
  type HostedTeamMessageAuthorityPort,
} from '@features/team-message-delivery/main/hosted';
import {
  createQueryContext,
  parseCursor,
  parseRevision,
  parseTeamId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const messageId = parseHostedMessageId(`message_${'b'.repeat(32)}`);
const nextMessageId = parseHostedMessageId(`message_${'c'.repeat(32)}`);
const clientMessageId = parseHostedClientMessageId('client_message_authority-1');
const sourceGeneration = parseHostedMessageSourceGeneration('generation_authority-1');
const revision = parseRevision('revision_authority-1');

function context() {
  return createQueryContext({
    actorId: 'actor_message-authority',
    sessionId: 'session_message-authority',
    deploymentId: 'deployment_message-authority',
    bootId: 'boot_message-authority',
    requestId: 'request_message-authority',
    authorizedScope: 'scope_message-authority',
    deadlineAtMs: 1_000,
    signal: new AbortController().signal,
  });
}

function command() {
  return { schemaVersion: 1 as const, teamId, clientMessageId, text: 'Saved message' };
}

function authority(): HostedTeamMessageAuthorityPort {
  return {
    readWindow: vi.fn(() =>
      Promise.resolve({
        kind: 'found' as const,
        teamId,
        sourceGeneration,
        revision,
        messages: [
          {
            teamId,
            messageId: nextMessageId,
            direction: 'operator' as const,
            text: 'Saved message',
            createdAtMs: 1,
          },
        ],
        hasMore: false,
      })
    ),
    persistMessage: vi.fn(() =>
      Promise.resolve({
        kind: 'persisted' as const,
        receipt: {
          schemaVersion: 1 as const,
          teamId,
          messageId,
          clientMessageId,
          persistence: 'durable' as const,
        },
      })
    ),
    deliverPersistedMessage: vi.fn(() => Promise.resolve({ kind: 'delivered' as const })),
  };
}

describe('HostedTeamMessageAuthorityAdapter', () => {
  it('maps an opaque cursor to the narrow authority read window and preserves its order', async () => {
    const trusted = authority();
    const adapter = new HostedTeamMessageAuthorityAdapter(trusted, () => 10);
    const queryContext = context();
    const cursor = parseCursor(`cursor_${messageId}`);

    const result = await adapter.readPage(
      {
        teamId,
        cursor,
        expectedSourceGeneration: sourceGeneration,
        itemLimit: 2,
        deadlineAtMs: queryContext.deadlineAtMs,
      },
      queryContext
    );

    expect(result).toMatchObject({
      kind: 'found',
      candidates: [{ message: { messageId: nextMessageId } }],
    });
    expect(trusted.readWindow).toHaveBeenCalledWith(
      {
        teamId,
        afterMessageId: messageId,
        expectedSourceGeneration: sourceGeneration,
        itemLimit: 2,
        deadlineAtMs: queryContext.deadlineAtMs,
      },
      queryContext
    );
  });

  it('maps persistence and runtime requests through the same authority instance', async () => {
    const trusted = authority();
    const adapter = new HostedTeamMessageAuthorityAdapter(trusted, () => 10);
    const queryContext = context();

    await expect(adapter.persist(command(), queryContext)).resolves.toEqual({
      kind: 'persisted',
      receipt: { schemaVersion: 1, teamId, messageId, clientMessageId, persistence: 'durable' },
    });
    await expect(
      adapter.deliver({ teamId, messageId, clientMessageId, text: 'Saved message' }, queryContext)
    ).resolves.toEqual({ kind: 'delivered' });
    expect(trusted.persistMessage).toHaveBeenCalledWith(command(), queryContext);
    expect(trusted.deliverPersistedMessage).toHaveBeenCalledWith(
      { teamId, messageId, clientMessageId, text: 'Saved message' },
      queryContext
    );
  });

  it('freezes an unconfirmed runtime delivery as operator-required after invoking authority', async () => {
    const trusted = authority();
    vi.mocked(trusted.deliverPersistedMessage).mockRejectedValueOnce(
      new Error('runtime delivery outcome unknown')
    );
    const adapter = new HostedTeamMessageAuthorityAdapter(trusted, () => 10);

    await expect(
      adapter.deliver({ teamId, messageId, clientMessageId, text: 'Saved message' }, context())
    ).resolves.toEqual({ kind: 'operator_required' });
    expect(trusted.deliverPersistedMessage).toHaveBeenCalledOnce();
  });

  it('fails closed on unsafe authority output instead of serializing it', async () => {
    const trusted = authority();
    vi.mocked(trusted.readWindow).mockResolvedValueOnce({
      kind: 'found',
      teamId,
      sourceGeneration,
      revision,
      messages: [
        {
          teamId,
          messageId,
          direction: 'operator',
          text: 'Saved message',
          createdAtMs: 1,
          sourcePath: '/private',
        } as never,
      ],
      hasMore: false,
    });
    const adapter = new HostedTeamMessageAuthorityAdapter(trusted, () => 10);
    const queryContext = context();

    await expect(
      adapter.readPage(
        {
          teamId,
          cursor: null,
          expectedSourceGeneration: null,
          itemLimit: 2,
          deadlineAtMs: queryContext.deadlineAtMs,
        },
        queryContext
      )
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});

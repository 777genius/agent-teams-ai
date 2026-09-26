import {
  createHostedTeamMessageOutputAdapters,
  type HostedTeamMessageAuthorityPort,
  parseHostedClientMessageId,
  parseHostedMessageId,
  parseHostedMessageSourceGeneration,
} from '@features/team-message-delivery/main/hosted';
import {
  createQueryContext,
  parseRevision,
  parseTeamId,
  type QueryContext,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const messageId = parseHostedMessageId(`message_${'b'.repeat(32)}`);
const clientMessageId = parseHostedClientMessageId('client_message_output-1');

function context(): QueryContext {
  return createQueryContext({
    actorId: 'actor_message-output',
    sessionId: 'session_message-output',
    deploymentId: 'deployment_message-output',
    bootId: 'boot_message-output',
    requestId: 'request_message-output',
    authorizedScope: 'scope_message-output',
    deadlineAtMs: Date.now() + 60_000,
    signal: new AbortController().signal,
  });
}

describe('createHostedTeamMessageOutputAdapters', () => {
  it('uses one authority adapter for the page and send ports', async () => {
    const readWindow = vi.fn(() =>
      Promise.resolve({
        kind: 'found' as const,
        teamId,
        sourceGeneration: parseHostedMessageSourceGeneration('generation_output-1'),
        revision: parseRevision('revision_output-1'),
        messages: [],
        hasMore: false,
      })
    );
    const sendMessage = vi.fn(() =>
      Promise.resolve({
        kind: 'persisted' as const,
        receipt: {
          schemaVersion: 1 as const,
          teamId,
          messageId,
          clientMessageId,
          persistence: 'durable' as const,
          runtimeDelivery: 'pending' as const,
        },
      })
    );
    const authority: HostedTeamMessageAuthorityPort = { readWindow, sendMessage };

    const adapters = createHostedTeamMessageOutputAdapters(authority);
    expect(Object.isFrozen(adapters)).toBe(true);
    expect(Reflect.ownKeys(adapters)).toEqual(['pageSource', 'sender']);
    expect(adapters.pageSource).toBe(adapters.sender);

    const queryContext = context();
    await adapters.pageSource.readPage(
      {
        teamId,
        cursor: null,
        expectedSourceGeneration: null,
        itemLimit: 2,
        deadlineAtMs: queryContext.deadlineAtMs,
      },
      queryContext
    );
    await adapters.sender.send(
      { schemaVersion: 1, teamId, clientMessageId, text: 'Saved message' },
      queryContext
    );
    expect(readWindow).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});

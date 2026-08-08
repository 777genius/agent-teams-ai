import {
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  parseHostedMessageId,
  parseHostedMessageSourceGeneration,
} from '@features/team-message-delivery/contracts/hosted';
import { GetHostedMessagePage } from '@features/team-message-delivery/core/application/use-cases/GetHostedMessagePage';
import {
  createQueryContext,
  parseCursor,
  parseRevision,
  parseTeamId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type {
  HostedMessagePageSourcePort,
  HostedMessagePageSourceResult,
} from '@features/team-message-delivery/core/application/ports/HostedTeamMessagePorts';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const revision = parseRevision('revision_page-1');
const sourceGeneration = parseHostedMessageSourceGeneration('generation_page-1');
const replacementGeneration = parseHostedMessageSourceGeneration('generation_page-replacement');

function message(index: number, text = `Message ${index}`) {
  return Object.freeze({
    teamId,
    messageId: parseHostedMessageId(`message_${index.toString(16).padStart(32, '0')}`),
    direction: index % 2 === 0 ? ('team' as const) : ('operator' as const),
    text,
    createdAtMs: index,
  });
}

function context(signal = new AbortController().signal) {
  return createQueryContext({
    actorId: 'actor_message-page',
    sessionId: 'session_message-page',
    deploymentId: 'deployment_message-page',
    bootId: 'boot_message-page',
    requestId: 'request_message-page',
    authorizedScope: 'scope_message-page',
    deadlineAtMs: 10_000,
    signal,
  });
}

function request(
  limit = 2,
  cursor: ReturnType<typeof parseCursor> | null = null,
  generation: typeof sourceGeneration | null = null
) {
  return {
    schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
    teamId,
    cursor,
    expectedSourceGeneration: generation,
    limit,
  };
}

function found(
  candidates: Extract<HostedMessagePageSourceResult, { kind: 'found' }>['candidates'],
  hasMore = false
): Extract<HostedMessagePageSourceResult, { kind: 'found' }> {
  return { kind: 'found', teamId, sourceGeneration, revision, candidates, hasMore };
}

describe('GetHostedMessagePage', () => {
  it('preserves authority cursor order across pages without sorting opaque message IDs', async () => {
    const cursorC = parseCursor('cursor_page-C');
    const cursorA = parseCursor('cursor_page-A');
    const cursorB = parseCursor('cursor_page-B');
    const source: HostedMessagePageSourcePort = {
      readPage: vi.fn((sourceRequest) =>
        Promise.resolve(
          sourceRequest.cursor === null
            ? found([
                { message: message(3), cursorAfter: cursorC },
                { message: message(1), cursorAfter: cursorA },
                { message: message(2), cursorAfter: cursorB },
              ])
            : found([{ message: message(2), cursorAfter: cursorB }])
        )
      ),
    };
    const useCase = new GetHostedMessagePage(source, { now: () => 0 });

    const first = await useCase.execute(request(), context());
    expect(first.kind).toBe('success');
    if (first.kind !== 'success') return;
    expect(first.page.messages.map((item) => item.messageId)).toEqual([
      message(3).messageId,
      message(1).messageId,
    ]);
    expect(first.page.nextCursor).toBe(cursorA);
    expect(source.readPage).toHaveBeenCalledWith(
      {
        teamId,
        cursor: null,
        expectedSourceGeneration: null,
        itemLimit: 3,
        deadlineAtMs: 250,
      },
      expect.any(Object)
    );

    const second = await useCase.execute(
      request(2, first.page.nextCursor, first.page.sourceGeneration),
      context()
    );
    expect(second).toMatchObject({ kind: 'success', page: { nextCursor: null } });
    if (second.kind === 'success') {
      expect(
        [...first.page.messages, ...second.page.messages].map((item) => item.messageId)
      ).toEqual([message(3).messageId, message(1).messageId, message(2).messageId]);
    }
  });

  it('fails closed for an invalid continuation or a replacement generation', async () => {
    const cursor = parseCursor('cursor_page-next');
    const source: HostedMessagePageSourcePort = {
      readPage: vi.fn(() =>
        Promise.resolve({
          kind: 'stale_generation' as const,
          currentSourceGeneration: replacementGeneration,
        })
      ),
    };
    const useCase = new GetHostedMessagePage(source, { now: () => 0 });

    await expect(
      useCase.execute(
        request(2, cursor, 'generation/invalid' as typeof sourceGeneration),
        context()
      )
    ).resolves.toEqual({ kind: 'invalid_request' });
    expect(source.readPage).not.toHaveBeenCalled();

    await expect(useCase.execute(request(2, cursor, sourceGeneration), context())).resolves.toEqual(
      {
        kind: 'stale_generation',
        currentSourceGeneration: replacementGeneration,
      }
    );
  });

  it('rejects duplicate cursors, empty progressing pages, and source exceptions', async () => {
    const duplicate = new GetHostedMessagePage(
      {
        readPage: () =>
          Promise.resolve(
            found([
              { message: message(1), cursorAfter: parseCursor('cursor_duplicate') },
              { message: message(2), cursorAfter: parseCursor('cursor_duplicate') },
            ])
          ),
      },
      { now: () => 0 }
    );
    await expect(duplicate.execute(request(), context())).resolves.toEqual({ kind: 'unavailable' });

    const emptyMore = new GetHostedMessagePage(
      { readPage: () => Promise.resolve(found([], true)) },
      { now: () => 0 }
    );
    await expect(emptyMore.execute(request(), context())).resolves.toEqual({ kind: 'unavailable' });

    const throwing = new GetHostedMessagePage(
      { readPage: () => Promise.reject(new Error('private runtime detail')) },
      { now: () => 0 }
    );
    await expect(throwing.execute(request(), context())).resolves.toEqual({ kind: 'unavailable' });
  });
});

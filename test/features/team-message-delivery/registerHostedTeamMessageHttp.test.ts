import {
  HOSTED_TEAM_MESSAGE_PAGE_ROUTE,
  HOSTED_TEAM_MESSAGE_ROUTE_DESCRIPTORS,
  HOSTED_TEAM_MESSAGE_SEND_ROUTE,
  type HostedTeamMessageHttpFacade,
  registerHostedTeamMessageHttp,
} from '@features/team-message-delivery/main/hosted';
import { createRouteCatalog } from '@main/composition/hosted/routing';
import { createQueryContext, parseRevision, parseTeamId } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const revision = parseRevision('revision_http-1');

function context(signal: AbortSignal) {
  return createQueryContext({
    actorId: 'actor_message-http',
    sessionId: 'session_message-http',
    deploymentId: 'deployment_message-http',
    bootId: 'boot_message-http',
    requestId: 'request_message-http',
    authorizedScope: 'scope_message-http',
    deadlineAtMs: 10_000,
    signal,
  });
}

function page() {
  return {
    schemaVersion: 1 as const,
    kind: 'message_page' as const,
    teamId,
    sourceGeneration: 'generation_http-1' as never,
    revision,
    messages: [],
    nextCursor: null,
  };
}

function facade(): HostedTeamMessageHttpFacade {
  return {
    getPage: vi.fn(() => Promise.resolve({ kind: 'success' as const, page: page() })),
    sendMessage: vi.fn(() =>
      Promise.resolve({
        kind: 'persisted' as const,
        receipt: {
          schemaVersion: 1 as const,
          teamId,
          messageId: `message_${'b'.repeat(32)}` as never,
          clientMessageId: 'client_message_http-0001' as never,
          persistence: 'durable' as const,
          runtimeDelivery: 'delivered' as const,
        },
      })
    ),
  };
}

async function createApp(feature = facade()) {
  const app = Fastify();
  const createContext = vi.fn((_request, signal: AbortSignal) => context(signal));
  registerHostedTeamMessageHttp(app, feature, createContext);
  await app.ready();
  return { app, createContext, feature };
}

describe('registerHostedTeamMessageHttp', () => {
  it('registers only the local browser page and send descriptors', () => {
    const catalog = createRouteCatalog(HOSTED_TEAM_MESSAGE_ROUTE_DESCRIPTORS, 'production');
    expect(catalog.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${HOSTED_TEAM_MESSAGE_PAGE_ROUTE}`,
      `POST ${HOSTED_TEAM_MESSAGE_SEND_ROUTE}`,
    ]);
    expect(catalog.routes.map(({ readiness }) => readiness)).toEqual([
      ['serve', 'auth', 'read'],
      ['serve', 'auth', 'mutation'],
    ]);
  });

  it('serves no-store pages and sends through an injected context', async () => {
    const { app, createContext, feature } = await createApp();
    const request = {
      schemaVersion: 1,
      teamId,
      cursor: null,
      expectedSourceGeneration: null,
      limit: 25,
    };
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_MESSAGE_PAGE_ROUTE,
        payload: request,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual(page());
      expect(feature.getPage).toHaveBeenCalledWith(request, expect.any(Object));

      const sent = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_MESSAGE_SEND_ROUTE,
        payload: {
          schemaVersion: 1,
          teamId,
          clientMessageId: 'client_message_http-0001',
          text: 'Hello',
        },
      });
      expect(sent.statusCode).toBe(200);
      expect(sent.json()).toMatchObject({ kind: 'persisted', receipt: { persistence: 'durable' } });
      expect(createContext).toHaveBeenCalledTimes(2);
      expect(createContext.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    } finally {
      await app.close();
    }
  });

  it('maps idempotency conflict and private failures to safe HTTP envelopes', async () => {
    const feature = facade();
    vi.mocked(feature.sendMessage).mockResolvedValueOnce({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    vi.mocked(feature.getPage).mockRejectedValueOnce(new Error('provider token at /private/path'));
    const { app } = await createApp(feature);
    try {
      const conflict = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_MESSAGE_SEND_ROUTE,
        payload: {},
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({
        schemaVersion: 1,
        kind: 'error',
        error: { code: 'conflict', reason: 'team_message_idempotency_conflict' },
        retryable: false,
      });

      const failure = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_MESSAGE_PAGE_ROUTE,
        payload: {},
      });
      expect(failure.statusCode).toBe(503);
      expect(failure.body).not.toMatch(/provider|token|private|path/);
    } finally {
      await app.close();
    }
  });
});

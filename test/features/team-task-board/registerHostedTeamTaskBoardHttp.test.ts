import { parseHostedTaskBoardSourceGeneration } from '@features/team-task-board/contracts/hosted';
import {
  HOSTED_TASK_BOARD_MUTATION_ROUTE,
  HOSTED_TASK_BOARD_PAGE_ROUTE,
  HOSTED_TEAM_TASK_BOARD_ROUTE_DESCRIPTORS,
  type HostedTeamTaskBoardHttpFacade,
  registerHostedTeamTaskBoardHttp,
} from '@features/team-task-board/main/hosted';
import { createRouteCatalog } from '@main/composition/hosted/routing';
import { createQueryContext, parseRevision, parseTeamId } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const revision = parseRevision(`revision_${'b'.repeat(64)}`);
const replacementGeneration = parseHostedTaskBoardSourceGeneration('generation_http-replacement');

function makeContext(signal: AbortSignal) {
  return createQueryContext({
    actorId: 'actor_http-test',
    sessionId: 'session_http-test',
    deploymentId: 'deployment_http-test',
    bootId: 'boot_http-test',
    requestId: 'request_http-test',
    authorizedScope: 'scope_http-test',
    deadlineAtMs: 10_000,
    signal,
  });
}

function page() {
  return {
    schemaVersion: 1 as const,
    kind: 'task_board_page' as const,
    teamId,
    sourceGeneration: 'generation_http-1' as never,
    revision,
    items: [],
    nextCursor: null,
    truncated: false,
    truncationReasons: [],
    degraded: { active: false, reasons: [] },
    budget: {
      itemLimit: 25,
      byteLimit: 256 * 1024,
      timeLimitMs: 250,
      usedItems: 0,
      usedBytes: 2_048,
      elapsedMs: 1,
    },
  };
}

function facade(): HostedTeamTaskBoardHttpFacade {
  return {
    getPage: vi.fn(() => Promise.resolve({ kind: 'success' as const, page: page() })),
    executeMutation: vi.fn(() => Promise.resolve({ kind: 'not_found' as const })),
  };
}

async function createApp(feature = facade()) {
  const app = Fastify();
  const createContext = vi.fn((_request, signal: AbortSignal) => makeContext(signal));
  registerHostedTeamTaskBoardHttp(app, feature, createContext);
  await app.ready();
  return { app, createContext, feature };
}

describe('registerHostedTeamTaskBoardHttp', () => {
  it('publishes two production-valid feature-local route descriptors', () => {
    const catalog = createRouteCatalog(HOSTED_TEAM_TASK_BOARD_ROUTE_DESCRIPTORS, 'production');

    expect(catalog.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${HOSTED_TASK_BOARD_PAGE_ROUTE}`,
      `POST ${HOSTED_TASK_BOARD_MUTATION_ROUTE}`,
    ]);
    expect(catalog.routes.every((route) => route.owner === 'team-task-board')).toBe(true);
    expect(catalog.routes.every((route) => route.trustKind === 'browser')).toBe(true);
    expect(catalog.routes.every((route) => Object.isFrozen(route))).toBe(true);
  });

  it('serves a no-store bounded page through the injected context and facade', async () => {
    const { app, createContext, feature } = await createApp();
    const body = {
      schemaVersion: 1,
      teamId,
      cursor: null,
      expectedSourceGeneration: null,
      limit: 25,
    };
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TASK_BOARD_PAGE_ROUTE,
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual(page());
      expect(createContext).toHaveBeenCalledOnce();
      expect(feature.getPage).toHaveBeenCalledWith(body, expect.any(Object));
      const receivedSignal = createContext.mock.calls[0][1];
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedSignal.aborted).toBe(false);
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      result: { kind: 'invalid_request' as const },
      status: 400,
      code: 'invalid_request',
      reason: 'task_mutation_invalid',
    },
    {
      result: {
        kind: 'stale_generation' as const,
        currentSourceGeneration: replacementGeneration,
      },
      status: 409,
      code: 'conflict',
      reason: 'stale_generation',
    },
    {
      result: { kind: 'stale_revision' as const, currentRevision: revision },
      status: 409,
      code: 'conflict',
      reason: 'stale_revision',
    },
    {
      result: {
        kind: 'conflict' as const,
        reason: 'idempotency_mismatch' as const,
      },
      status: 409,
      code: 'conflict',
      reason: 'idempotency_mismatch',
    },
    {
      result: { kind: 'not_found' as const },
      status: 404,
      code: 'not_found',
      reason: 'task_not_found',
    },
    {
      result: { kind: 'unsafe_active' as const },
      status: 423,
      code: 'conflict',
      reason: 'unsafe_active',
    },
    {
      result: { kind: 'unavailable' as const, retryAfterMs: 1_500 },
      status: 503,
      code: 'unavailable',
      reason: 'task_board_unavailable',
    },
  ])('maps $result.kind to a safe $status response', async ({ result, status, code, reason }) => {
    const feature = facade();
    vi.mocked(feature.executeMutation).mockResolvedValueOnce(result);
    const { app } = await createApp(feature);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TASK_BOARD_MUTATION_ROUTE,
        payload: { command: 'fixture' },
      });

      expect(response.statusCode).toBe(status);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({
        schemaVersion: 1,
        kind: 'error',
        error: { code, reason },
        retryable: status === 503,
      });
      expect(response.body).not.toMatch(/stack|private|provider|token/i);
      if (status === 503) expect(response.headers['retry-after']).toBe('2');
      if (result.kind === 'stale_generation') {
        expect(response.json().currentSourceGeneration).toBe(replacementGeneration);
      }
    } finally {
      await app.close();
    }
  });

  it('maps a stale page generation to the same safe typed conflict envelope', async () => {
    const feature = facade();
    vi.mocked(feature.getPage).mockResolvedValueOnce({
      kind: 'stale_generation',
      currentSourceGeneration: replacementGeneration,
    });
    const { app } = await createApp(feature);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TASK_BOARD_PAGE_ROUTE,
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        schemaVersion: 1,
        kind: 'error',
        error: {
          code: 'conflict',
          reason: 'stale_generation',
        },
        retryable: false,
        currentSourceGeneration: replacementGeneration,
      });
    } finally {
      await app.close();
    }
  });

  it('returns committed and replay receipts without wrapping or widening them', async () => {
    const commandId = 'command_http-1' as never;
    const taskId = `task_${'1'.repeat(32)}` as never;
    const baseReceipt = {
      schemaVersion: 1 as const,
      commandId,
      teamId,
      sourceGeneration: 'generation_http-1' as never,
      revision,
      affectedTaskIds: [taskId],
    };
    const feature = facade();
    vi.mocked(feature.executeMutation)
      .mockResolvedValueOnce({
        kind: 'committed',
        receipt: { ...baseReceipt, outcome: 'committed' },
      })
      .mockResolvedValueOnce({
        kind: 'idempotent_replay',
        receipt: { ...baseReceipt, outcome: 'idempotent_replay' },
      });
    const { app } = await createApp(feature);
    try {
      const committed = await app.inject({
        method: 'POST',
        url: HOSTED_TASK_BOARD_MUTATION_ROUTE,
        payload: {},
      });
      const replay = await app.inject({
        method: 'POST',
        url: HOSTED_TASK_BOARD_MUTATION_ROUTE,
        payload: {},
      });
      expect(committed.statusCode).toBe(200);
      expect(committed.json().outcome).toBe('committed');
      expect(replay.statusCode).toBe(200);
      expect(replay.json().outcome).toBe('idempotent_replay');
    } finally {
      await app.close();
    }
  });

  it('contains thrown context and facade errors as generic unavailable envelopes', async () => {
    const feature = facade();
    vi.mocked(feature.getPage).mockRejectedValueOnce(new Error('provider token at /private/path'));
    const { app } = await createApp(feature);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TASK_BOARD_PAGE_ROUTE,
        payload: {},
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        schemaVersion: 1,
        kind: 'error',
        error: {
          code: 'unavailable',
          reason: 'task_board_unavailable',
        },
        retryable: true,
      });
      expect(response.body).not.toMatch(/provider|token|private|path/);
    } finally {
      await app.close();
    }
  });
});

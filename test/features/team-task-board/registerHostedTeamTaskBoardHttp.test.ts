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
  return { getPage: vi.fn(() => Promise.resolve({ kind: 'success' as const, page: page() })) };
}

async function createApp(feature = facade()) {
  const app = Fastify();
  const createContext = vi.fn((_request, signal: AbortSignal) => makeContext(signal));
  registerHostedTeamTaskBoardHttp(app, feature, createContext);
  await app.ready();
  return { app, createContext, feature };
}

describe('registerHostedTeamTaskBoardHttp', () => {
  it('publishes only the production read descriptor and leaves mutation unmounted', async () => {
    const catalog = createRouteCatalog(HOSTED_TEAM_TASK_BOARD_ROUTE_DESCRIPTORS, 'production');
    expect(catalog.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${HOSTED_TASK_BOARD_PAGE_ROUTE}`,
    ]);
    expect(catalog.routes[0]).toMatchObject({
      owner: 'team-task-board',
      trustKind: 'browser',
      readiness: ['serve', 'auth', 'read'],
    });

    const { app } = await createApp();
    try {
      const mutation = await app.inject({ method: 'POST', url: HOSTED_TASK_BOARD_MUTATION_ROUTE });
      expect(mutation.statusCode).toBe(404);
    } finally {
      await app.close();
    }
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
      expect(createContext.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    } finally {
      await app.close();
    }
  });

  it('maps stale continuation to a safe typed 409 envelope', async () => {
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
        error: { code: 'conflict', reason: 'stale_generation' },
        retryable: false,
        currentSourceGeneration: replacementGeneration,
      });
    } finally {
      await app.close();
    }
  });

  it('contains private context and source errors in a generic unavailable envelope', async () => {
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
        error: { code: 'unavailable', reason: 'task_board_unavailable' },
        retryable: true,
      });
      expect(response.body).not.toMatch(/provider|token|private|path/);
    } finally {
      await app.close();
    }
  });
});

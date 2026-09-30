import {
  type HostedRecentProjectsResult,
  parseHostedRecentProjectsResult,
} from '@features/recent-projects/contracts/hosted';

import type { FastifyInstance } from 'fastify';

export const HOSTED_RECENT_PROJECTS_ROUTE = '/api/hosted/v1/dashboard/recent-projects';

export interface HostedRecentProjectsHttpFacade {
  list(request: object, signal: AbortSignal): Promise<HostedRecentProjectsResult>;
}

/** Exact POST query. Hosted auth middleware owns cookie, CSRF, Origin and role checks. */
export function registerHostedRecentProjectsHttp(
  app: FastifyInstance,
  facade: HostedRecentProjectsHttpFacade,
  deadlineMs = 6_000
): void {
  app.post<{ Body: unknown }>(HOSTED_RECENT_PROJECTS_ROUTE, async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const body = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      (body as { schemaVersion?: unknown }).schemaVersion !== 1
    ) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<HostedRecentProjectsResult>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve({ schemaVersion: 1, kind: 'unavailable', code: 'source_unavailable' });
      }, deadlineMs);
    });
    try {
      const result = await Promise.race([facade.list(request, controller.signal), deadline]);
      if (request.raw.aborted || reply.raw.destroyed) return reply;
      return reply.status(200).send(parseHostedRecentProjectsResult(result));
    } catch {
      if (request.raw.aborted || reply.raw.destroyed) return reply;
      return reply
        .status(200)
        .send({ schemaVersion: 1, kind: 'unavailable', code: 'source_unavailable' });
    } finally {
      clearTimeout(timeout);
      request.raw.off('aborted', abort);
      reply.raw.off('close', abort);
    }
  });
}

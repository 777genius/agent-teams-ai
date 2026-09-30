import { parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';

import type {
  HostedWorkspaceAccessProjection,
  HostedWorkspaceAccessTarget,
} from './hostedWorkspaceAccessProjection';
import type { FastifyInstance } from 'fastify';

export const HOSTED_WORKSPACE_ACCESS_ROUTE = '/api/hosted/v1/workspace-access/project';

function parseTarget(value: unknown): HostedWorkspaceAccessTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length < 1 ||
    keys.length > 2 ||
    keys.some((key) => key !== 'publicWorkspaceId' && key !== 'publicTeamId')
  )
    return null;
  try {
    const publicWorkspaceId = parseWorkspaceId(record.publicWorkspaceId);
    if (record.publicTeamId === undefined && !Object.hasOwn(record, 'publicTeamId')) {
      return Object.freeze({ publicWorkspaceId });
    }
    return Object.freeze({ publicWorkspaceId, publicTeamId: parseTeamId(record.publicTeamId) });
  } catch {
    return null;
  }
}

/** Exact, read-only HTTP route. The host auth inventory must admit this POST as hosted.query. */
export function createHostedWorkspaceAccessRoutes(projection: HostedWorkspaceAccessProjection): {
  register(app: FastifyInstance): void;
} {
  let registered = false;
  return Object.freeze({
    register(app: FastifyInstance): void {
      if (registered) throw new Error('hosted-workspace-access-routes-already-registered');
      registered = true;
      app.post(HOSTED_WORKSPACE_ACCESS_ROUTE, async (request, reply) => {
        const target = parseTarget(request.body);
        if (target === null) {
          return reply.code(400).send({ code: 'invalid_request' });
        }
        const access = await projection.project(request, target);
        if (access === null) {
          return reply.code(404).send({ code: 'unavailable' });
        }
        return reply.send(access);
      });
    },
  });
}

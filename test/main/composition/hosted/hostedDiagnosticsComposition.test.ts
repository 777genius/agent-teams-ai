import { parseHostedSessionId, parseUserId } from '@features/hosted-access/contracts';
import {
  HOSTED_DIAGNOSTICS_QUERY_ROUTE,
  HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
} from '@features/hosted-operations/contracts';
import { HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS } from '@features/hosted-operations/main/hosted';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  createHostedRouteAdmissionBinding,
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_TERMINAL_READINESS,
  type HostedReadinessDimensionStates,
} from '@main/composition/hosted/application';
import { createHostedDiagnosticsComposition } from '@main/composition/hosted/hostedDiagnosticsComposition';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type { FastifyRequest } from 'fastify';

const PRIVATE_PAYLOAD = 'provider-token-private-output';

function principal(name: string): HostedAuthenticatedPrincipal {
  const sessionId = parseHostedSessionId(`hss_server-logs-${name}`);
  return {
    principal: {
      userId: parseUserId(`user_server-logs-${name}`),
      displayName: 'Operator',
      role: 'member',
      permissions: ['hosted.query'],
      authenticationMethod: 'oidc',
      sessionId,
    },
    authenticatedSessionId: sessionId,
  };
}

describe('hosted diagnostics production composition', () => {
  it('records real HTTP failures and returns only bounded redacted events to an authenticated operator', async () => {
    const runtimeInstance = createRuntimeInstanceContext({
      deploymentId: 'deployment_server-logs-test',
      bootId: 'boot_server-logs-test',
      claudeRoot: { kind: 'claude', reference: 'isolated:claude' },
      appDataRoot: { kind: 'app-data', reference: 'isolated:app-data' },
      workspaceRoots: [],
      tempRoot: { kind: 'temp', reference: 'isolated:temp' },
      logsRoot: { kind: 'logs', reference: 'isolated:logs' },
    });
    const dimensions = {
      ...Object.fromEntries(
        HOSTED_READINESS_DIMENSIONS.map((dimension) => [
          dimension,
          { dimension, status: 'ready', reasons: [] },
        ])
      ),
      terminal: HOSTED_TERMINAL_READINESS,
    } as HostedReadinessDimensionStates;
    const routeAdmissionBinding = createHostedRouteAdmissionBinding({
      routes: HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS,
      routeScope: 'production',
      readiness: { readiness: async () => ({ revision: 1, dimensions }) },
    });
    const composition = createHostedDiagnosticsComposition({
      authentication: {
        authenticatedPrincipalFor: (request) => {
          const name = (request as FastifyRequest).headers['x-test-auth'];
          return name === 'alice' || name === 'bob' ? principal(name) : null;
        },
      },
      runtimeInstance,
      expectedDeploymentId: runtimeInstance.deploymentId,
      routeAdmissionBinding,
    });
    const app = Fastify();
    app.get('/pre-registered', async (_request, reply) =>
      reply.status(503).send({ detail: PRIVATE_PAYLOAD })
    );
    composition.register(app);
    app.get('/test-failure', async (_request, reply) =>
      reply.status(503).send({ detail: PRIVATE_PAYLOAD })
    );
    app.get('/test-error', async () => {
      throw new Error(PRIVATE_PAYLOAD);
    });
    await app.ready();
    try {
      const earlierRoute = await app.inject({
        method: 'GET',
        url: '/pre-registered',
        headers: { 'x-test-auth': 'alice' },
      });
      expect(earlierRoute.statusCode).toBe(503);
      const failure = await app.inject({
        method: 'GET',
        url: '/test-failure',
        headers: { 'x-test-auth': 'alice' },
      });
      expect(failure.statusCode).toBe(503);
      const error = await app.inject({
        method: 'GET',
        url: '/test-error',
        headers: { 'x-test-auth': 'alice' },
      });
      expect(error.statusCode).toBe(500);
      const body = {
        schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
        referenceIds: [],
        recentServerLogs: true,
      };
      const denied = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        payload: body,
      });
      expect(denied.statusCode).toBe(503);
      const allowed = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: { 'x-test-auth': 'alice' },
        payload: body,
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().items).toHaveLength(3);
      expect(allowed.json().kind).toBe('success');
      expect(allowed.json().correlation.requestId).toBe(allowed.headers['x-request-id']);
      expect(allowed.json().correlation.diagnosticId).toBe(allowed.headers['x-diagnostic-id']);
      const invalidQuery = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: { 'x-test-auth': 'alice' },
        payload: { schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION, referenceIds: ['bad'] },
      });
      expect(invalidQuery.statusCode).toBe(400);
      expect(invalidQuery.json().error.diagnosticId).toBe(invalidQuery.headers['x-diagnostic-id']);
      expect(allowed.json().items[0].requestId).toBe(earlierRoute.headers['x-request-id']);
      expect(allowed.json().items[0].diagnosticId).toBe(earlierRoute.headers['x-diagnostic-id']);
      expect(allowed.json().items[0]).toMatchObject({
        kind: 'http_request',
        outcome: 'failed',
        attributes: { component: 'http_server', reason: 'unavailable' },
        requestId: expect.stringMatching(/^request_[0-9a-f]{32}$/),
        diagnosticId: expect.stringMatching(/^diagnostic_[0-9a-f]{32}$/),
      });
      expect(allowed.body).not.toContain(PRIVATE_PAYLOAD);
      const bob = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: { 'x-test-auth': 'bob' },
        payload: body,
      });
      expect(bob.statusCode).toBe(200);
      expect(bob.json().items).toEqual([]);
      const crossPrincipalReference = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: { 'x-test-auth': 'bob' },
        payload: {
          schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
          referenceIds: [allowed.json().items[0].referenceId],
        },
      });
      expect(crossPrincipalReference.statusCode).toBe(503);
      expect(crossPrincipalReference.json().error.reason).toBe('diagnostics_unavailable');
      const malformed = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: { 'x-test-auth': 'alice', 'content-type': 'application/json' },
        payload: '{bad-json',
      });
      expect(malformed.statusCode).toBe(400);
      const after = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: { 'x-test-auth': 'alice' },
        payload: body,
      });
      const malformedLog = after
        .json()
        .items.find(
          (item: { requestId: string }) => item.requestId === malformed.headers['x-request-id']
        );
      expect(malformedLog).toMatchObject({
        outcome: 'rejected',
        diagnosticId: malformed.headers['x-diagnostic-id'],
        attributes: { reason: 'invalid_input' },
      });
      const queryLog = after
        .json()
        .items.find(
          (item: { requestId: string }) => item.requestId === allowed.headers['x-request-id']
        );
      expect(queryLog.diagnosticId).toBe(allowed.json().correlation.diagnosticId);
    } finally {
      composition.close();
      await app.close();
    }
  });
});

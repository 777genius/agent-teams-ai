import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type HostedPrincipal,
  parseHostedSessionId,
  parseUserId,
} from '@features/hosted-access/contracts';
import { HostedAuthHttpController } from '@features/hosted-access/main/adapters/input/http/HostedAuthHttpController';
import { InternalStorageHostedAccessRepository } from '@features/hosted-access/main/adapters/output/InternalStorageHostedAccessRepository';
import {
  HOSTED_DIAGNOSTICS_QUERY_ROUTE,
  HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
} from '@features/hosted-operations/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { createQueryContext, parseAuthorizedScope } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { NodeHostedQueryContextIdentity } from '../../src/features/hosted-query-context/main/infrastructure/NodeHostedQueryContextIdentity';
import { createHostedDiagnosticsComposition } from '../../src/main/composition/hosted/hostedDiagnosticsComposition';

import type { OidcAuthenticationCapability } from '@features/hosted-access';

const USER_ID = parseUserId('user_diagnostics-user-0001');
const SESSION_ID = parseHostedSessionId('session_diagnostics-oidc-0001');
const SESSION_SECRET = 'opaque-diagnostics-session-secret';
const CSRF_TOKEN = 'csrf-diagnostics-token';
const DEPLOYMENT_ID = 'deployment_diagnostics-test';
const BOOT_ID = 'boot_diagnostics-test';
const PUBLIC_ORIGIN = 'https://agent-teams.test';
const PRIVATE_VALUE = '/private/provider/token-value';

function runtimeInstance(bootId = BOOT_ID) {
  return createRuntimeInstanceContext({
    deploymentId: DEPLOYMENT_ID,
    bootId,
    claudeRoot: { kind: 'claude', reference: 'isolated:claude' },
    appDataRoot: { kind: 'app-data', reference: 'isolated:app-data' },
    workspaceRoots: [],
    tempRoot: { kind: 'temp', reference: 'isolated:temp' },
    logsRoot: { kind: 'logs', reference: 'isolated:logs' },
  });
}

function principal(permissions: HostedPrincipal['permissions']): HostedPrincipal {
  return Object.freeze({
    userId: USER_ID,
    displayName: 'Diagnostics user',
    role: 'viewer',
    permissions: Object.freeze([...permissions]),
    authenticationMethod: 'oidc',
    sessionId: SESSION_ID,
  });
}

async function harness(
  permissions: HostedPrincipal['permissions'] = ['hosted.query'],
  runtime: ReturnType<typeof runtimeInstance> | null = runtimeInstance()
) {
  const app = Fastify();
  const authentication = {
    mode: 'oidc',
    displayName: 'Synthetic identity provider',
    authenticate: (input: { readonly sessionSecret?: string }) =>
      Promise.resolve(
        input.sessionSecret === SESSION_SECRET
          ? Object.freeze({
              authenticated: true,
              context: Object.freeze({
                principal: principal(permissions),
                authenticatedSessionId: SESSION_ID,
                sessionSecret: SESSION_SECRET,
                csrfToken: CSRF_TOKEN,
              }),
              replacementDeviceSecret: null,
            })
          : Object.freeze({ authenticated: false, reason: 'invalid' })
      ),
    verifyCsrf: (_context: unknown, token: string) => Promise.resolve(token === CSRF_TOKEN),
    auditAuthorization: () => Promise.resolve(),
  } as unknown as OidcAuthenticationCapability;
  const repository = {
    isWorkspaceRegistered: () => Promise.resolve(false),
    listWorkspaceGrants: () => Promise.resolve([]),
    listWorkspaces: () => Promise.resolve([]),
  } as unknown as InternalStorageHostedAccessRepository;
  const auth = new HostedAuthHttpController({
    mode: 'oidc',
    publicOrigin: PUBLIC_ORIGIN,
    secureCookies: true,
    authentication,
    personal: null,
    oidc: authentication,
    repository,
    restoreGeneration: 0,
    sessionMaxAgeSeconds: 600,
    deviceMaxAgeSeconds: 600,
    tryEnterPublicRequest: () => true,
    leavePublicRequest: () => undefined,
    isPublicAccessActive: () => true,
  });
  const composition = createHostedDiagnosticsComposition({
    authentication: Object.freeze({
      allowedOrigin: PUBLIC_ORIGIN,
      register: (target: unknown) => auth.register(target),
      authenticatedPrincipalFor: (request: object) => auth.authenticatedPrincipalFor(request),
      isWorkspaceRegistered: (workspaceId: string) => auth.isWorkspaceRegistered(workspaceId),
      projectWorkspaceId: (request: unknown, workspaceId: string) =>
        auth.projectWorkspaceId(request, workspaceId),
      projectPayload: (request: unknown, payload: unknown) => auth.projectPayload(request, payload),
      isEventStreamAuthorized: (request: unknown) => auth.isEventStreamAuthorized(request),
      projectEvent: (request: unknown, channel: string, data: unknown) =>
        auth.projectEvent(request, channel, data),
    }),
    runtimeInstance: runtime,
    expectedDeploymentId: DEPLOYMENT_ID,
  });
  auth.register(app);
  composition.register(app);
  await app.ready();
  return { app, composition };
}

const authenticatedHeaders = Object.freeze({
  cookie: `__Host-agent-teams-session=${SESSION_SECRET}`,
  origin: PUBLIC_ORIGIN,
  'sec-fetch-site': 'same-origin',
  'x-agent-teams-csrf': CSRF_TOKEN,
});

describe('standalone hosted diagnostics', () => {
  it('mounts one auth-bound composition from canonical bootstrap identity and closes it', () => {
    const source = readFileSync(resolve('src/main/standalone.ts'), 'utf8');
    const shutdown = source.slice(source.indexOf('async function shutdown'));

    expect(source.match(/createHostedDiagnosticsComposition\(\{/g)).toHaveLength(1);
    expect(source).toContain('authentication: hostedAccessFeature.http');
    expect(source).toContain('runtimeInstance: hostedDiagnosticsRuntimeInstance');
    expect(source).toContain('expectedDeploymentId: hostedAccessFeature.deploymentId');
    expect(source).toContain('hostedDiagnosticsRoutes: hostedDiagnostics');
    expect(source).toContain('hostedDiagnosticsRuntimeInstance = bootstrap.runtimeInstance');
    expect(shutdown.indexOf('hostedDiagnostics?.close()')).toBeLessThan(
      shutdown.indexOf('httpServer.stop()')
    );
    expect(source).not.toMatch(
      /(?:new HostedApplication|new HostedLifecycle|HostedTeamWorkspace\b)/
    );
  });

  it('serves only an authenticated, CSRF-admitted, bounded redacted response', async () => {
    const { app, composition } = await harness();
    const identity = new NodeHostedQueryContextIdentity();
    const referenceId = composition.recorder.record(
      {
        kind: 'reference_load',
        outcome: 'succeeded',
        occurredAtMonotonicMs: 1,
        attributes: { component: PRIVATE_VALUE, token: PRIVATE_VALUE },
      },
      createQueryContext({
        actorId: identity.projectActorId(USER_ID),
        sessionId: identity.projectSessionId(SESSION_ID),
        deploymentId: DEPLOYMENT_ID,
        bootId: BOOT_ID,
        requestId: 'request_diagnostics-record-0001',
        authorizedScope: parseAuthorizedScope('scope_authenticated-hosted-query'),
        deadlineAtMs: Date.now() + 10_000,
        signal: new AbortController().signal,
      })
    );
    const payload = {
      schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
      referenceIds: [referenceId],
    };
    try {
      const anonymous = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        payload,
      });
      expect(anonymous.statusCode).toBe(401);

      const invalidCsrf = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: { ...authenticatedHeaders, 'x-agent-teams-csrf': 'invalid' },
        payload,
      });
      expect(invalidCsrf.statusCode).toBe(403);

      const response = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: authenticatedHeaders,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(response.json()).toMatchObject({
        schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
        kind: 'success',
        items: [
          {
            referenceId,
            attributes: { component: 'redacted' },
          },
        ],
      });
      for (const hidden of [
        PRIVATE_VALUE,
        USER_ID,
        SESSION_ID,
        SESSION_SECRET,
        CSRF_TOKEN,
        BOOT_ID,
      ]) {
        expect(response.body).not.toContain(hidden);
      }
    } finally {
      composition.close();
      await app.close();
    }
  });

  it('fails closed for missing permission/runtime, wrong deployment, and closed adapters', async () => {
    expect(() =>
      createHostedDiagnosticsComposition({
        authentication: {} as never,
        runtimeInstance: runtimeInstance('boot_diagnostics-other'),
        expectedDeploymentId: 'deployment_diagnostics-other',
      })
    ).toThrow('hosted-diagnostics-deployment-binding-invalid');

    const unavailable = await harness(['hosted.query'], null);
    try {
      const response = await unavailable.app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: authenticatedHeaders,
        payload: { schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION, referenceIds: [] },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ kind: 'error' });
    } finally {
      unavailable.composition.close();
      await unavailable.app.close();
    }

    const denied = await harness(['hosted.events']);
    try {
      const response = await denied.app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: authenticatedHeaders,
        payload: { schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION, referenceIds: [] },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ kind: 'error' });

      denied.composition.close();
      const closed = await denied.app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: authenticatedHeaders,
        payload: { schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION, referenceIds: [] },
      });
      expect(closed.statusCode).toBe(503);
    } finally {
      denied.composition.close();
      await denied.app.close();
    }
  });
});

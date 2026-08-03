/* eslint-disable @typescript-eslint/no-empty-function, @typescript-eslint/require-await -- Async no-op test doubles implement hosted HTTP ports. */

import { request as makeHttpRequest } from 'node:http';

import { parseUserId } from '@features/hosted-access';
import { HostedAuthHttpController } from '@features/hosted-access/main/adapters/input/http/HostedAuthHttpController';
import { InternalStorageHostedAccessRepository } from '@features/hosted-access/main/adapters/output/InternalStorageHostedAccessRepository';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { HostedPrincipal } from '@features/hosted-access';
import type {
  OidcAuthenticationCapability,
  PersonalAuthenticationCapability,
} from '@features/hosted-access';
import type { FastifyInstance } from 'fastify';

const apps: FastifyInstance[] = [];
const HOSTED_TASK_BOARD_TEAM_ID = `team_${'a'.repeat(32)}`;
const HOSTED_LIFECYCLE_COMMAND_PATHS = Object.freeze([
  '/api/hosted/v1/team-lifecycle/launch',
  '/api/hosted/v1/team-lifecycle/cancel',
  '/api/hosted/v1/team-lifecycle/stop',
  '/api/hosted/v1/team-lifecycle/recover',
]);
const PERSONAL_SESSION_ID = 'operator-session_synthetic-session-1' as never;

interface HarnessOperationFailures {
  readonly completeLogin?: Error;
  readonly logout?: Error;
  readonly logoutRedirectUrl?: string;
  readonly backchannelLogout?: Error;
  readonly verifyCsrf?: Error;
  readonly listWorkspaceGrants?: Error;
  readonly listWorkspaces?: Error;
  readonly teamRuntimeWorkspaceId?: string | null;
  readonly teamWorkspaceResolution?: Error;
  readonly backchannelLogoutHandler?: (token: string) => Promise<number>;
  readonly liveAuthentication?: () => boolean;
}

interface PersonalHarnessFailures {
  readonly logout?: Error;
  readonly forgetDeviceCode?: string;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function makePrincipal(role: HostedPrincipal['role']): HostedPrincipal {
  const permissionByRole = {
    owner: [
      'hosted.query',
      'hosted.events',
      'hosted.command',
      'hosted.manage',
      'workspace.manage',
      'identity.manage',
    ],
    admin: ['hosted.query', 'hosted.events', 'hosted.command', 'hosted.manage', 'workspace.manage'],
    member: ['hosted.query', 'hosted.events', 'hosted.command'],
    viewer: ['hosted.query', 'hosted.events'],
  } as const;
  return {
    userId: parseUserId('usr_synthetic-user-1'),
    displayName: 'Synthetic',
    role,
    permissions: permissionByRole[role],
    authenticationMethod: 'oidc',
    sessionId: 'hss_synthetic-session-1' as never,
  };
}

function harness(
  role: HostedPrincipal['role'],
  workspaceRegistered = true,
  publicAccessActive = true,
  authenticationFailure: Error | null = null,
  operationFailures: HarnessOperationFailures = {},
  abortVersionResponse = false
) {
  const app = Fastify();
  apps.push(app);
  const sourceIps: string[] = [];
  const returnTos: string[] = [];
  const resolvedTeamIds: string[] = [];
  let enteredRequests = 0;
  let leftRequests = 0;
  const authentication = {
    mode: 'oidc',
    displayName: 'Synthetic IdP',
    beginLogin: async (returnTo: string) => {
      returnTos.push(returnTo);
      return {
        redirectUrl: 'https://idp.test/authorize',
        attemptId: 'ola_synthetic-attempt-1' as never,
        state: 'synthetic-state-123456789',
      };
    },
    authenticate: async (input: { sessionSecret?: string; sourceIp?: string }) => {
      if (authenticationFailure !== null) throw authenticationFailure;
      if (!input.sessionSecret) return { authenticated: false, reason: 'invalid' } as const;
      if (operationFailures.liveAuthentication?.() === false) {
        return { authenticated: false, reason: 'revoked' } as const;
      }
      if (input.sourceIp) sourceIps.push(input.sourceIp);
      return {
        authenticated: true,
        context: {
          principal: makePrincipal(role),
          authenticatedSessionId: makePrincipal(role).sessionId!,
          sessionSecret: input.sessionSecret,
          csrfToken: 'csrf-token',
        },
        replacementDeviceSecret: null,
      } as const;
    },
    verifyCsrf: async (_context: unknown, token: string) => {
      if (operationFailures.verifyCsrf) throw operationFailures.verifyCsrf;
      return token === 'csrf-token';
    },
    logout: async () => {
      if (operationFailures.logout) throw operationFailures.logout;
      return { redirectUrl: operationFailures.logoutRedirectUrl ?? null };
    },
    auditAuthorization: async () => {},
    completeLogin: async () => {
      if (operationFailures.completeLogin) throw operationFailures.completeLogin;
      throw new Error('not_used');
    },
    backchannelLogout: async (token: string) => {
      if (operationFailures.backchannelLogoutHandler) {
        return operationFailures.backchannelLogoutHandler(token);
      }
      if (operationFailures.backchannelLogout) throw operationFailures.backchannelLogout;
      return 0;
    },
  } as unknown as OidcAuthenticationCapability;
  const repository = {
    isWorkspaceRegistered: async (runtimeWorkspaceId: string) =>
      workspaceRegistered && runtimeWorkspaceId === 'project_synthetic-1',
    listWorkspaceGrants: async () => {
      if (operationFailures.listWorkspaceGrants) throw operationFailures.listWorkspaceGrants;
      return workspaceRegistered
        ? [
            {
              userId: makePrincipal(role).userId,
              workspaceId: 'workspace_cccccccccccccccccccccccccccccccc',
              runtimeWorkspaceId: 'project_synthetic-1',
              displayName: 'Synthetic',
              grantGeneration: 0,
              grantedAt: 1,
              grantedBy: 'local-cli',
            },
          ]
        : [];
    },
    listWorkspaces: async () => {
      if (operationFailures.listWorkspaces) throw operationFailures.listWorkspaces;
      return [
        {
          workspaceId: 'workspace_cccccccccccccccccccccccccccccccc',
          runtimeWorkspaceId: 'project_synthetic-1',
          displayName: 'Synthetic',
          status: 'active',
          registeredAt: 1,
          registeredBy: null,
        },
      ];
    },
  } as unknown as InternalStorageHostedAccessRepository;
  const controller = new HostedAuthHttpController({
    mode: 'oidc',
    publicOrigin: 'https://agent-teams.test',
    secureCookies: true,
    authentication,
    personal: null,
    oidc: authentication,
    repository,
    restoreGeneration: 0,
    sessionMaxAgeSeconds: 600,
    deviceMaxAgeSeconds: 600,
    tryEnterPublicRequest: () => {
      if (!publicAccessActive) return false;
      enteredRequests += 1;
      return true;
    },
    leavePublicRequest: () => {
      leftRequests += 1;
    },
    isPublicAccessActive: () => publicAccessActive,
    resolveTeamWorkspaceId: async (teamId) => {
      resolvedTeamIds.push(teamId);
      if (operationFailures.teamWorkspaceResolution) {
        throw operationFailures.teamWorkspaceResolution;
      }
      if (teamId !== HOSTED_TASK_BOARD_TEAM_ID) return null;
      return operationFailures.teamRuntimeWorkspaceId === undefined
        ? 'project_synthetic-1'
        : operationFailures.teamRuntimeWorkspaceId;
    },
  });
  controller.register(app);
  app.get('/api/version', async (_request, reply) => {
    if (abortVersionResponse) {
      reply.raw.destroy();
      return reply;
    }
    return { ok: true };
  });
  app.post('/api/hosted/v1/team-task-board/page', async () => ({ ok: true }));
  for (const path of HOSTED_LIFECYCLE_COMMAND_PATHS) {
    app.post(path, async () => ({ ok: true }));
  }
  app.get('/api/projects/:projectId/sessions', async () => ({ ok: true }));
  app.post('/api/config/pin-session', async () => ({ ok: true }));
  app.get('/api/events', async () => ({ ok: true }));
  return {
    app,
    controller,
    returnTos,
    sourceIps,
    resolvedTeamIds,
    requestCounts: {
      get entered() {
        return enteredRequests;
      },
      get left() {
        return leftRequests;
      },
    },
  };
}

function personalStorageFailureHarness(failures: PersonalHarnessFailures = {}) {
  const app = Fastify();
  apps.push(app);
  const authentication = {
    mode: 'personal',
    displayName: 'Personal pairing',
    pair: async () => {
      throw new Error('personal_identity_storage_unavailable');
    },
    authenticate: async (input: { sessionSecret?: string }) =>
      input.sessionSecret
        ? ({
            authenticated: true,
            context: {
              principal: {
                ...makePrincipal('owner'),
                authenticationMethod: 'personal',
                sessionId: null,
              },
              authenticatedSessionId: PERSONAL_SESSION_ID,
              sessionSecret: input.sessionSecret,
              csrfToken: 'csrf-token',
            },
            replacementDeviceSecret: null,
          } as const)
        : ({ authenticated: false, reason: 'invalid' } as const),
    verifyCsrf: async (_context: unknown, token: string) => token === 'csrf-token',
    logout: async () => {
      if (failures.logout) throw failures.logout;
      return { redirectUrl: null };
    },
    forgetDevice: async () =>
      failures.forgetDeviceCode
        ? ({ ok: false, code: failures.forgetDeviceCode } as const)
        : ({ ok: true, code: 'device_forgotten' } as const),
    auditAuthorization: async () => {},
    auditPersonalAuthentication: async () => {},
  } as unknown as PersonalAuthenticationCapability;
  const controller = new HostedAuthHttpController({
    mode: 'personal',
    publicOrigin: 'https://agent-teams.test',
    secureCookies: true,
    authentication,
    personal: authentication,
    oidc: null,
    repository: {
      isWorkspaceRegistered: async () => false,
      listWorkspaceGrants: async () => [],
      listWorkspaces: async () => [],
    } as unknown as InternalStorageHostedAccessRepository,
    restoreGeneration: 0,
    sessionMaxAgeSeconds: 600,
    deviceMaxAgeSeconds: 600,
    tryEnterPublicRequest: () => true,
    leavePublicRequest: () => undefined,
    isPublicAccessActive: () => true,
  });
  controller.register(app);
  return { app, controller };
}

const cookie = '__Host-agent-teams-session=opaque-session-secret';

describe('HostedAuthHttpController authorization boundary', () => {
  it('fails every public and protected route closed after a durable mode transition', async () => {
    const { app } = harness('owner', true, false);
    const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
    const protectedQuery = await app.inject({ method: 'GET', url: '/api/version' });
    expect(status.statusCode).toBe(503);
    expect(status.json()).toEqual({ error: 'auth_mode_reset_requires_restart' });
    expect(protectedQuery.statusCode).toBe(503);
    expect(protectedQuery.json()).toEqual({ error: 'auth_mode_reset_requires_restart' });
  });

  it('releases the reset drain fence exactly once when a client connection closes early', async () => {
    const { app, requestCounts } = harness('viewer', true, true, null, {}, true);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => {
      const outgoing = makeHttpRequest(
        new URL('/api/version', origin),
        { headers: { cookie } },
        (response) => {
          response.resume();
          response.once('end', () => resolve());
        }
      );
      outgoing.once('error', () => resolve());
      outgoing.end();
    });

    await expect.poll(() => requestCounts.left).toBe(1);
    expect(requestCounts.entered).toBe(1);
  });

  it('rejects protected queries without an opaque session', async () => {
    const { app } = harness('viewer');
    const response = await app.inject({ method: 'GET', url: '/api/version' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'authentication_required' });
  });

  it('revalidates hosted.query against the live session rather than a cached request context', async () => {
    let live = true;
    const { app, controller } = harness('viewer', true, true, null, {
      liveAuthentication: () => live,
    });
    let capturedRequest: object | null = null;
    app.addHook('preHandler', async (request) => {
      capturedRequest ??= request;
    });

    const admitted = await app.inject({ method: 'GET', url: '/api/version', headers: { cookie } });
    expect(admitted.statusCode).toBe(200);
    expect(capturedRequest).not.toBeNull();
    await expect(controller.isHostedQueryAuthorized(capturedRequest!)).resolves.toBe(true);

    live = false;
    await expect(controller.isHostedQueryAuthorized(capturedRequest!)).resolves.toBe(false);
  });

  it.each(['https://agent-teams.test/api/version', '/public/../api/version', '/%61pi/version'])(
    'does not let canonical request-target %s bypass protected routing',
    async (url) => {
      const { app } = harness('viewer');
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'authentication_required' });
    }
  );

  it('marks every authentication response non-cacheable', async () => {
    const { app } = harness('viewer');
    const response = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.headers.pragma).toBe('no-cache');
  });

  it('marks authenticated responses non-cacheable and reports projection outages explicitly', async () => {
    const healthy = harness('viewer').app;
    const response = await healthy.inject({
      method: 'GET',
      url: '/api/version',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.headers.pragma).toBe('no-cache');

    const unavailable = harness('viewer', true, true, null, {
      listWorkspaces: new Error('synthetic_workspace_storage_unavailable'),
    }).app;
    const failed = await unavailable.inject({
      method: 'GET',
      url: '/api/version',
      headers: { cookie },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: 'hosted_projection_unavailable' });
    expect(failed.headers['cache-control']).toBe('no-store, private');
    expect(failed.headers.pragma).toBe('no-cache');
  });

  it('reports personal identity storage failure without consuming it as an invalid pairing code', async () => {
    const { app } = personalStorageFailureHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/personal/pair',
      headers: {
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
      },
      payload: {
        pairingCode: 'authority_pairing-challenge_00000001_abcdefghijklmnopqrstuvwxyz0123456789',
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'identity_storage_unavailable' });
  });

  it('reports OIDC session-storage failure instead of silently treating it as anonymous', async () => {
    const { app } = harness('viewer', true, true, new Error('oidc_authentication_unavailable'));
    const status = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie },
    });
    const protectedQuery = await app.inject({
      method: 'GET',
      url: '/api/version',
      headers: { cookie },
    });
    expect(status.statusCode).toBe(503);
    expect(status.json()).toEqual({ error: 'identity_storage_unavailable' });
    expect(status.headers['set-cookie']).toBeUndefined();
    expect(protectedQuery.statusCode).toBe(503);
    expect(protectedQuery.json()).toEqual({ error: 'identity_storage_unavailable' });
  });

  it('reports CSRF verification storage failure as unavailable instead of invalid', async () => {
    const { app } = harness('member', true, true, null, {
      verifyCsrf: new Error('synthetic_crypto_unavailable'),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/config/pin-session',
      headers: {
        cookie,
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': 'csrf-token',
      },
      payload: {
        projectId: 'workspace_cccccccccccccccccccccccccccccccc',
        sessionId: 'session-synthetic',
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'identity_storage_unavailable' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('exposes secret-free OIDC principal evidence only after auth and valid CSRF', async () => {
    const { app, controller } = harness('viewer');
    let evidence: ReturnType<HostedAuthHttpController['authenticatedPrincipalFor']> = null;
    app.post('/api/hosted/v1/operations/diagnostics', async (request) => {
      evidence = controller.authenticatedPrincipalFor(request);
      return { ok: true };
    });
    const headers = {
      cookie,
      origin: 'https://agent-teams.test',
      'sec-fetch-site': 'same-origin',
    } as const;

    const denied = await app.inject({
      method: 'POST',
      url: '/api/hosted/v1/operations/diagnostics',
      headers: { ...headers, 'x-agent-teams-csrf': 'wrong-token' },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(evidence).toBeNull();

    const admitted = await app.inject({
      method: 'POST',
      url: '/api/hosted/v1/operations/diagnostics',
      headers: { ...headers, 'x-agent-teams-csrf': 'csrf-token' },
      payload: {},
    });
    expect(admitted.statusCode).toBe(200);
    expect(Reflect.ownKeys(evidence!)).toEqual(['principal', 'authenticatedSessionId']);
    expect(Reflect.ownKeys(evidence!.principal)).toEqual([
      'userId',
      'displayName',
      'role',
      'permissions',
      'authenticationMethod',
      'sessionId',
    ]);
    expect(Object.isFrozen(evidence!.principal.permissions)).toBe(true);
    expect(evidence!.authenticatedSessionId).toBe(evidence!.principal.sessionId);
    expect(JSON.stringify(evidence)).not.toContain('opaque-session-secret');
    expect(JSON.stringify(evidence)).not.toContain('csrf-token');
  });

  it('retains a secret-free personal session identity beside the public principal', async () => {
    const { app, controller } = personalStorageFailureHarness();
    let evidence: ReturnType<HostedAuthHttpController['authenticatedPrincipalFor']> = null;
    app.post('/api/hosted/v1/operations/diagnostics', async (request) => {
      evidence = controller.authenticatedPrincipalFor(request);
      return { ok: true };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/hosted/v1/operations/diagnostics',
      headers: {
        cookie,
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': 'csrf-token',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(evidence).toMatchObject({
      principal: { authenticationMethod: 'personal', sessionId: null },
      authenticatedSessionId: PERSONAL_SESSION_ID,
    });
    expect(Reflect.ownKeys(evidence!)).toEqual(['principal', 'authenticatedSessionId']);
    expect(JSON.stringify(evidence)).not.toContain('opaque-session-secret');
    expect(JSON.stringify(evidence)).not.toContain('csrf-token');
  });

  it('reports an unclassified OIDC callback failure as unavailable, not invalid credentials', async () => {
    const { app } = harness('viewer', true, true, null, {
      completeLogin: new Error('synthetic_sqlite_unavailable'),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback?code=synthetic-code&state=synthetic-state-123456789',
      headers: {
        cookie:
          '__Host-agent-teams-oidc-attempt=ola_synthetic-attempt-1; ' +
          '__Host-agent-teams-oidc-state=synthetic-state-123456789',
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'oidc_callback_unavailable' });
    expect(response.headers['set-cookie']).toEqual(
      expect.not.arrayContaining([expect.stringContaining('__Host-agent-teams-session=')])
    );
  });

  it('preserves the session cookie when durable OIDC logout cannot be confirmed', async () => {
    const { app } = harness('viewer', true, true, null, {
      logout: new Error('synthetic_sqlite_unavailable'),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie,
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': 'csrf-token',
      },
      payload: { global: true },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'oidc_logout_unavailable' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('preserves the trusted OIDC end-session redirect without weakening other projection failures', async () => {
    const redirectUrl =
      'https://idp.test/protocol/openid-connect/logout?client_id=agent-teams-hosted';
    const { app } = harness('viewer', true, true, null, {
      logoutRedirectUrl: redirectUrl,
      listWorkspaces: new Error('synthetic_workspace_storage_unavailable'),
    });
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie,
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': 'csrf-token',
      },
      payload: { global: true },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({
      ok: true,
      redirectUrl,
      providerLogoutError: null,
    });

    const projected = await app.inject({
      method: 'GET',
      url: '/api/version',
      headers: { cookie },
    });
    expect(projected.statusCode).toBe(503);
    expect(projected.json()).toEqual({ error: 'hosted_projection_unavailable' });
  });

  it('reports an unclassified back-channel storage failure as unavailable', async () => {
    const { app } = harness('viewer', true, true, null, {
      backchannelLogout: new Error('synthetic_sqlite_unavailable'),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/oidc/backchannel-logout',
      payload: { logout_token: 'synthetic-signed-token' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'oidc_backchannel_logout_unavailable' });
  });

  it('bounds repeated unauthenticated back-channel verification requests per source', async () => {
    let verificationAttempts = 0;
    const { app } = harness('viewer', true, true, null, {
      backchannelLogoutHandler: async () => {
        verificationAttempts += 1;
        throw new Error('oidc_token_signature_invalid');
      },
    });
    for (let index = 0; index < 120; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/oidc/backchannel-logout',
        remoteAddress: '192.0.2.20',
        payload: { logout_token: `unauthenticated-${index}` },
      });
      expect(response.statusCode).toBe(400);
    }

    const denied = await app.inject({
      method: 'POST',
      url: '/api/auth/oidc/backchannel-logout',
      remoteAddress: '192.0.2.20',
      payload: { logout_token: 'unauthenticated-over-limit' },
    });
    expect(denied.statusCode).toBe(429);
    expect(denied.headers['retry-after']).toBe('1');
    expect(denied.json()).toEqual({ error: 'oidc_backchannel_logout_rate_limited' });
    expect(verificationAttempts).toBe(120);
  });

  it('bounds concurrent unauthenticated back-channel verification requests', async () => {
    let verificationAttempts = 0;
    let releaseVerification: () => void = () => undefined;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const { app } = harness('viewer', true, true, null, {
      backchannelLogoutHandler: async () => {
        verificationAttempts += 1;
        await verificationGate;
        throw new Error('oidc_token_signature_invalid');
      },
    });
    const active = Array.from({ length: 8 }, (_, index) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/oidc/backchannel-logout',
        remoteAddress: '192.0.2.30',
        payload: { logout_token: `concurrent-${index}` },
      })
    );
    try {
      await expect.poll(() => verificationAttempts).toBe(8);
      const denied = await app.inject({
        method: 'POST',
        url: '/api/auth/oidc/backchannel-logout',
        remoteAddress: '192.0.2.30',
        payload: { logout_token: 'concurrent-over-limit' },
      });
      expect(denied.statusCode).toBe(429);
      expect(verificationAttempts).toBe(8);
    } finally {
      releaseVerification();
    }
    const responses = await Promise.all(active);
    expect(responses.every((response) => response.statusCode === 400)).toBe(true);
  });

  it('preserves personal credentials when session logout cannot be confirmed', async () => {
    const { app } = personalStorageFailureHarness({
      logout: new Error('synthetic_authority_store_unavailable'),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie,
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': 'csrf-token',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'personal_logout_unavailable' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('preserves personal credentials when device-family revocation cannot be confirmed', async () => {
    const { app } = personalStorageFailureHarness({
      forgetDeviceCode: 'authority_store_unavailable',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/personal/forget-device',
      headers: {
        cookie:
          `${cookie}; ` +
          '__Host-agent-teams-device=opaque-device-secret-abcdefghijklmnopqrstuvwxyz',
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': 'csrf-token',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'personal_forget_device_unavailable' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('collapses backslash-based OIDC return URL confusion to the local root', async () => {
    const { app, returnTos } = harness('viewer');
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/oidc/login?returnTo=%2F%5Cattacker.test',
    });
    expect(response.statusCode).toBe(302);
    expect(returnTos).toEqual(['/']);
    expect(response.headers.location).toBe('https://idp.test/authorize');
  });

  it('bounds OIDC login admission per trusted source address', async () => {
    const { app } = harness('viewer');
    for (let index = 0; index < 30; index += 1) {
      const admitted = await app.inject({
        method: 'GET',
        url: '/api/auth/oidc/login',
        remoteAddress: '192.0.2.10',
      });
      expect(admitted.statusCode).toBe(302);
    }
    const denied = await app.inject({
      method: 'GET',
      url: '/api/auth/oidc/login',
      remoteAddress: '192.0.2.10',
    });
    expect(denied.statusCode).toBe(429);
    expect(denied.headers['retry-after']).toBe('60');
    expect(denied.json()).toEqual({ error: 'oidc_login_rate_limited' });
  });

  it('authenticates SSE with its separate permission', async () => {
    const { app } = harness('viewer');
    const denied = await app.inject({ method: 'GET', url: '/api/events' });
    expect(denied.statusCode).toBe(401);
    const admitted = await app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { cookie },
    });
    expect(admitted.statusCode).toBe(200);
  });

  it('prevents role escalation before considering a forged CSRF token', async () => {
    const { app } = harness('viewer');
    const response = await app.inject({
      method: 'POST',
      url: '/api/config/pin-session',
      headers: {
        cookie,
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': 'csrf-token',
      },
      payload: {
        projectId: 'workspace_cccccccccccccccccccccccccccccccc',
        sessionId: 'session-synthetic',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'permission_denied' });
  });

  it('requires both an exact Origin and the in-memory CSRF proof', async () => {
    const { app } = harness('member');
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/config/pin-session',
      headers: {
        cookie,
        origin: 'https://attacker.test',
        'sec-fetch-site': 'cross-site',
        'x-agent-teams-csrf': 'csrf-token',
      },
      payload: {
        projectId: 'workspace_cccccccccccccccccccccccccccccccc',
        sessionId: 'session-synthetic',
      },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toEqual({ error: 'origin_invalid' });

    const forged = await app.inject({
      method: 'POST',
      url: '/api/config/pin-session',
      headers: {
        cookie,
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': 'forged',
      },
      payload: {
        projectId: 'workspace_cccccccccccccccccccccccccccccccc',
        sessionId: 'session-synthetic',
      },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toEqual({ error: 'csrf_invalid' });

    const admitted = await app.inject({
      method: 'POST',
      url: '/api/config/pin-session',
      headers: {
        cookie,
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': 'csrf-token',
      },
      payload: {
        projectId: 'workspace_cccccccccccccccccccccccccccccccc',
        sessionId: 'session-synthetic',
      },
    });
    expect(admitted.statusCode).toBe(200);
  });

  it('admits task-board reads only after team-to-grant attribution', async () => {
    const trustedHeaders = {
      cookie,
      origin: 'https://agent-teams.test',
      'sec-fetch-site': 'same-origin',
      'x-agent-teams-csrf': 'csrf-token',
    };
    const member = harness('member');
    const memberPage = await member.app.inject({
      method: 'POST',
      url: '/api/hosted/v1/team-task-board/page',
      headers: trustedHeaders,
      payload: { teamId: HOSTED_TASK_BOARD_TEAM_ID },
    });
    expect(memberPage.statusCode).toBe(200);
    expect(member.resolvedTeamIds).toEqual([HOSTED_TASK_BOARD_TEAM_ID]);

    const viewer = harness('viewer');
    const viewerPage = await viewer.app.inject({
      method: 'POST',
      url: '/api/hosted/v1/team-task-board/page',
      headers: trustedHeaders,
      payload: { teamId: HOSTED_TASK_BOARD_TEAM_ID },
    });
    expect(viewerPage.statusCode).toBe(200);
    expect(viewer.resolvedTeamIds).toEqual([HOSTED_TASK_BOARD_TEAM_ID]);
  });

  it('checks task-board Origin and CSRF before resolving any team attribution', async () => {
    const member = harness('member');
    const forged = await member.app.inject({
      method: 'POST',
      url: '/api/hosted/v1/team-task-board/page',
      headers: {
        cookie,
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': 'forged',
      },
      payload: { teamId: HOSTED_TASK_BOARD_TEAM_ID },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toEqual({ error: 'csrf_invalid' });
    expect(member.resolvedTeamIds).toEqual([]);
  });

  it.each(HOSTED_LIFECYCLE_COMMAND_PATHS)(
    'admits %s only after cookie, Origin, CSRF, role, and team-workspace admission',
    async (path) => {
      const headers = {
        cookie,
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': 'csrf-token',
      };
      const member = harness('member');
      const crossOrigin = await member.app.inject({
        method: 'POST',
        url: path,
        headers: { ...headers, origin: 'https://attacker.test' },
        payload: { teamId: HOSTED_TASK_BOARD_TEAM_ID },
      });
      const invalidCsrf = await member.app.inject({
        method: 'POST',
        url: path,
        headers: { ...headers, 'x-agent-teams-csrf': 'forged' },
        payload: { teamId: HOSTED_TASK_BOARD_TEAM_ID },
      });
      const viewer = harness('viewer');
      const deniedRole = await viewer.app.inject({
        method: 'POST',
        url: path,
        headers,
        payload: { teamId: HOSTED_TASK_BOARD_TEAM_ID },
      });
      const admitted = await member.app.inject({
        method: 'POST',
        url: path,
        headers,
        payload: { teamId: HOSTED_TASK_BOARD_TEAM_ID },
      });

      expect(crossOrigin.statusCode).toBe(403);
      expect(crossOrigin.json()).toEqual({ error: 'origin_invalid' });
      expect(invalidCsrf.statusCode).toBe(403);
      expect(invalidCsrf.json()).toEqual({ error: 'csrf_invalid' });
      expect(deniedRole.statusCode).toBe(403);
      expect(deniedRole.json()).toEqual({ error: 'permission_denied' });
      expect(admitted.statusCode).toBe(200);
      expect(member.resolvedTeamIds).toEqual([HOSTED_TASK_BOARD_TEAM_ID]);
      expect(viewer.resolvedTeamIds).toEqual([]);
    }
  );

  it('denies invalid, unresolved and cross-workspace task-board team attribution', async () => {
    const trustedHeaders = {
      cookie,
      origin: 'https://agent-teams.test',
      'sec-fetch-site': 'same-origin',
      'x-agent-teams-csrf': 'csrf-token',
    };
    const cases = [
      {
        app: harness('member').app,
        teamId: 'team_not-canonical',
      },
      {
        app: harness('member', true, true, null, { teamRuntimeWorkspaceId: null }).app,
        teamId: HOSTED_TASK_BOARD_TEAM_ID,
      },
      {
        app: harness('member', true, true, null, {
          teamRuntimeWorkspaceId: 'project_other-workspace',
        }).app,
        teamId: HOSTED_TASK_BOARD_TEAM_ID,
      },
    ];
    for (const testCase of cases) {
      const response = await testCase.app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-task-board/page',
        headers: trustedHeaders,
        payload: { teamId: testCase.teamId },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'workspace_access_denied' });
    }
  });

  it('reports task attribution and durable grant outages without admitting the route', async () => {
    const trustedHeaders = {
      cookie,
      origin: 'https://agent-teams.test',
      'sec-fetch-site': 'same-origin',
      'x-agent-teams-csrf': 'csrf-token',
    };
    const attributionUnavailable = harness('member', true, true, null, {
      teamWorkspaceResolution: new Error('synthetic_lifecycle_unavailable'),
    }).app;
    const grantUnavailable = harness('member', true, true, null, {
      listWorkspaceGrants: new Error('synthetic_identity_storage_unavailable'),
    }).app;
    const attributionResponse = await attributionUnavailable.inject({
      method: 'POST',
      url: '/api/hosted/v1/team-task-board/page',
      headers: trustedHeaders,
      payload: { teamId: HOSTED_TASK_BOARD_TEAM_ID },
    });
    const grantResponse = await grantUnavailable.inject({
      method: 'POST',
      url: '/api/hosted/v1/team-task-board/page',
      headers: trustedHeaders,
      payload: { teamId: HOSTED_TASK_BOARD_TEAM_ID },
    });
    expect(attributionResponse.statusCode).toBe(503);
    expect(attributionResponse.json()).toEqual({ error: 'workspace_attribution_unavailable' });
    expect(grantResponse.statusCode).toBe(503);
    expect(grantResponse.json()).toEqual({ error: 'hosted_projection_unavailable' });
  });

  it('denies arbitrary workspace ids even to an authenticated member', async () => {
    const { app } = harness('member');
    const denied = await app.inject({
      method: 'GET',
      url: '/api/projects/project_unregistered-1/sessions',
      headers: { cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'workspace_access_denied' });

    const admitted = await app.inject({
      method: 'GET',
      url: '/api/projects/workspace_cccccccccccccccccccccccccccccccc/sessions',
      headers: { cookie },
    });
    expect(admitted.statusCode).toBe(200);

    const bodyDenied = await app.inject({
      method: 'POST',
      url: '/api/config/pin-session',
      headers: {
        cookie,
        origin: 'https://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': 'csrf-token',
      },
      payload: { projectId: 'project_unregistered-1', sessionId: 'session-synthetic' },
    });
    expect(bodyDenied.statusCode).toBe(403);
    expect(bodyDenied.json()).toEqual({ error: 'workspace_access_denied' });
  });

  it('isolates two principals by durable grant and projects every workspace DTO opaquely', async () => {
    const app = Fastify();
    apps.push(app);
    const firstUserId = parseUserId('usr_first-principal-1234');
    const secondUserId = parseUserId('usr_second-principal-123');
    const publicIds = {
      first: 'workspace_11111111111111111111111111111111',
      second: 'workspace_22222222222222222222222222222222',
    };
    const runtimeIds = {
      first: '-srv-private-runtime-first',
      second: '-srv-private-runtime-second',
    };
    const grants = new Map([
      [firstUserId, new Set([runtimeIds.first])],
      [secondUserId, new Set([runtimeIds.second])],
    ]);
    const workspaces = [
      {
        workspaceId: publicIds.first,
        runtimeWorkspaceId: runtimeIds.first,
        displayName: 'First',
        status: 'active',
        registeredAt: 1,
        registeredBy: null,
      },
      {
        workspaceId: publicIds.second,
        runtimeWorkspaceId: runtimeIds.second,
        displayName: 'Second',
        status: 'active',
        registeredAt: 2,
        registeredBy: null,
      },
    ];
    const authentication = {
      mode: 'oidc',
      displayName: 'Synthetic IdP',
      authenticate: async (input: { sessionSecret?: string }) => {
        const first = input.sessionSecret === 'session-first';
        const second = input.sessionSecret === 'session-second';
        if (!first && !second) return { authenticated: false, reason: 'invalid' } as const;
        const principal = {
          ...makePrincipal('member'),
          userId: first ? firstUserId : secondUserId,
          sessionId: (first ? 'hss_first-session-1234' : 'hss_second-session-123') as never,
        };
        return {
          authenticated: true,
          context: {
            principal,
            authenticatedSessionId: principal.sessionId,
            sessionSecret: input.sessionSecret!,
            csrfToken: 'csrf-token',
          },
          replacementDeviceSecret: null,
        } as const;
      },
      verifyCsrf: async () => true,
      auditAuthorization: async () => undefined,
    } as unknown as OidcAuthenticationCapability;
    const repository = {
      listWorkspaces: async () => workspaces,
      listWorkspaceGrants: async (input: { userId: typeof firstUserId }) =>
        workspaces.flatMap((workspace) =>
          grants.get(input.userId)?.has(workspace.runtimeWorkspaceId)
            ? [
                {
                  userId: input.userId,
                  workspaceId: workspace.workspaceId,
                  runtimeWorkspaceId: workspace.runtimeWorkspaceId,
                  displayName: workspace.displayName,
                  grantGeneration: 0,
                  grantedAt: 1,
                  grantedBy: 'local-cli',
                },
              ]
            : []
        ),
    } as unknown as InternalStorageHostedAccessRepository;
    const controller = new HostedAuthHttpController({
      mode: 'oidc',
      publicOrigin: 'https://agent-teams.test',
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
    controller.register(app);
    app.get('/api/projects', async () => [
      {
        id: runtimeIds.first,
        projectPath: '/srv/private/runtime-first',
        filePath: '/srv/private/runtime-first/session.jsonl',
        diagnostic: 'opened /srv/private/runtime-first from the local runtime',
        cloneTarget: 'https://git.example.test/private/first.git',
        repository: {
          remoteUrl: 'https://operator:token@git.example.test/private/first.git',
        },
      },
      {
        id: runtimeIds.second,
        projectPath: '/srv/private/runtime-second',
      },
    ]);
    app.get('/api/projects/:projectId/sessions', async (request) => ({
      projectId: (request.params as { projectId: string }).projectId,
    }));

    const first = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: '__Host-agent-teams-session=session-first' },
    });
    expect(first.json()).toEqual([{ id: publicIds.first }]);
    expect(first.body).not.toContain(runtimeIds.first);
    expect(first.body).not.toContain(runtimeIds.second);
    expect(first.body).not.toContain('/srv/private');
    expect(first.body).not.toContain('git.example.test');
    expect(first.body).not.toContain('operator:token');

    const crossWorkspace = await app.inject({
      method: 'GET',
      url: `/api/projects/${publicIds.second}/sessions`,
      headers: { cookie: '__Host-agent-teams-session=session-first' },
    });
    expect(crossWorkspace.statusCode).toBe(403);
    expect(crossWorkspace.json()).toEqual({ error: 'workspace_access_denied' });

    grants.get(firstUserId)!.clear();
    const revoked = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: '__Host-agent-teams-session=session-first' },
    });
    expect(revoked.json()).toEqual([]);
  });

  it('blocks newly registered HTTP routes until the hosted inventory classifies them', async () => {
    const { app } = harness('owner');
    app.get('/api', async () => ({ leaked: true }));
    app.get('/api/new-unreviewed-query', async () => ({ leaked: true }));
    for (const url of ['/api', '/api/new-unreviewed-query']) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'not_found' });
    }
  });

  it('ignores spoofed forwarding headers when no trusted proxy is configured', async () => {
    const { app, sourceIps } = harness('viewer');
    const response = await app.inject({
      method: 'GET',
      url: '/api/version',
      remoteAddress: '127.0.0.1',
      headers: {
        cookie,
        'x-forwarded-for': '203.0.113.99',
        forwarded: 'for=203.0.113.99;proto=https',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(sourceIps).toEqual(['127.0.0.1']);
  });
});

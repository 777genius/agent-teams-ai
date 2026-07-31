// @vitest-environment node

import {
  classifyHostedHttpAuthorization,
  permissionsForRole,
  roleAllows,
} from '@features/hosted-access';
import { registerHttpRoutes } from '@main/http';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

const HOSTED_STANDALONE_LEGACY_ROUTE_INVENTORY = Object.freeze([
  'DELETE /api/config/ignore-regex',
  'DELETE /api/config/ignore-repository',
  'DELETE /api/config/triggers/:triggerId',
  'DELETE /api/notifications',
  'DELETE /api/notifications/:id',
  'GET /api/config',
  'GET /api/config/triggers',
  'GET /api/dashboard/recent-projects',
  'GET /api/events',
  'GET /api/notifications',
  'GET /api/notifications/unread-count',
  'GET /api/projects',
  'GET /api/projects/:projectId/search',
  'GET /api/projects/:projectId/sessions',
  'GET /api/projects/:projectId/sessions-paginated',
  'GET /api/projects/:projectId/sessions/:sessionId',
  'GET /api/projects/:projectId/sessions/:sessionId/groups',
  'GET /api/projects/:projectId/sessions/:sessionId/metrics',
  'GET /api/projects/:projectId/sessions/:sessionId/subagents/:subagentId',
  'GET /api/projects/:projectId/sessions/:sessionId/waterfall',
  'GET /api/repository-groups',
  'GET /api/search',
  'GET /api/ssh/config-hosts',
  'GET /api/ssh/last-connection',
  'GET /api/ssh/state',
  'GET /api/teams',
  'GET /api/teams/:teamName',
  'GET /api/teams/:teamName/member-work-sync/:memberName',
  'GET /api/teams/:teamName/member-work-sync/diagnostics',
  'GET /api/teams/:teamName/member-work-sync/metrics',
  'GET /api/teams/:teamName/runtime',
  'GET /api/teams/provisioning/:runId',
  'GET /api/teams/runtime/alive',
  'GET /api/version',
  'GET /api/worktrees/:id/sessions',
  'POST /api/config/add-custom-project-path',
  'POST /api/config/clear-snooze',
  'POST /api/config/hide-session',
  'POST /api/config/hide-sessions',
  'POST /api/config/ignore-regex',
  'POST /api/config/ignore-repository',
  'POST /api/config/open-in-editor',
  'POST /api/config/pin-session',
  'POST /api/config/remove-custom-project-path',
  'POST /api/config/select-folders',
  'POST /api/config/snooze',
  'POST /api/config/triggers',
  'POST /api/config/triggers/:triggerId/test',
  'POST /api/config/unhide-session',
  'POST /api/config/unhide-sessions',
  'POST /api/config/unpin-session',
  'POST /api/config/update',
  'POST /api/notifications/:id/read',
  'POST /api/notifications/read-all',
  'POST /api/open-external',
  'POST /api/open-path',
  'POST /api/projects/:projectId/sessions-by-ids',
  'POST /api/read-agent-configs',
  'POST /api/read-claude-md',
  'POST /api/read-directory-claude-md',
  'POST /api/read-mentioned-file',
  'POST /api/session/scroll-to-line',
  'POST /api/ssh/connect',
  'POST /api/ssh/disconnect',
  'POST /api/ssh/resolve-host',
  'POST /api/ssh/save-last-connection',
  'POST /api/ssh/test',
  'POST /api/teams',
  'POST /api/teams/:teamName/launch',
  'POST /api/teams/:teamName/member-work-sync/:memberName/refresh',
  'POST /api/teams/:teamName/member-work-sync/report',
  'POST /api/teams/:teamName/opencode/runtime/bootstrap-checkin',
  'POST /api/teams/:teamName/opencode/runtime/deliver-message',
  'POST /api/teams/:teamName/opencode/runtime/heartbeat',
  'POST /api/teams/:teamName/opencode/runtime/task-event',
  'POST /api/teams/:teamName/stop',
  'POST /api/teams/lifecycle/read',
  'POST /api/updater/check',
  'POST /api/updater/download',
  'POST /api/updater/install',
  'POST /api/validate/mentions',
  'POST /api/validate/path',
  'PUT /api/config/triggers/:triggerId',
] as const);

const DEPLOYMENT_QUERY_ROUTES = new Set([
  'GET /api/config',
  'GET /api/dashboard/recent-projects',
  'GET /api/projects',
  'GET /api/repository-groups',
  'GET /api/search',
  'GET /api/version',
]);

const WORKSPACE_QUERY_ROUTES = new Set([
  'GET /api/projects/:projectId/search',
  'GET /api/projects/:projectId/sessions',
  'GET /api/projects/:projectId/sessions-paginated',
  'GET /api/projects/:projectId/sessions/:sessionId',
  'GET /api/projects/:projectId/sessions/:sessionId/groups',
  'GET /api/projects/:projectId/sessions/:sessionId/metrics',
  'GET /api/projects/:projectId/sessions/:sessionId/subagents/:subagentId',
  'GET /api/projects/:projectId/sessions/:sessionId/waterfall',
  'GET /api/worktrees/:id/sessions',
]);

const WORKSPACE_COMMAND_ROUTES = new Set([
  'POST /api/config/hide-session',
  'POST /api/config/hide-sessions',
  'POST /api/config/pin-session',
  'POST /api/config/unhide-session',
  'POST /api/config/unhide-sessions',
  'POST /api/config/unpin-session',
]);

function concreteRoutePath(path: string): string {
  return path.replace(/:[^/]+/gu, 'synthetic-segment');
}

async function registeredHostedStandaloneLegacyRoutes(
  includeHostedTaskBoard = false
): Promise<readonly string[]> {
  const app = Fastify();
  const routes: string[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method !== 'HEAD') routes.push(`${method} ${route.url}`);
    }
  });
  const hostedAuth = {
    allowedOrigin: 'https://agent-teams.test',
    register: () => undefined,
    projectWorkspaceId: () => Promise.resolve(null),
    projectPayload: () => Promise.resolve(null),
    projectEvent: () => Promise.resolve(null),
    isEventStreamAuthorized: () => Promise.resolve(false),
    isWorkspaceRegistered: () => Promise.resolve(false),
  };
  try {
    registerHttpRoutes(
      app,
      {
        projectScanner: {},
        sessionParser: {},
        subagentResolver: {},
        chunkBuilder: {},
        dataCache: {},
        recentProjectsFeature: {
          listDashboardRecentProjects: () => Promise.resolve({ projects: [], degraded: false }),
        },
        updaterService: {},
        sshConnectionManager: {},
        teamLifecycleReadHost: {
          listTeamLifecycle: () => Promise.resolve({ kind: 'failure' }),
        },
        hostedAuth,
        ...(includeHostedTaskBoard
          ? {
              hostedTeamTaskBoardRoutes: {
                register: (hostedApp: FastifyInstance) => {
                  hostedApp.post('/api/hosted/v1/team-task-board/page', () =>
                    Promise.resolve({ ok: true })
                  );
                  hostedApp.post('/api/hosted/v1/team-task-board/mutations', () =>
                    Promise.resolve({ ok: true })
                  );
                },
              },
            }
          : {}),
      } as never,
      () => Promise.resolve()
    );
    await app.ready();
    return Object.freeze([...new Set(routes)].sort((left, right) => left.localeCompare(right)));
  } finally {
    await app.close();
  }
}

describe('hosted HTTP authorization policy', () => {
  it('freezes the role matrix without implicit owner capabilities', () => {
    expect(permissionsForRole('owner')).toEqual([
      'hosted.query',
      'hosted.events',
      'hosted.command',
      'hosted.manage',
      'workspace.manage',
      'identity.manage',
    ]);
    expect(permissionsForRole('admin')).not.toContain('identity.manage');
    expect(roleAllows('viewer', 'hosted.query')).toBe(true);
    expect(roleAllows('viewer', 'hosted.command')).toBe(false);
    expect(roleAllows('member', 'hosted.manage')).toBe(false);
  });

  it('keeps login transports public and protects SSE separately', () => {
    expect(classifyHostedHttpAuthorization('GET', '/api/auth/status')).toEqual({
      kind: 'public',
    });
    expect(classifyHostedHttpAuthorization('GET', '/api/auth/oidc/callback?code=x')).toEqual({
      kind: 'public',
    });
    expect(classifyHostedHttpAuthorization('POST', '/api/auth/status')).toEqual({
      kind: 'forbidden',
    });
    expect(classifyHostedHttpAuthorization('GET', '/api/auth/oidc/backchannel-logout')).toEqual({
      kind: 'forbidden',
    });
    expect(classifyHostedHttpAuthorization('GET', '/api/events')).toEqual({
      kind: 'authenticated',
      permission: 'hosted.events',
      csrfRequired: false,
      workspaceRequired: false,
    });
  });

  it('requires CSRF for every mutation and a registration for workspace paths', () => {
    expect(
      classifyHostedHttpAuthorization('POST', '/api/projects/project_12345678/sessions-by-ids')
    ).toEqual({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: true,
      workspaceRequired: true,
    });
    expect(classifyHostedHttpAuthorization('POST', '/api/config/pin-session')).toEqual({
      kind: 'authenticated',
      permission: 'hosted.command',
      csrfRequired: true,
      workspaceRequired: true,
    });
    expect(classifyHostedHttpAuthorization('POST', '/api/hosted/v1/team-task-board/page')).toEqual({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: true,
      workspaceRequired: false,
      teamWorkspaceRequired: true,
    });
    expect(
      classifyHostedHttpAuthorization('POST', '/api/hosted/v1/team-task-board/mutations')
    ).toEqual({
      kind: 'authenticated',
      permission: 'hosted.command',
      csrfRequired: true,
      workspaceRequired: false,
      teamWorkspaceRequired: true,
    });
  });

  it('mounts both task-board routes only through complete hosted composition', async () => {
    const routes = await registeredHostedStandaloneLegacyRoutes(true);
    expect(routes).toEqual(
      Object.freeze(
        [
          ...HOSTED_STANDALONE_LEGACY_ROUTE_INVENTORY,
          'POST /api/hosted/v1/team-task-board/mutations',
          'POST /api/hosted/v1/team-task-board/page',
        ].sort((left, right) => left.localeCompare(right))
      )
    );

    const app = Fastify();
    expect(() =>
      registerHttpRoutes(
        app,
        {
          hostedAuth: {
            register: () => undefined,
          },
          hostedTeamTaskBoardRoutes: {},
        } as never,
        () => Promise.resolve()
      )
    ).toThrow('hosted_task_board_composition_invalid');
    await app.close();

    const nonHostedApp = Fastify();
    expect(() =>
      registerHttpRoutes(
        nonHostedApp,
        {
          hostedTeamTaskBoardRoutes: {
            register: () => undefined,
          },
        } as never,
        () => Promise.resolve()
      )
    ).toThrow('hosted_task_board_composition_invalid');
    await nonHostedApp.close();
  });

  it.each([
    '/api/ssh/connect',
    '/api/updater/install',
    '/api/open-path',
    '/api/read-claude-md',
    '/api/read-directory-claude-md',
    '/api/read-mentioned-file',
    '/api/validate/path',
    '/api/config/update',
    '/api/config/add-custom-project-path',
    '/api/notifications',
    '/api/terminal/spawn',
    '/api/teams/synthetic/launch',
    '/api/teams/synthetic/stop',
    '/api/teams/synthetic/opencode/runtime/deliver-message',
  ])('removes post-v1 or unsafe route %s', (path) => {
    expect(classifyHostedHttpAuthorization('POST', path)).toEqual({ kind: 'forbidden' });
  });

  it('denies unknown API routes until the inventory classifies them', () => {
    expect(classifyHostedHttpAuthorization('GET', '/api')).toEqual({
      kind: 'forbidden',
    });
    expect(classifyHostedHttpAuthorization('GET', '/api/new-unreviewed-query')).toEqual({
      kind: 'forbidden',
    });
    expect(classifyHostedHttpAuthorization('POST', '/api/new-unreviewed-command')).toEqual({
      kind: 'forbidden',
    });
  });

  it('freezes every hosted standalone legacy route and its server authorization decision', async () => {
    const routes = await registeredHostedStandaloneLegacyRoutes();
    expect(routes).toEqual(HOSTED_STANDALONE_LEGACY_ROUTE_INVENTORY);

    for (const route of routes) {
      const separator = route.indexOf(' ');
      const method = route.slice(0, separator);
      const routePath = route.slice(separator + 1);
      const authorization = classifyHostedHttpAuthorization(method, concreteRoutePath(routePath));
      if (route === 'GET /api/events') {
        expect(authorization, route).toEqual({
          kind: 'authenticated',
          permission: 'hosted.events',
          csrfRequired: false,
          workspaceRequired: false,
        });
      } else if (DEPLOYMENT_QUERY_ROUTES.has(route)) {
        expect(authorization, route).toEqual({
          kind: 'authenticated',
          permission: 'hosted.query',
          csrfRequired: false,
          workspaceRequired: false,
        });
      } else if (WORKSPACE_QUERY_ROUTES.has(route)) {
        expect(authorization, route).toEqual({
          kind: 'authenticated',
          permission: 'hosted.query',
          csrfRequired: false,
          workspaceRequired: true,
        });
      } else if (route === 'POST /api/projects/:projectId/sessions-by-ids') {
        expect(authorization, route).toEqual({
          kind: 'authenticated',
          permission: 'hosted.query',
          csrfRequired: true,
          workspaceRequired: true,
        });
      } else if (route === 'POST /api/teams/lifecycle/read') {
        expect(authorization, route).toEqual({
          kind: 'authenticated',
          permission: 'hosted.query',
          csrfRequired: true,
          workspaceRequired: false,
        });
      } else if (WORKSPACE_COMMAND_ROUTES.has(route)) {
        expect(authorization, route).toEqual({
          kind: 'authenticated',
          permission: 'hosted.command',
          csrfRequired: true,
          workspaceRequired: true,
        });
      } else {
        expect(authorization, route).toEqual({ kind: 'forbidden' });
      }
    }
  });

  it('canonicalizes origin-form targets and rejects ambiguous request-target forms', () => {
    for (const path of [
      'https://agent-teams.test/api/config',
      '//agent-teams.test/api/config',
      String.raw`\api\config`,
      '/api/%ZZ',
      '/public%3F/api/config',
    ]) {
      expect(classifyHostedHttpAuthorization('GET', path)).toEqual({ kind: 'forbidden' });
    }
    expect(classifyHostedHttpAuthorization('GET', '/public/../api/config')).toEqual({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: false,
      workspaceRequired: false,
    });
    expect(classifyHostedHttpAuthorization('GET', '/%61pi/config')).toEqual({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: false,
      workspaceRequired: false,
    });
  });
});

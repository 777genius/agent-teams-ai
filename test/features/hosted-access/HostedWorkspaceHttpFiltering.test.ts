/* eslint-disable @typescript-eslint/require-await -- Async route test doubles implement promise-based HTTP ports synchronously. */

import { registerProjectRoutes } from '@main/http/projects';
import { registerSearchRoutes } from '@main/http/search';
import { registerTeamRoutes } from '@main/http/teams';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { HttpServices } from '@main/http';
import type { FastifyInstance } from 'fastify';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('hosted workspace HTTP filtering', () => {
  it('never searches an unregistered project during global search', async () => {
    const searched: string[] = [];
    const app = Fastify();
    apps.push(app);
    const services = {
      hostedAuth: {
        projectWorkspaceId: async (_request: unknown, workspaceId: string) =>
          workspaceId === 'project_registered-1'
            ? 'workspace_cccccccccccccccccccccccccccccccc'
            : null,
      },
      projectScanner: {
        scan: async () => [{ id: 'project_registered-1' }, { id: 'project_unregistered-1' }],
        searchSessions: async (projectId: string, query: string) => {
          searched.push(projectId);
          return {
            results: [
              {
                projectId,
                sessionId: 'session_synthetic-1',
                timestamp: 100,
                query,
              },
            ],
            totalMatches: 1,
            sessionsSearched: 1,
            query,
          };
        },
      },
    } as unknown as HttpServices;
    registerSearchRoutes(app, services);

    const response = await app.inject({ method: 'GET', url: '/api/search?q=synthetic' });

    expect(response.statusCode).toBe(200);
    expect(searched).toEqual(['project_registered-1']);
    expect(response.json()).toMatchObject({
      results: [{ projectId: 'project_registered-1' }],
      totalMatches: 1,
      sessionsSearched: 1,
    });
    expect(response.body).not.toContain('project_unregistered-1');
  });

  it('removes unregistered workspaces from hosted team lifecycle reads', async () => {
    const app = Fastify();
    apps.push(app);
    const services = {
      hostedAuth: {
        projectWorkspaceId: async (_request: unknown, workspaceId: string) =>
          workspaceId === 'workspace_registered-1'
            ? 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
            : null,
      },
      teamLifecycleReadHost: {
        listTeamLifecycle: async () => ({
          schemaVersion: 1,
          kind: 'success',
          snapshotRevision: `revision_${'a'.repeat(64)}`,
          items: [
            {
              workspaceId: 'workspace_registered-1',
              teamId: 'team_registered-1',
              displayName: 'Registered',
              lifecycle: 'active',
              revision: `revision_${'b'.repeat(64)}`,
            },
            {
              workspaceId: 'workspace_unregistered-1',
              teamId: 'team_unregistered-1',
              displayName: 'Unregistered',
              lifecycle: 'active',
              revision: `revision_${'c'.repeat(64)}`,
            },
          ],
          nextCursor: null,
        }),
      },
    } as unknown as HttpServices;
    registerTeamRoutes(app, services);

    const response = await app.inject({
      method: 'POST',
      url: '/api/teams/lifecycle/read',
      payload: { schemaVersion: 1, cursor: null, expectedRevision: null },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: 'success',
      items: [{ workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
    });
    expect(response.body).not.toContain('workspace_unregistered-1');
  });

  it('projects projects and repository groups to opaque IDs without host or Git internals', async () => {
    const absolutePath = '/srv/private/runtime/workspace-one';
    const credentialedRemote = 'https://operator:token@git.example.test/private/repo.git';
    const runtimeWorkspaceId = '-srv-private-runtime-workspace-one';
    const publicWorkspaceId = 'workspace_cccccccccccccccccccccccccccccccc';
    const project = {
      id: runtimeWorkspaceId,
      path: absolutePath,
      name: 'Workspace one',
      sessions: ['session-synthetic-1'],
      totalSessions: 1,
      createdAt: 100,
      gitBranch: 'private-branch',
    };
    const app = Fastify();
    apps.push(app);
    const services = {
      hostedAuth: {
        projectWorkspaceId: async (_request: unknown, workspaceId: string) =>
          workspaceId === runtimeWorkspaceId ? publicWorkspaceId : null,
      },
      projectScanner: {
        scan: async () => [project],
        scanWithWorktreeGrouping: async () => [
          {
            id: 'repository-private-hash',
            identity: {
              id: 'repository-private-hash',
              remoteUrl: credentialedRemote,
              mainGitDir: `${absolutePath}/.git`,
              name: 'private-repo',
            },
            worktrees: [
              {
                ...project,
                isMainWorktree: true,
                source: 'git',
                gitBranch: 'private-branch',
              },
            ],
            name: 'Workspace one',
            totalSessions: 1,
          },
        ],
      },
    } as unknown as HttpServices;
    registerProjectRoutes(app, services);

    const projects = await app.inject({ method: 'GET', url: '/api/projects' });
    const groups = await app.inject({ method: 'GET', url: '/api/repository-groups' });

    expect(projects.json()).toMatchObject([{ id: publicWorkspaceId }]);
    expect(groups.json()).toMatchObject([
      {
        id: publicWorkspaceId,
        identity: null,
        worktrees: [{ id: publicWorkspaceId }],
      },
    ]);
    for (const body of [projects.body, groups.body]) {
      expect(body).not.toContain(runtimeWorkspaceId);
      expect(body).not.toContain(absolutePath);
      expect(body).not.toContain(credentialedRemote);
      expect(body).not.toContain('mainGitDir');
      expect(body).not.toContain('gitBranch');
    }
  });

  it('derives repository recency exclusively from granted worktrees', async () => {
    const grantedRuntimeId = '-srv-private-runtime-granted';
    const deniedRuntimeId = '-srv-private-runtime-denied';
    const publicWorkspaceId = 'workspace_dddddddddddddddddddddddddddddddd';
    const app = Fastify();
    apps.push(app);
    const services = {
      hostedAuth: {
        projectWorkspaceId: async (_request: unknown, workspaceId: string) =>
          workspaceId === grantedRuntimeId ? publicWorkspaceId : null,
      },
      projectScanner: {
        scanWithWorktreeGrouping: async () => [
          {
            id: 'repository-private-hash',
            name: 'Mixed grants',
            mostRecentSession: 9_000,
            worktrees: [
              {
                id: grantedRuntimeId,
                name: 'Granted',
                sessions: ['session-granted'],
                totalSessions: 1,
                mostRecentSession: 1_000,
              },
              {
                id: deniedRuntimeId,
                name: 'Denied',
                sessions: ['session-denied'],
                totalSessions: 1,
                mostRecentSession: 9_000,
              },
            ],
          },
        ],
      },
    } as unknown as HttpServices;
    registerProjectRoutes(app, services);

    const response = await app.inject({ method: 'GET', url: '/api/repository-groups' });

    expect(response.json()).toMatchObject([
      {
        id: publicWorkspaceId,
        mostRecentSession: 1_000,
        totalSessions: 1,
        worktrees: [{ id: publicWorkspaceId, mostRecentSession: 1_000 }],
      },
    ]);
    expect(response.body).not.toContain(deniedRuntimeId);
    expect(response.body).not.toContain('session-denied');
    expect(response.body).not.toContain('9000');
  });
});

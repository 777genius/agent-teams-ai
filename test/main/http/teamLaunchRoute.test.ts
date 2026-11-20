import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamMetadataUnreadableError } from '../../../src/features/team-project-context/main';
import { registerTeamRoutes } from '../../../src/main/http/teams';
import { setClaudeBasePathOverride } from '../../../src/main/utils/pathDecoder';

import type { ProjectTeamLaunch } from '../../../src/features/team-project-context/main';
import type { HttpServices } from '../../../src/main/http';
import type { TeamCreateRequest, TeamLaunchRequest } from '../../../src/shared/types';

const roots: string[] = [];

afterEach(async () => {
  setClaudeBasePathOverride(null);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A claude root with one team directory per entry: valid metadata, or a broken file. */
async function claudeRoot(teams: Record<string, 'per_project' | 'unreadable'>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'http-launch-route-')));
  roots.push(root);
  setClaudeBasePathOverride(root);
  for (const [teamName, meta] of Object.entries(teams)) {
    const dir = path.join(root, 'teams', teamName);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'team.meta.json'),
      meta === 'unreadable'
        ? '{ not json'
        : JSON.stringify({ version: 1, cwd: root, createdAt: 1, projectContextMode: meta })
    );
  }
  const project = path.join(root, 'project');
  await mkdir(project);
  return { root, project };
}

function app(services: Partial<HttpServices>) {
  const launchTeam = vi.fn(async () => ({ runId: 'native-run' }));
  const createTeam = vi.fn(async () => ({ runId: 'copy-run' }));
  const instance = Fastify();
  registerTeamRoutes(instance, {
    teamApis: { provisioningStart: { launchTeam, createTeam } },
    ...services,
  } as unknown as HttpServices);
  const launch = (teamName: string, payload: Record<string, unknown>) =>
    instance.inject({ method: 'POST', url: `/api/teams/${teamName}/launch`, payload });
  return { instance, launch, launchTeam, createTeam };
}

describe('POST /api/teams/:team/launch of a team with separate history per project', () => {
  it('refuses a team whose metadata is unreadable, with and without the launch port', async () => {
    const { project } = await claudeRoot({ broken: 'unreadable' });
    const withoutPort = app({});
    const port = {
      classify: vi.fn(async () => {
        throw new TeamMetadataUnreadableError('Team metadata is unreadable');
      }),
    } as unknown as ProjectTeamLaunch;
    const withPort = app({ projectTeamLaunch: () => port });
    try {
      for (const { launch, launchTeam } of [withoutPort, withPort]) {
        const response = await launch('broken', { cwd: project });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'TEAM_METADATA_UNREADABLE' });
        expect(launchTeam).not.toHaveBeenCalled();
      }
    } finally {
      await withoutPort.instance.close();
      await withPort.instance.close();
    }
  });

  it('refuses a per-project team when the launch port is not wired, and never launches it natively', async () => {
    const { project } = await claudeRoot({ builders: 'per_project' });
    const { instance, launch, launchTeam, createTeam } = app({});
    try {
      const response = await launch('builders', { cwd: project });
      expect(response.statusCode).toBe(501);
      expect(launchTeam).not.toHaveBeenCalled();
      expect(createTeam).not.toHaveBeenCalled();
      const copyByShape = await launch('ptc-0123456789abcdef01234567', { cwd: project });
      expect(copyByShape.statusCode).toBe(409);
      expect(copyByShape.json()).toMatchObject({ code: 'PROJECT_COPY_NOT_LAUNCHABLE' });
    } finally {
      await instance.close();
    }
  });

  // Without the management feature the route takes the team lock itself; the use case gets the
  // parsed request (unknown fields dropped), and the copy is launched with the canonical folder
  // and without the team name of the body.
  it('launches under the team lock without the management feature, with the parsed request', async () => {
    const { project } = await claudeRoot({});
    const definition: TeamCreateRequest = {
      teamName: 'builders',
      cwd: project,
      providerId: 'codex',
      projectContextMode: 'per_project',
      members: [{ name: 'builder', role: 'Engineer' }],
    };
    const copyDraft: TeamCreateRequest = {
      ...definition,
      teamName: 'ptc-copy',
      projectContextMode: 'shared',
    };
    const getSavedRequest = vi.fn(async (teamName: string) =>
      teamName === 'builders' ? definition : teamName === 'ptc-copy' ? copyDraft : null
    );
    const order: string[] = [];
    let useCaseRequest: TeamLaunchRequest | null = null;
    const port: ProjectTeamLaunch = {
      classify: vi.fn(async () => 'logical' as const),
      inspectCopy: vi.fn(async () => null),
      withTeamLock: vi.fn(async (teamName, operation) => {
        order.push(`lock:${teamName}`);
        return operation();
      }),
      launch: vi.fn(async (request, launcher) => {
        order.push('launch');
        useCaseRequest = request;
        return launcher.invoke({ ...request, teamName: 'ptc-copy', cwd: project });
      }),
      publicProgress: (progress) => progress,
    };
    const { instance, launch, createTeam } = app({
      projectTeamLaunch: () => port,
      teamDataApi: { getSavedRequest } as unknown as HttpServices['teamDataApi'],
    });
    try {
      const response = await launch('builders', {
        cwd: project,
        teamName: 'builders',
        prompt: 'Start here',
        bogus: 'dropped',
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(order).toEqual(['lock:builders', 'launch']);
      expect(useCaseRequest).toMatchObject({
        teamName: 'builders',
        cwd: project,
        prompt: 'Start here',
        providerId: 'codex',
      });
      expect(useCaseRequest).not.toHaveProperty('bogus');
      expect(createTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName: 'ptc-copy',
          cwd: project,
          projectContextMode: 'shared',
        }),
        expect.any(Function)
      );
    } finally {
      await instance.close();
    }
  });
});

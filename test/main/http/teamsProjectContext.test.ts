import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamProjectContextRegistry } from '../../../src/features/team-project-context/main';
import { registerTeamRoutes } from '../../../src/main/http/teams';
import { claimTeamForThisProfile } from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';

import type { HttpServices } from '../../../src/main/http';
import type { TeamMetaFile } from '../../../src/main/services/team/TeamMetaStore';
import type { TeamRuntimeState, TeamSummary } from '../../../src/shared/types';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  registry: TeamProjectContextRegistry;
  meta: Record<string, TeamMetaFile | 'unreadable'>;
  aliasA: string;
  aliasB: string;
  projectA: string;
  projectB: string;
}

/** A per-project team `builders` with two ready project copies, on a real temp dir. */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'http-project-context-'));
  roots.push(root);
  const teamsBasePath = path.join(root, 'teams');
  const tasksBasePath = path.join(root, 'tasks');
  const projectA = path.join(root, 'a');
  const projectB = path.join(root, 'b');
  await Promise.all([
    mkdir(path.join(teamsBasePath, 'builders'), { recursive: true }),
    mkdir(tasksBasePath, { recursive: true }),
    mkdir(projectA),
    mkdir(projectB),
  ]);
  await claimTeamForThisProfile({
    teamsBasePath, teamName: 'builders', reason: 'create', profileScope: 'test-profile',
  });
  const registry = new TeamProjectContextRegistry({
    teamsBasePath, tasksBasePath, profileScope: 'test-profile',
  });
  const materialize = async (project: string): Promise<string> => {
    const reserved = await registry.reserve('builders', project);
    await mkdir(path.join(teamsBasePath, reserved.executionTeamName), { recursive: true });
    await mkdir(path.join(tasksBasePath, reserved.executionTeamName), { recursive: true });
    await writeFile(
      path.join(teamsBasePath, reserved.executionTeamName, 'config.json'),
      JSON.stringify({ name: reserved.executionTeamName })
    );
    await claimTeamForThisProfile({
      teamsBasePath,
      teamName: reserved.executionTeamName,
      reason: 'create',
      profileScope: 'test-profile',
    });
    await registry.confirmReady('builders', project, reserved.executionTeamName);
    return reserved.executionTeamName;
  };
  const aliasA = await materialize(projectA);
  const aliasB = await materialize(projectB);
  return {
    registry,
    aliasA,
    aliasB,
    projectA,
    projectB,
    meta: {
      builders: { projectContextMode: 'per_project' } as TeamMetaFile,
      [aliasA]: { projectContextMode: 'shared' } as TeamMetaFile,
      [aliasB]: { projectContextMode: 'shared' } as TeamMetaFile,
    },
  };
}

function summary(teamName: string, patch: Partial<TeamSummary> = {}): TeamSummary {
  return {
    teamName,
    displayName: 'Builders',
    description: '',
    memberCount: 2,
    taskCount: 1,
    lastActivity: null,
    ...patch,
  };
}

async function createApp(f: Fixture, initialAlive: string[]) {
  const alive = new Set(initialAlive);
  const progress = new Map<string, TeamRuntimeState['progress']>();
  const stopTeam = vi.fn(async (team: string) => {
    alive.delete(team);
  });
  const getRuntimeState = vi.fn(
    async (team: string): Promise<TeamRuntimeState> => ({
      teamName: team,
      isAlive: alive.has(team),
      runId: alive.has(team) ? `run-${team}` : null,
      progress: progress.get(team) ?? null,
    })
  );
  const listTeams = vi.fn(async () => [] as TeamSummary[]);
  const services = {
    projectScanner: {} as HttpServices['projectScanner'],
    sessionParser: {} as HttpServices['sessionParser'],
    subagentResolver: {} as HttpServices['subagentResolver'],
    chunkBuilder: {} as HttpServices['chunkBuilder'],
    dataCache: {} as HttpServices['dataCache'],
    updaterService: {} as HttpServices['updaterService'],
    sshConnectionManager: {} as HttpServices['sshConnectionManager'],
    teamDataApi: { listTeams } as unknown as HttpServices['teamDataApi'],
    teamApis: {
      runtime: { getRuntimeState, stopTeam, getAliveTeams: () => [...alive] },
    } as unknown as HttpServices['teamApis'],
    projectContext: {
      meta: {
        getMeta: async (name: string) => {
          const entry = f.meta[name];
          if (entry === 'unreadable') return null;
          return entry ?? null;
        },
        metadataFileExists: async (name: string) => f.meta[name] === 'unreadable',
      },
      registry: f.registry,
    },
  } as HttpServices;
  const app = Fastify();
  registerTeamRoutes(app, services);
  await app.ready();
  return { app, stopTeam, getRuntimeState, listTeams, alive };
}

describe('HTTP routes for a per-project (logical) team', () => {
  it('stop reaches every running project copy and reports the team as down', async () => {
    const f = await fixture();
    const { app, stopTeam, alive } = await createApp(f, [f.aliasA, f.aliasB]);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(200);
      // Stopping the logical name alone would be a silent no-op.
      expect(stopTeam.mock.calls.map(([team]) => team).sort()).toEqual([f.aliasA, f.aliasB].sort());
      expect(alive.size).toBe(0);
      expect(response.json()).toMatchObject({ teamName: 'builders', isAlive: false, runId: null });
      expect(response.json().contexts).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('stop of one running copy leaves the idle copy alone and still succeeds', async () => {
    const f = await fixture();
    const { app, stopTeam } = await createApp(f, [f.aliasB]);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(200);
      expect(response.json().isAlive).toBe(false);
      expect(stopTeam).toHaveBeenCalledWith(f.aliasB);
    } finally {
      await app.close();
    }
  });

  it('stop answers 409 and names the project when a copy cannot be stopped', async () => {
    const f = await fixture();
    const { app, stopTeam } = await createApp(f, [f.aliasA, f.aliasB]);
    stopTeam.mockImplementation(async (team: string) => {
      if (team === f.aliasB) throw new Error('stop command exited with 1');
    });
    // The native stop of the failing copy logs its escalation; that is expected here.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain(f.projectB);
      expect(response.json().error).toContain(f.aliasB);
      // The other copy was still stopped: one failure does not abandon the rest.
      expect(stopTeam).toHaveBeenCalledWith(f.aliasA);
      expect(warn).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('runtime is alive when any project copy is alive and lists the contexts', async () => {
    const f = await fixture();
    const { app } = await createApp(f, [f.aliasB]);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/teams/builders/runtime' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ teamName: 'builders', isAlive: true, runId: `run-${f.aliasB}` });
      expect(body.contexts.map((c: { projectPath: string; isAlive: boolean }) => c.isAlive)).toEqual(
        expect.arrayContaining([true, false])
      );
    } finally {
      await app.close();
    }
  });

  it('runtime/alive keeps physical entries and adds the logical team once', async () => {
    const f = await fixture();
    const { app } = await createApp(f, [f.aliasA, f.aliasB, 'legacy']);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/teams/runtime/alive' });
      expect(response.statusCode).toBe(200);
      const names = (response.json() as { teamName: string }[]).map((entry) => entry.teamName);
      expect(names).toEqual(expect.arrayContaining([f.aliasA, f.aliasB, 'legacy', 'builders']));
      expect(names.filter((name) => name === 'builders')).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('stopping one project copy by its own name stays an exact stop', async () => {
    const f = await fixture();
    const { app, stopTeam } = await createApp(f, [f.aliasA, f.aliasB]);
    try {
      const response = await app.inject({ method: 'POST', url: `/api/teams/${f.aliasA}/stop` });
      expect(response.statusCode).toBe(200);
      expect(stopTeam.mock.calls.map(([team]) => team)).toEqual([f.aliasA]);
      expect(response.json().teamName).toBe(f.aliasA);
    } finally {
      await app.close();
    }
  });

  it('refuses with 409 when the team metadata is unreadable: never an ordinary team', async () => {
    const f = await fixture();
    f.meta['broken-team'] = 'unreadable';
    const { app, stopTeam } = await createApp(f, ['broken-team']);
    try {
      for (const request of [
        { method: 'POST' as const, url: '/api/teams/broken-team/stop' },
        { method: 'POST' as const, url: '/api/teams/broken-team/force-stop' },
        { method: 'GET' as const, url: '/api/teams/broken-team/runtime' },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toContain('unreadable');
      }
      expect(stopTeam).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('an ordinary team is stopped and read exactly as before', async () => {
    const f = await fixture();
    const { app, stopTeam } = await createApp(f, ['legacy']);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/legacy/stop' });
      expect(response.statusCode).toBe(200);
      expect(stopTeam).toHaveBeenCalledWith('legacy');
      expect(response.json()).toEqual({ teamName: 'legacy', isAlive: false, runId: null, progress: null });
    } finally {
      await app.close();
    }
  });
});

describe('HTTP team list for a per-project team', () => {
  it('lists the logical team once, with its contexts, and hides its project copies', async () => {
    const f = await fixture();
    const { app, listTeams } = await createApp(f, []);
    listTeams.mockResolvedValue([
      summary('builders', { pendingCreate: true, taskCount: 0 }),
      summary(f.aliasA, { taskCount: 1 }),
      summary(f.aliasB, { taskCount: 2 }),
      summary('legacy', { displayName: 'Legacy' }),
    ]);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/teams' });
      expect(response.statusCode).toBe(200);
      const teams = response.json() as TeamSummary[];
      expect(teams.map((team) => team.teamName).sort()).toEqual(['builders', 'legacy']);
      const logical = teams.find((team) => team.teamName === 'builders');
      expect(logical).toMatchObject({
        projectContextMode: 'per_project',
        pendingCreate: false,
        taskCount: 3,
      });
      expect(logical?.projectHistoryContexts?.map((context) => context.projectPath).sort()).toEqual(
        [f.projectA, f.projectB].sort()
      );
    } finally {
      await app.close();
    }
  });
});

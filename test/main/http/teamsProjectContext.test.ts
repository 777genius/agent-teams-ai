import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

// The stop flow reaches for the real home directory (lane indexes, runtime manifests,
// launch state, retained runtime hosts, lead process trees). Nothing of that belongs in
// a route test: every such read or cleanup is replaced by an empty answer.
const liveRuntimeHosts = vi.hoisted(() => vi.fn(async (): Promise<number | null> => 0));
const reapLeadTrees = vi.hoisted(() =>
  vi.fn(async () => ({ killedPids: [] as number[], incomplete: false, diagnostics: [] as string[] }))
);

vi.mock('@main/services/team/lifecycle/teamForceStopFlow', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@main/services/team/lifecycle/teamForceStopFlow')>();
  return {
    ...actual,
    readOpenCodeRuntimeLaneIdsForTeam: vi.fn(async () => [] as string[]),
    readOwnedOpenCodeRuntimeRunIdsForTeam: vi.fn(async () => [] as string[]),
    countLiveRecordedRuntimeHostsForTeam: liveRuntimeHosts,
    releaseLoopbackRuntimesReservedByTeam: vi.fn(async () => undefined),
    releaseSharedRuntimeResourcesAfterStop: vi.fn(async () => ({ diagnostics: [] as string[] })),
    killRetainedOpenCodeRuntimeProcessesForTeam: vi.fn(() =>
      Promise.resolve({ killedPids: [], diagnostics: [] })
    ),
    clearPendingOpenCodePromptDeliveriesForTeam: vi.fn(() =>
      Promise.resolve({ cleared: 0, diagnostics: [] })
    ),
  };
});

vi.mock('@main/services/team/lifecycle/teamLeadProcessTreeReap', () => ({
  reapCursorAgentLeadTreesForStoppedTeam: reapLeadTrees,
}));

vi.mock('@main/services/team/TeamLaunchStateStore', () => ({
  TeamLaunchStateStore: vi.fn(() => ({
    read: vi.fn(() => Promise.resolve(null)),
    beginStop: async (teamName: string) => ({ teamName, stopIntent: 1, freshness: null }),
    markStopped: vi.fn(() => Promise.resolve()),
  })),
}));

const roots: string[] = [];

afterEach(async () => {
  liveRuntimeHosts.mockReset();
  liveRuntimeHosts.mockResolvedValue(0);
  reapLeadTrees.mockReset();
  reapLeadTrees.mockResolvedValue({ killedPids: [], incomplete: false, diagnostics: [] });
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  registry: TeamProjectContextRegistry;
  meta: Record<string, TeamMetaFile | 'unreadable'>;
  aliasA: string;
  aliasB: string;
  projectA: string;
  projectB: string;
  /** A claimed team directory, like one a user created. */
  claimTeam(teamName: string): Promise<void>;
  /** A project copy of `team`: ready (materialized) or only reserved (an owner-marked directory). */
  addCopy(team: string, state: 'ready' | 'reserved'): Promise<{ alias: string; project: string }>;
}

/** A per-project team `builders` with two ready project copies, on a real temp dir. */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'http-project-context-'));
  roots.push(root);
  const teamsBasePath = path.join(root, 'teams');
  const tasksBasePath = path.join(root, 'tasks');
  await Promise.all([
    mkdir(path.join(teamsBasePath, 'builders'), { recursive: true }),
    mkdir(tasksBasePath, { recursive: true }),
  ]);
  const claim = (teamName: string) =>
    claimTeamForThisProfile({ teamsBasePath, teamName, reason: 'create', profileScope: 'test-profile' });
  await claim('builders');
  const registry = new TeamProjectContextRegistry({
    teamsBasePath, tasksBasePath, profileScope: 'test-profile',
  });
  let projects = 0;
  const addCopy: Fixture['addCopy'] = async (team, state) => {
    const dir = path.join(root, `project-${projects++}`);
    await mkdir(dir);
    // The registry stores the canonical path (macOS tmp is a symlink).
    const project = await realpath(dir);
    const reserved = await registry.reserve(team, project);
    const alias = reserved.executionTeamName;
    await mkdir(path.join(teamsBasePath, alias), { recursive: true });
    await mkdir(path.join(tasksBasePath, alias), { recursive: true });
    if (state === 'ready') {
      await writeFile(path.join(teamsBasePath, alias, 'config.json'), JSON.stringify({ name: alias }));
    }
    await claim(alias);
    if (state === 'ready') await registry.confirmReady(team, project, alias);
    return { alias, project };
  };
  const a = await addCopy('builders', 'ready');
  const b = await addCopy('builders', 'ready');
  return {
    registry,
    aliasA: a.alias,
    aliasB: b.alias,
    projectA: a.project,
    projectB: b.project,
    claimTeam: async (teamName) => {
      await mkdir(path.join(teamsBasePath, teamName), { recursive: true });
      await claim(teamName);
    },
    addCopy,
    meta: {
      builders: { projectContextMode: 'per_project' } as TeamMetaFile,
      [a.alias]: { projectContextMode: 'shared' } as TeamMetaFile,
      [b.alias]: { projectContextMode: 'shared' } as TeamMetaFile,
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

async function createApp(f: Fixture, initialAlive: string[], stopVerification = { attempts: 3, delayMs: 0 }) {
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
      stopVerification,
    },
  } as HttpServices;
  const app = Fastify();
  registerTeamRoutes(app, services);
  await app.ready();
  return { app, stopTeam, getRuntimeState, listTeams, alive, progress };
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

  it('stop with one running copy also stops the idle copy and succeeds', async () => {
    const f = await fixture();
    const { app, stopTeam } = await createApp(f, [f.aliasB]);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(200);
      expect(response.json().isAlive).toBe(false);
      // Every copy is asked: an idle one is already down, which the stop flow accepts.
      expect(stopTeam.mock.calls.map(([team]) => team).sort()).toEqual([f.aliasA, f.aliasB].sort());
    } finally {
      await app.close();
    }
  });

  it('stop answers 409 with a machine-readable body when a copy cannot be stopped', async () => {
    const f = await fixture();
    const { app, stopTeam, alive } = await createApp(f, [f.aliasA, f.aliasB]);
    stopTeam.mockImplementation(async (team: string) => {
      if (team === f.aliasB) throw new Error('stop command exited with 1');
      alive.delete(team);
    });
    // The native stop of the failing copy logs its escalation; that is expected here.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.error).toContain(f.projectB);
      expect(body.error).toContain(f.aliasB);
      expect(body.code).toBe('LOGICAL_STOP_INCOMPLETE');
      expect(body.outcome.complete).toBe(false);
      expect(
        body.outcome.contexts.map((c: { executionTeamName: string; stillAlive: boolean }) => [
          c.executionTeamName,
          c.stillAlive,
        ])
      ).toEqual(expect.arrayContaining([[f.aliasA, false], [f.aliasB, true]]));
      // The other copy was still stopped: one failure does not abandon the rest.
      expect(stopTeam).toHaveBeenCalledWith(f.aliasA);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('stop counts a copy whose bootstrap owner died as stopped, like the in-app Stop', async () => {
    const f = await fixture();
    const { app, getRuntimeState } = await createApp(f, [f.aliasA]);
    // What a dead bootstrap owner reports once the process is gone: not alive, the run id still
    // set and a failed progress (TeamBootstrapStateReader).
    getRuntimeState.mockImplementation(async (team: string) => ({
      teamName: team,
      isAlive: false,
      runId: team === f.aliasA ? 'run-dead' : null,
      progress:
        team === f.aliasA
          ? ({ runId: 'run-dead', teamName: team, state: 'failed' } as TeamRuntimeState['progress'])
          : null,
    }));
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(200);
      expect(response.json().isAlive).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('stop is a 409 while the bootstrap owner of a copy is still running', async () => {
    const f = await fixture();
    const { app, getRuntimeState } = await createApp(f, [f.aliasA]);
    // Not alive yet, but its bootstrap owner is, and the run is still being provisioned.
    getRuntimeState.mockImplementation(async (team: string) => ({
      teamName: team,
      isAlive: false,
      runId: team === f.aliasA ? 'run-live' : null,
      progress:
        team === f.aliasA
          ? ({ runId: 'run-live', teamName: team, state: 'configuring' } as TeamRuntimeState['progress'])
          : null,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('LOGICAL_STOP_INCOMPLETE');
      expect(response.json().error).toContain('still running after the stop');
      // An operator must be able to see which copy kept running.
      expect(warn.mock.calls.flat().join('\n')).toContain('POST /api/teams/builders/stop');
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('stop waits for a run id that is cleared a moment after the stop, then answers truthfully', async () => {
    const f = await fixture();
    const { app, stopTeam, getRuntimeState, alive } = await createApp(f, [f.aliasA], {
      attempts: 6,
      delayMs: 0,
    });
    // runtime_already_down: the stop is acknowledged but the tracked run id lingers for two reads.
    let lingering = 0;
    stopTeam.mockImplementation(async (team: string) => {
      alive.delete(team);
      if (team === f.aliasA) lingering = 2;
    });
    getRuntimeState.mockImplementation(async (team: string) => {
      const stale = team === f.aliasA && lingering > 0;
      if (stale) lingering -= 1;
      return { teamName: team, isAlive: alive.has(team), runId: stale ? 'run-x' : null, progress: null };
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(200);
      expect(lingering).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('stop is a 409 when recorded runtime hosts of a stopped copy survive', async () => {
    const f = await fixture();
    const { app } = await createApp(f, [f.aliasA]);
    liveRuntimeHosts.mockImplementation(async () => 1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('still running after the stop');
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('a second stop of the same team joins the one in progress instead of starting another', async () => {
    const f = await fixture();
    const { app, stopTeam, alive } = await createApp(f, [f.aliasA, f.aliasB]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stopTeam.mockImplementation(async (team: string) => {
      await gate;
      alive.delete(team);
    });
    try {
      const first = app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      await vi.waitFor(() => expect(stopTeam).toHaveBeenCalled());
      const second = app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      release();
      const [a, b] = await Promise.all([first, second]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect(b.json()).toEqual(a.json());
      // One stop per copy, not one per request.
      expect(stopTeam).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await app.close();
    }
  });

  it('stops the own process of a logical team that somehow has one, as the in-app Stop does', async () => {
    const f = await fixture();
    const { app, stopTeam, alive } = await createApp(f, ['builders', f.aliasA]);
    try {
      const runtime = await app.inject({ method: 'GET', url: '/api/teams/builders/runtime' });
      expect(runtime.json()).toMatchObject({ teamName: 'builders', isAlive: true });
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(200);
      expect(stopTeam.mock.calls.map(([team]) => team).sort()).toEqual(
        ['builders', f.aliasA, f.aliasB].sort()
      );
      expect(alive.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('stop answers 409 when a project copy appeared while the stop was running', async () => {
    const f = await fixture();
    const { app, stopTeam, alive } = await createApp(f, [f.aliasA]);
    let appeared = '';
    stopTeam.mockImplementation(async (team: string) => {
      alive.delete(team);
      if (!appeared) {
        const added = await f.addCopy('builders', 'ready');
        appeared = added.alias;
        alive.add(added.alias);
      }
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('started while the stop was running');
      expect(response.json().error).toContain(appeared);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('stop is a 409 when a copy was reserved while stopping, even though no run is registered yet', async () => {
    const f = await fixture();
    const { app, stopTeam, alive } = await createApp(f, [f.aliasA]);
    let reserved = '';
    stopTeam.mockImplementation(async (team: string) => {
      alive.delete(team);
      if (!reserved) reserved = (await f.addCopy('builders', 'reserved')).alias;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('started while the stop was running');
      expect(response.json().error).toContain(reserved);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('stops a pending (reserved) copy only after its owner is proven', async () => {
    const f = await fixture();
    const pending = await f.addCopy('builders', 'reserved');
    const { app, stopTeam, alive } = await createApp(f, [pending.alias]);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(200);
      expect(stopTeam).toHaveBeenCalledWith(pending.alias);
      expect(alive.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('refuses to stop anything when a pending copy has no owner marker', async () => {
    const f = await fixture();
    // Reserved in the index, but its directory was never claimed by this profile.
    const reserved = await f.registry.reserve('builders', os.tmpdir());
    const { app, stopTeam } = await createApp(f, [f.aliasA, reserved.executionTeamName]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/stop' });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('owner cannot be verified');
      expect(stopTeam).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('force-stop answers with what the cleanup did for every copy', async () => {
    const f = await fixture();
    const { app, stopTeam, alive } = await createApp(f, [f.aliasA, f.aliasB]);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/force-stop' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ teamName: 'builders', complete: true });
      expect(body.contexts.map((c: { executionTeamName: string }) => c.executionTeamName).sort()).toEqual(
        [f.aliasA, f.aliasB].sort()
      );
      expect(stopTeam).toHaveBeenCalledWith(f.aliasA);
      expect(alive.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('force-stop reports complete: false, not a success, when a copy keeps running', async () => {
    const f = await fixture();
    const { app, stopTeam } = await createApp(f, [f.aliasA, f.aliasB]);
    stopTeam.mockImplementation(async (team: string) => {
      if (team === f.aliasB) throw new Error('stop command exited with 1');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/force-stop' });
      expect(response.statusCode).toBe(200);
      expect(response.json().complete).toBe(false);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('force-stop reports complete: false when a confirmed stop left its cleanup incomplete', async () => {
    const f = await fixture();
    const { app } = await createApp(f, [f.aliasA]);
    // The processes are gone, but the lead process tree reap says a tree survived.
    reapLeadTrees.mockResolvedValue({ killedPids: [], incomplete: true, diagnostics: ['tree survives'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/builders/force-stop' });
      expect(response.statusCode).toBe(200);
      expect(response.json().complete).toBe(false);
      expect(
        response.json().contexts.some((c: { result?: { cleanupOutcome: string } }) => c.result?.cleanupOutcome === 'incomplete')
      ).toBe(true);
    } finally {
      warn.mockRestore();
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

  it('runtime/alive proves every copy with one scan of the teams directory', async () => {
    const f = await fixture();
    const batch = vi.spyOn(f.registry, 'resolveOwnedExecutionAliases');
    const single = vi.spyOn(f.registry, 'resolveOwnedExecutionAlias');
    const { app } = await createApp(f, [f.aliasA, f.aliasB]);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/teams/runtime/alive' });
      expect(response.statusCode).toBe(200);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(single).not.toHaveBeenCalled();
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

  it('refuses with 409 when the metadata is unreadable and the team owns project contexts', async () => {
    const f = await fixture();
    await f.claimTeam('broken-team');
    await f.addCopy('broken-team', 'ready');
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
        expect(response.json().code).toBe('TEAM_TARGET_UNRESOLVED');
      }
      expect(stopTeam).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('still stops a team with unreadable metadata and no project contexts by its exact name', async () => {
    const f = await fixture();
    f.meta['plain-broken'] = 'unreadable';
    const { app, stopTeam } = await createApp(f, ['plain-broken']);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/plain-broken/stop' });
      expect(response.statusCode).toBe(200);
      expect(stopTeam).toHaveBeenCalledWith('plain-broken');
      expect(response.json()).toMatchObject({ teamName: 'plain-broken', projectContextUnresolved: true });
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

describe('HTTP routes for a shared team that retained project contexts', () => {
  async function retained(): Promise<{ f: Fixture; alias: string; project: string }> {
    const f = await fixture();
    await f.claimTeam('old-shared');
    f.meta['old-shared'] = { projectContextMode: 'shared' } as TeamMetaFile;
    const copy = await f.addCopy('old-shared', 'ready');
    f.meta[copy.alias] = { projectContextMode: 'shared' } as TeamMetaFile;
    return { f, alias: copy.alias, project: copy.project };
  }

  it('stop brings down both its own process and the retained copy', async () => {
    const { f, alias } = await retained();
    const { app, stopTeam, alive } = await createApp(f, ['old-shared', alias]);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/old-shared/stop' });
      expect(response.statusCode).toBe(200);
      expect(stopTeam.mock.calls.map(([team]) => team).sort()).toEqual(['old-shared', alias].sort());
      expect(alive.size).toBe(0);
      expect(response.json()).toMatchObject({ teamName: 'old-shared', isAlive: false });
    } finally {
      await app.close();
    }
  });

  it('force-stop covers its own process and the retained copy', async () => {
    const { f, alias } = await retained();
    const { app, stopTeam } = await createApp(f, ['old-shared', alias]);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/old-shared/force-stop' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ teamName: 'old-shared', complete: true });
      expect(
        body.contexts.map((c: { executionTeamName: string; projectPath: string | null }) => [
          c.executionTeamName,
          c.projectPath === null,
        ]).sort()
      ).toEqual([[alias, false], ['old-shared', true]].sort());
      expect(stopTeam.mock.calls.map(([team]) => team).sort()).toEqual(['old-shared', alias].sort());
    } finally {
      await app.close();
    }
  });

  it('stop still stops its own process when no retained copy is running', async () => {
    const { f } = await retained();
    const { app, stopTeam } = await createApp(f, ['old-shared']);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/teams/old-shared/stop' });
      expect(response.statusCode).toBe(200);
      expect(stopTeam).toHaveBeenCalledWith('old-shared');
    } finally {
      await app.close();
    }
  });

  it('runtime is alive from its own process even when every retained copy is down', async () => {
    const { f } = await retained();
    const { app } = await createApp(f, ['old-shared']);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/teams/old-shared/runtime' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ teamName: 'old-shared', isAlive: true, runId: 'run-old-shared' });
    } finally {
      await app.close();
    }
  });

  it('runtime/alive lists it once, absorbing the live retained copy', async () => {
    const { f, alias } = await retained();
    const { app } = await createApp(f, ['old-shared', alias]);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/teams/runtime/alive' });
      const entries = response.json() as { teamName: string; contexts?: unknown[] }[];
      expect(entries.filter((entry) => entry.teamName === 'old-shared')).toHaveLength(1);
      expect(entries.find((entry) => entry.teamName === 'old-shared')?.contexts).toHaveLength(1);
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

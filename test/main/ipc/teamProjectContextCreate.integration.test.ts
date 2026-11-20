import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTeamWithProjectContext } from '../../../src/main/ipc/teams/teamProjectContextCreate';
import { createProjectScheduleTargets } from '../../../src/main/ipc/teams/projectScheduleTargets';
import { prepareTeamContextLaunch, withPreparedContextLaunch } from '../../../src/main/ipc/teams/teamProjectContextLaunch';
import {
  getTasksBasePath,
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../src/main/utils/pathDecoder';
import { claimTeamForThisProfile } from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { TeamProjectContextRegistry } from '../../../src/features/team-project-context/main';

import type {
  TeamLaunchRequest,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '../../../src/shared/types/team';

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-team-create-'));
  roots.push(root);
  setClaudeBasePathOverride(path.join(root, 'claude'));
  setAppDataBasePath(path.join(root, 'app'));
  const projectPath = path.join(root, 'project-a');
  await Promise.all([
    fs.mkdir(projectPath, { recursive: true }),
    fs.mkdir(getTeamsBasePath(), { recursive: true }),
    fs.mkdir(getTasksBasePath(), { recursive: true }),
  ]);
  const started: TeamCreateRequest[] = [];
  const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();
  const data = {
    async createTeamConfig(
      request: TeamCreateConfigRequest, options?: { claimOwnerOnCreate?: boolean }
    ): Promise<void> {
      const name = request.teamName;
      const teamDir = path.join(getTeamsBasePath(), name);
      const taskDir = path.join(getTasksBasePath(), name);
      await fs.mkdir(teamDir);
      await fs.mkdir(taskDir);
      await fs.writeFile(path.join(teamDir, 'team.meta.json'), JSON.stringify({
        version: 1, cwd: request.cwd ?? '', createdAt: 1,
        projectContextMode: request.projectContextMode,
      }));
      if (request.projectContextMode === 'per_project' || options?.claimOwnerOnCreate) {
        await claimTeamForThisProfile({
          teamsBasePath: getTeamsBasePath(), teamName: name, reason: 'create',
        });
      }
    },
    async getSavedRequest(teamName: string): Promise<TeamCreateRequest | null> {
      try {
        const raw = JSON.parse(await fs.readFile(
          path.join(getTeamsBasePath(), teamName, 'team.meta.json'), 'utf8'
        )) as { cwd: string; projectContextMode?: TeamCreateRequest['projectContextMode'] };
        return { teamName, cwd: raw.cwd, members: [], projectContextMode: raw.projectContextMode };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async replaceMembers(): Promise<void> {
      // Native provider fixture has no roster; runtime meta mutation is
      // covered by TeamProjectContextDraftMaterializer focused tests.
    },
    async runConfigurationOperation<T>(_teamName: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async updateConfig(): Promise<null> {
      // Display-metadata projection is covered by the projection and materializer tests.
      return null;
    },
  };
  const ports: Parameters<typeof createTeamWithProjectContext>[2] = {
    data,
    start: {
      async createTeam(request, progress) {
        started.push(request);
        const teamDir = path.join(getTeamsBasePath(), request.teamName);
        await fs.mkdir(teamDir, { recursive: true });
        await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify({
          name: request.teamName, projectPath: request.cwd,
        }));
        progress({
          teamName: request.teamName, runId: 'run-a', state: 'ready',
          message: 'Native creation complete',
          startedAt: '2026-11-17T00:00:00.000Z',
          updatedAt: '2026-11-17T00:00:00.000Z',
        });
        return { runId: 'run-a' };
      },
    },
    runtime: {
      getRuntimeState: async (name): Promise<TeamRuntimeState> =>
        ({ teamName: name, runId: null, isAlive: false, progress: null }),
    },
    run: {
      hasProvisioningRun: () => false,
    },
    watchNativeTeam: vi.fn(),
  };
  return { ports, projectPath, started, onProgress };
}

afterEach(async () => {
  vi.restoreAllMocks();
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('project-scoped desktop team creation boundary (sandbox disk + fake native)', () => {
  it('launches a real separate team directory, not the logical team task namespace', async () => {
    const f = await fixture();
    const request: TeamCreateRequest = {
      teamName: 'builders', cwd: f.projectPath, members: [], projectContextMode: 'per_project',
    };
    await expect(createTeamWithProjectContext(request, f.onProgress, f.ports))
      .resolves.toEqual({ runId: 'run-a' });
    expect(f.started).toHaveLength(1);
    expect(f.started[0]?.teamName).not.toBe('builders');
    expect(f.started[0]?.projectContextMode).toBe('shared');
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    await vi.waitFor(async () => {
      const match = await registry.find('builders', f.projectPath);
      expect(match?.state).toBe('ready');
      expect(match?.executionTeamName).toBe(f.started[0]?.teamName);
    });
    await expect(fs.readFile(path.join(getTeamsBasePath(), 'builders', 'config.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.onProgress).toHaveBeenCalledWith(expect.objectContaining({
      teamName: 'builders', state: 'ready',
    }));
  });

  it('pins physical launch cwd to the resolved canonical directory rather than a symlink', async () => {
    if (process.platform === 'win32') return;
    const f = await fixture();
    const alias = path.join(path.dirname(f.projectPath), 'project-alias');
    await fs.symlink(f.projectPath, alias, 'dir');
    const request: TeamCreateRequest = {
      teamName: 'builders', cwd: alias, members: [], projectContextMode: 'per_project',
    };
    await createTeamWithProjectContext(request, f.onProgress, f.ports);
    // Readiness is confirmed in the background: wait for it, or cleanup races the index write.
    await vi.waitFor(async () => {
      const row = await TeamProjectContextRegistry.fromCurrentApp().find('builders', f.projectPath);
      expect(row?.state).toBe('ready');
    });
    expect(f.started[0]?.cwd).toBe(await fs.realpath(f.projectPath));
    const meta = JSON.parse(await fs.readFile(
      path.join(getTeamsBasePath(), f.started[0]!.teamName, 'team.meta.json'),
      'utf8'
    )) as { cwd: string };
    expect(meta.cwd).toBe(await fs.realpath(f.projectPath));
  });

  it('rejects launching a verified native project alias outside its logical team', async () => {
    const f = await fixture();
    await createTeamWithProjectContext({
      teamName: 'builders', cwd: f.projectPath, members: [], projectContextMode: 'per_project',
    }, f.onProgress, f.ports);
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const alias = await vi.waitFor(async () => {
      const row = await registry.find('builders', f.projectPath);
      expect(row).toBeTruthy();
      return row!.executionTeamName;
    });
    await expect(prepareTeamContextLaunch({
      teamName: alias, cwd: f.projectPath,
    }, f.ports)).rejects.toThrow('cannot launch directly');
    expect(f.started).toHaveLength(1);
  });

  it('preserves the native team name and paths in shared mode', async () => {
    const f = await fixture();
    await createTeamWithProjectContext({
      teamName: 'legacy', cwd: f.projectPath, members: [], projectContextMode: 'shared',
    }, f.onProgress, f.ports);
    expect(f.started).toEqual([expect.objectContaining({ teamName: 'legacy' })]);
    await expect(fs.readFile(path.join(getTeamsBasePath(), 'legacy', 'project-contexts.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('prepares B independently from a previously ready A, then restores A', async () => {
    const f = await fixture();
    await createTeamWithProjectContext({
      teamName: 'builders', cwd: f.projectPath, members: [], projectContextMode: 'per_project',
    }, f.onProgress, f.ports);
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const a = await vi.waitFor(async () => {
      const row = await registry.find('builders', f.projectPath);
      expect(row?.state).toBe('ready');
      return row!;
    });
    const projectB = path.join(path.dirname(f.projectPath), 'project-b');
    await fs.mkdir(projectB);
    const prepared = await prepareTeamContextLaunch({
      teamName: 'builders', cwd: projectB,
    }, f.ports);
    expect(prepared.request.teamName).not.toBe('builders');
    expect(prepared.request.teamName).not.toBe(a.executionTeamName);
    await fs.writeFile(path.join(
      getTeamsBasePath(), prepared.request.teamName, 'config.json'
    ), JSON.stringify({ name: prepared.request.teamName }));
    const send = vi.fn<(p: TeamProvisioningProgress) => void>();
    prepared.mapProgress?.({
      runId: 'run-b',
      teamName: prepared.request.teamName,
      state: 'ready',
      message: 'Native launch ready',
      startedAt: '', updatedAt: '',
    }, send);
    await vi.waitFor(async () => {
      const b = await registry.find('builders', projectB);
      expect(b?.state).toBe('ready');
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        teamName: 'builders', state: 'ready',
      }));
    });
    expect((await registry.find('builders', f.projectPath))?.id).toBe(a.id);
  });

  it('does not materialize any project aliases when the logical team is trashed', async () => {
    const f = await fixture();
    await createTeamWithProjectContext({
      teamName: 'builders', cwd: f.projectPath, members: [], projectContextMode: 'per_project',
    }, f.onProgress, f.ports);
    const metaPath = path.join(getTeamsBasePath(), 'builders', 'team.meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(metaPath, JSON.stringify({
      ...meta, deletedAt: '2026-11-17T00:00:00Z',
    }));
    const projectB = path.join(path.dirname(f.projectPath), 'project-b');
    await fs.mkdir(projectB);
    await expect(prepareTeamContextLaunch({
      teamName: 'builders', cwd: projectB,
    }, f.ports)).rejects.toThrow('TEAM_TRASHED');
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    expect(await registry.inspect('builders', projectB)).toBeNull();
  });

  it('rejects invalid overrides before materializing or reserving any project', async () => {
    const f = await fixture();
    await f.ports.data.createTeamConfig({
      teamName: 'builders', cwd: f.projectPath,
      members: [], projectContextMode: 'per_project',
    });
    const invoke = vi.fn(async () => ({ success: true }));
    await expect(withPreparedContextLaunch({
      teamName: 'builders',
      cwd: f.projectPath,
      effort: 'bogus' as never,
    }, f.ports, invoke)).rejects.toThrow('effort');
    await expect(withPreparedContextLaunch({
      teamName: 'builders',
      cwd: f.projectPath,
      fastMode: 'not-allowed' as never,
    }, f.ports, invoke)).rejects.toThrow('fastMode');
    expect(invoke).not.toHaveBeenCalled();
    await expect(fs.readFile(
      path.join(getTeamsBasePath(), 'builders', 'project-contexts.json'), 'utf8'
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows Codex xhigh when provider override is omitted and saved provider is Codex', async () => {
    const f = await fixture();
    await f.ports.data.createTeamConfig({
      teamName: 'builders', cwd: f.projectPath,
      members: [], projectContextMode: 'per_project',
    });
    const original = f.ports.data.getSavedRequest;
    f.ports.data.getSavedRequest = async (name) => {
      const saved = await original(name);
      return saved ? { ...saved, providerId: 'codex' } : null;
    };
    const invoke = vi.fn(async (_request: TeamLaunchRequest) => ({ success: true as const }));
    await expect(withPreparedContextLaunch({
      teamName: 'builders', cwd: f.projectPath, effort: 'xhigh',
    }, f.ports, invoke)).resolves.toMatchObject({ success: true });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0].teamName).not.toBe('builders');
  });

  describe('launch settings of a per-project team', () => {
    async function perProjectFixture() {
      const f = await fixture();
      await f.ports.data.createTeamConfig({
        teamName: 'builders', cwd: f.projectPath, members: [], projectContextMode: 'per_project',
      });
      const metaPath = path.join(getTeamsBasePath(), 'builders', 'team.meta.json');
      const readMeta = async () => JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
      const launch = (
        patch: Partial<TeamLaunchRequest>,
        result: { success: boolean; data?: object; error?: string } = { success: true, data: { runId: 'r1' } }
      ) =>
        withPreparedContextLaunch(
          { teamName: 'builders', cwd: f.projectPath, ...patch }, f.ports,
          vi.fn(async () => result) as never
        );
      return { f, readMeta, launch };
    }

    it('saves what the launch chose into the team, but never trust or place of one project', async () => {
      const { readMeta, launch } = await perProjectFixture();
      await launch({
        providerId: 'codex', model: 'gpt-x', effort: 'high', limitContext: true,
        skipPermissions: true, worktree: 'wt',
      });
      const meta = await readMeta();
      expect(meta).toMatchObject({
        providerId: 'codex', model: 'gpt-x', effort: 'high', limitContext: true,
        projectContextMode: 'per_project',
      });
      expect(meta).not.toHaveProperty('skipPermissions');
      expect(meta).not.toHaveProperty('worktree');
    });

    it('brings the launched project copy to the same settings at once', async () => {
      const { f } = await perProjectFixture();
      const projectB = path.join(path.dirname(f.projectPath), 'project-b');
      await fs.mkdir(projectB);
      const invoke = vi.fn(async () => ({ success: true as const, data: { runId: 'r1' } }));
      await withPreparedContextLaunch(
        { teamName: 'builders', cwd: projectB, providerId: 'codex', model: 'gpt-y' },
        f.ports,
        invoke as never
      );
      const copy = (invoke.mock.calls[0] as unknown as [TeamLaunchRequest])[0].teamName;
      const copyMeta = JSON.parse(
        await fs.readFile(path.join(getTeamsBasePath(), copy, 'team.meta.json'), 'utf8')
      ) as Record<string, unknown>;
      expect(copyMeta).toMatchObject({ providerId: 'codex', model: 'gpt-y' });
    });

    it('saves nothing when the launch is rejected or the team was already running', async () => {
      const { readMeta, launch } = await perProjectFixture();
      await launch({ providerId: 'codex', model: 'rejected' }, { success: false, error: 'no auth' });
      await launch(
        { providerId: 'codex', model: 'ignored' },
        { success: true, data: { runId: 'r2', launchStatus: 'already_running', alreadyRunning: true } }
      );
      expect(await readMeta()).not.toHaveProperty('model');
    });

    it('does not fail an accepted launch when the settings cannot be saved', async () => {
      const { launch } = await perProjectFixture();
      const { TeamMetaStore } = await import('../../../src/main/services/team/TeamMetaStore');
      vi.spyOn(TeamMetaStore.prototype, 'updateMeta').mockRejectedValue(new Error('disk full'));
      await expect(launch({ providerId: 'codex', model: 'gpt-x' })).resolves.toMatchObject({
        success: true,
      });
    });

    it('runs a schedule in A with the settings the team got from a launch in B', async () => {
      const f = await fixture();
      await createTeamWithProjectContext({
        teamName: 'builders', cwd: f.projectPath, members: [], projectContextMode: 'per_project',
      }, f.onProgress, f.ports);
      const registry = TeamProjectContextRegistry.fromCurrentApp();
      const a = await vi.waitFor(async () => {
        const row = await registry.find('builders', f.projectPath);
        expect(row?.state).toBe('ready');
        return row!;
      });
      // The fixture reads only what it needs elsewhere; scheduling reads the saved launch settings.
      const readMeta = async (name: string) => JSON.parse(
        await fs.readFile(path.join(getTeamsBasePath(), name, 'team.meta.json'), 'utf8')
      ) as Record<string, unknown>;
      f.ports.data.getSavedRequest = async (name) => {
        const meta = await readMeta(name).catch(() => null);
        return meta ? ({ teamName: name, members: [], ...meta } as unknown as TeamCreateRequest) : null;
      };
      const projectB = path.join(path.dirname(f.projectPath), 'project-b');
      await fs.mkdir(projectB);
      // A launch in B changes the team's settings.
      await withPreparedContextLaunch(
        { teamName: 'builders', cwd: projectB, providerId: 'codex', model: 'gpt-y', effort: 'high' },
        f.ports,
        vi.fn(async () => ({ success: true as const, data: { runId: 'rb' } })) as never
      );
      // The copy of A still has the settings of its own last launch.
      expect(await readMeta(a.executionTeamName)).not.toMatchObject({ model: 'gpt-y' });
      const launched: TeamLaunchRequest[] = [];
      const targets = createProjectScheduleTargets(
        { runtime: f.ports.runtime, provisioningRun: f.ports.run },
        f.ports.data,
        {
          launchTeam: async (request) => {
            launched.push(request);
            return { runId: 'rs' };
          },
        }
      );
      const response = await targets.launch(
        { teamName: 'builders', launchConfig: { cwd: f.projectPath, prompt: 'go' } } as never,
        {
          teamName: a.executionTeamName, cwd: f.projectPath, providerId: 'anthropic',
          model: 'opus-x', effort: 'low', extraCliArgs: '--project-a',
        }
      );
      expect(response).toEqual({ runId: 'rs' });
      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({
        teamName: a.executionTeamName, providerId: 'codex', model: 'gpt-y', effort: 'high',
        extraCliArgs: '--project-a',
      });
      // And the copy that runs it has the team's settings again.
      expect(await readMeta(a.executionTeamName)).toMatchObject({ providerId: 'codex', model: 'gpt-y' });
    });
  });

  it('refuses project B while A is running and does not leave a dead reservation', async () => {
    const f = await fixture();
    await createTeamWithProjectContext({
      teamName: 'builders', cwd: f.projectPath, members: [], projectContextMode: 'per_project',
    }, f.onProgress, f.ports);
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const a = await vi.waitFor(async () => {
      const row = await registry.find('builders', f.projectPath);
      expect(row).not.toBeNull();
      return row!;
    });
    const original = f.ports.runtime.getRuntimeState;
    f.ports.runtime.getRuntimeState = async (name) =>
      name === a.executionTeamName
        ? { teamName: name, runId: 'active-run', isAlive: true, progress: null }
        : original(name);
    const projectB = path.join(path.dirname(f.projectPath), 'project-b');
    await fs.mkdir(projectB);
    await expect(prepareTeamContextLaunch({
      teamName: 'builders', cwd: projectB,
    }, f.ports)).rejects.toThrow('running');
    expect((await registry.list('builders')).map((row) => row.projectPath))
      .toEqual([a.projectPath]);
    f.ports.runtime.getRuntimeState = original;
    const prepared = await prepareTeamContextLaunch({
      teamName: 'builders', cwd: projectB,
    }, f.ports);
    expect(prepared.request.teamName).not.toBe(a.executionTeamName);
  });

  // A schedule may only reuse the copy it resolved. Prevention, not detection: the launch
  // preparation aborts before any copy is materialized and gives the reservation back.
  describe('a launch that must reuse one existing project copy', () => {
    it('uses that copy when it is the project copy', async () => {
      const f = await fixture();
      await createTeamWithProjectContext({
        teamName: 'builders', cwd: f.projectPath, members: [], projectContextMode: 'per_project',
      }, f.onProgress, f.ports);
      const registry = TeamProjectContextRegistry.fromCurrentApp();
      const a = await vi.waitFor(async () => {
        const row = await registry.find('builders', f.projectPath);
        expect(row?.state).toBe('ready');
        return row!;
      });
      const prepared = await prepareTeamContextLaunch(
        { teamName: 'builders', cwd: f.projectPath },
        f.ports,
        { expectedExecutionTeamName: a.executionTeamName }
      );
      expect(prepared.request.teamName).toBe(a.executionTeamName);
    });

    it('creates and keeps nothing when the project would need another copy', async () => {
      const f = await fixture();
      await createTeamWithProjectContext({
        teamName: 'builders', cwd: f.projectPath, members: [], projectContextMode: 'per_project',
      }, f.onProgress, f.ports);
      const registry = TeamProjectContextRegistry.fromCurrentApp();
      const a = await vi.waitFor(async () => {
        const row = await registry.find('builders', f.projectPath);
        expect(row?.state).toBe('ready');
        return row!;
      });
      const projectB = path.join(path.dirname(f.projectPath), 'project-b');
      await fs.mkdir(projectB);
      const teamsBefore = (await fs.readdir(getTeamsBasePath())).sort();

      await expect(
        prepareTeamContextLaunch({ teamName: 'builders', cwd: projectB }, f.ports, {
          expectedExecutionTeamName: a.executionTeamName,
        })
      ).rejects.toThrow(/changed while the schedule was starting/);

      // No copy directory was written, and the reservation of project B was given back.
      expect((await fs.readdir(getTeamsBasePath())).sort()).toEqual(teamsBefore);
      expect(await registry.inspect('builders', projectB)).toBeNull();
      expect((await registry.find('builders', f.projectPath))?.id).toBe(a.id);
    });
  });
});

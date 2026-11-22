import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createController } from 'agent-teams-controller';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamProjectContextRegistry, TeamProjectLiveEditJournal } from '../../../src/features/team-project-context/main';
import { createProjectScheduleTargets } from '../../../src/main/ipc/teams/projectScheduleTargets';
import { createTeamWithProjectContext } from '../../../src/main/ipc/teams/teamProjectContextCreate';
import { prepareTeamContextLaunch, withPreparedContextLaunch } from '../../../src/main/ipc/teams/teamProjectContextLaunch';
import {
  createLaunchReviewFlowProjection,
  createTeamReviewFlowService,
  ReviewFlowNotAppliedLaunchError,
} from '../../../src/main/ipc/teams/teamReviewFlow';
import { claimTeamForThisProfile } from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import {
  getClaudeBasePath,
  getTasksBasePath,
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../src/main/utils/pathDecoder';

import type { ReviewFlowSettings } from '../../../src/features/review-flow';
import type {
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamLaunchRequest,
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
    // The real board write of the controller (under its board lock), as TeamDataService does it.
    async setReviewFlowSettings(teamName: string, settings: ReviewFlowSettings | null): Promise<void> {
      createController({ teamName, claudeDir: getClaudeBasePath() }).taskBoard.setReviewFlowSettings(settings);
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
    // Preserve the PR's progress-observation assertion as well as main's stronger
    // persisted-ready check: both must complete before fixture teardown.
    expect(f.onProgress).toHaveBeenCalledWith(expect.objectContaining({
      teamName: 'builders', state: 'ready',
    }));
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

  it('blocks launch after an interrupted live edit until the previous runtime is stopped', async () => {
    const f = await fixture();
    await createTeamWithProjectContext({
      teamName: 'builders', cwd: f.projectPath, members: [], projectContextMode: 'per_project',
    }, f.onProgress, f.ports);
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const alias = await vi.waitFor(async () => {
      const row = await registry.find('builders', f.projectPath);
      expect(row?.state).toBe('ready');
      return row!.executionTeamName;
    });
    const journal = new TeamProjectLiveEditJournal();
    await journal.begin('builders');
    f.ports.runtime.getRuntimeState = async (name) => ({
      teamName: name, isAlive: name === alias, runId: name === alias ? 'live' : null, progress: null,
    });
    await expect(prepareTeamContextLaunch({ teamName: 'builders', cwd: f.projectPath }, f.ports))
      .rejects.toThrow(/running/);
    expect(await journal.hasPending('builders')).toBe(true);
    f.ports.runtime.getRuntimeState = async (name) => ({ teamName: name, isAlive: false, runId: null, progress: null });
    const prepared = await prepareTeamContextLaunch({ teamName: 'builders', cwd: f.projectPath }, f.ports);
    expect(prepared.request.teamName).toBe(alias);
    expect(await journal.hasPending('builders')).toBe(false);
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

    it('brings the launched project copy to the same settings at once, and keeps its own trust and arguments', async () => {
      const { f } = await perProjectFixture();
      const projectB = path.join(path.dirname(f.projectPath), 'project-b');
      await fs.mkdir(projectB);
      const invoke = vi.fn(async () => ({ success: true as const, data: { runId: 'r1' } }));
      await withPreparedContextLaunch(
        {
          teamName: 'builders', cwd: projectB, providerId: 'codex', model: 'gpt-y',
          skipPermissions: true, extraCliArgs: '--max-turns 5', worktree: 'wt-b',
        },
        f.ports,
        invoke as never
      );
      const copy = (invoke.mock.calls[0] as unknown as [TeamLaunchRequest])[0].teamName;
      const copyMeta = JSON.parse(
        await fs.readFile(path.join(getTeamsBasePath(), copy, 'team.meta.json'), 'utf8')
      ) as Record<string, unknown>;
      expect(copyMeta).toMatchObject({
        providerId: 'codex', model: 'gpt-y',
        skipPermissions: true, extraCliArgs: '--max-turns 5', worktree: 'wt-b',
      });
      // Trust, runtime arguments and worktree of project B stay in its copy: not in the team.
      const team = JSON.parse(await fs.readFile(
        path.join(getTeamsBasePath(), 'builders', 'team.meta.json'), 'utf8'
      )) as Record<string, unknown>;
      expect(team).toMatchObject({ providerId: 'codex', model: 'gpt-y' });
      for (const key of ['skipPermissions', 'extraCliArgs', 'worktree']) expect(team).not.toHaveProperty(key);
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
      const preparedB = await prepareTeamContextLaunch(
        { teamName: 'builders', cwd: projectB, providerId: 'codex', model: 'gpt-y', effort: 'high' },
        f.ports
      );
      await fs.writeFile(
        path.join(getTeamsBasePath(), preparedB.request.teamName, 'config.json'),
        JSON.stringify({ name: preparedB.request.teamName })
      );
      preparedB.mapProgress?.(
        {
          runId: 'rb', teamName: preparedB.request.teamName, state: 'ready',
          message: 'ready', startedAt: '', updatedAt: '',
        },
        () => undefined
      );
      await vi.waitFor(async () => {
        expect((await registry.find('builders', projectB))?.state).toBe('ready');
      });
      await preparedB.recordLaunch?.({ runId: 'rb' });
      expect(await readMeta('builders')).toMatchObject({ providerId: 'codex', model: 'gpt-y' });
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

  describe('review flow of a per-project team (real metadata, registry and boards)', () => {
    const human: ReviewFlowSettings = { reviewFlow: 'human_approval', reviewFlowPrompt: 'Run e2e' };
    const lead: ReviewFlowSettings = { reviewFlow: 'lead_then_human', reviewFlowPrompt: '' };
    const read = async (team: string, file: string): Promise<Record<string, unknown>> =>
      JSON.parse(
        await fs.readFile(path.join(getTeamsBasePath(), team, file), 'utf8').catch(() => '{}')
      ) as Record<string, unknown>;
    const boardFlow = async (team: string) => {
      const { reviewFlow, reviewFlowPrompt } = await read(team, 'kanban-state.json');
      return { reviewFlow, reviewFlowPrompt };
    };

    async function readyInProjectA() {
      const f = await fixture();
      await createTeamWithProjectContext({
        teamName: 'builders', cwd: f.projectPath, members: [], projectContextMode: 'per_project',
      }, f.onProgress, f.ports);
      const registry = TeamProjectContextRegistry.fromCurrentApp();
      const a = await vi.waitFor(async () => {
        const row = await registry.find('builders', f.projectPath);
        expect(row?.state).toBe('ready');
        return row!.executionTeamName;
      });
      const project = async (name: string) => {
        const dir = path.join(path.dirname(f.projectPath), name);
        await fs.mkdir(dir);
        return dir;
      };
      return { f, a, project, service: createTeamReviewFlowService(() => f.ports.data) };
    }

    it('saves one setting for the team and writes the board of every project, running or pending', async () => {
      const { f, a, project, service } = await readyInProjectA();
      // Project B: its first launch is in progress (the copy exists, its context is still reserved).
      const b = (await prepareTeamContextLaunch({ teamName: 'builders', cwd: await project('b') }, f.ports))
        .request.teamName;
      // Project A runs: the review flow, like an ordinary team's, changes on a live board.
      f.ports.runtime.getRuntimeState = async (name) =>
        ({ teamName: name, runId: name === a ? 'live' : null, isAlive: name === a, progress: null });

      await service.saveTeamOverride('builders', human);
      expect((await read('builders', 'team.meta.json')).reviewFlowSettings).toEqual(human);
      for (const copy of [a, b]) {
        expect(await boardFlow(copy)).toEqual({ reviewFlow: 'human_approval', reviewFlowPrompt: 'Run e2e' });
        expect(await read(copy, 'team.meta.json')).not.toHaveProperty('reviewFlowSettings');
      }
      const overview = await service.getOverview();
      // Both copies, the pending one included, are reported as the team's projects.
      expect(overview.projectTeams.builders).toMatchObject({ saved: true, settings: human });
      expect(overview.projectTeams.builders.projects.map((p) => p.executionTeamName).sort()).toEqual(
        [a, b].sort()
      );
      expect(overview.overrides).toMatchObject({ [a]: human, [b]: human });

      await service.saveTeamOverride('builders', null);
      expect((await read('builders', 'team.meta.json')).reviewFlowSettings).toBeNull();
      for (const copy of [a, b]) {
        expect(await boardFlow(copy)).toEqual({ reviewFlow: undefined, reviewFlowPrompt: undefined });
      }
    });

    it('refuses a project copy and unreadable team metadata without writing anything', async () => {
      const { a, service } = await readyInProjectA();
      await expect(service.saveTeamOverride(a, human)).rejects.toThrow(/project copy/);
      const metaPath = path.join(getTeamsBasePath(), 'builders', 'team.meta.json');
      await fs.writeFile(metaPath, '{ not json');
      await expect(service.saveTeamOverride('builders', human)).rejects.toThrow(/cannot be read/);
      expect(await fs.readFile(metaPath, 'utf8')).toBe('{ not json');
      expect(await boardFlow(a)).toEqual({ reviewFlow: undefined, reviewFlowPrompt: undefined });
    });

    it('keeps the boards of older projects until the team saves, then a new copy takes the team setting', async () => {
      const { f, a, project, service } = await readyInProjectA();
      // What project A chose for itself before the team had one setting.
      createController({ teamName: a, claudeDir: getClaudeBasePath() }).taskBoard.setReviewFlowSettings(lead);
      await prepareTeamContextLaunch({ teamName: 'builders', cwd: f.projectPath }, f.ports);
      expect(await boardFlow(a)).toEqual({ reviewFlow: 'lead_then_human', reviewFlowPrompt: undefined });
      expect(await read('builders', 'team.meta.json')).not.toHaveProperty('reviewFlowSettings');
      expect((await service.getOverview()).projectTeams.builders).toMatchObject({ saved: false, settings: null });

      await service.saveTeamOverride('builders', human);
      const c = (await prepareTeamContextLaunch({ teamName: 'builders', cwd: await project('c') }, f.ports))
        .request.teamName;
      expect(c).not.toBe(a);
      expect(await boardFlow(c)).toEqual({ reviewFlow: 'human_approval', reviewFlowPrompt: 'Run e2e' });
      expect(await boardFlow(a)).toEqual({ reviewFlow: 'human_approval', reviewFlowPrompt: 'Run e2e' });
    });

    it('does not write a project whose launch never created its copy (a bare reservation)', async () => {
      const { service } = await readyInProjectA();
      const indexPath = path.join(getTeamsBasePath(), 'builders', 'project-contexts.json');
      const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as { contexts: unknown[] };
      const bare = 'ptc-' + 'b'.repeat(24);
      await fs.writeFile(indexPath, JSON.stringify({
        ...index,
        contexts: [...index.contexts, {
          id: '22222222-2222-4222-8222-222222222222', projectKey: '/nowhere', projectPath: '/nowhere',
          executionTeamName: bare, state: 'reserved',
        }],
      }));
      await service.saveTeamOverride('builders', human);
      await expect(fs.access(path.join(getTeamsBasePath(), bare))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses a save when a reserved copy exists but its ownership cannot be proved', async () => {
      const { f, project, service } = await readyInProjectA();
      const b = (await prepareTeamContextLaunch({ teamName: 'builders', cwd: await project('b') }, f.ports))
        .request.teamName;
      // A present directory with an unreadable or absent owner is not a bare reservation.
      const ownerCandidates = await fs.readdir(path.join(getTeamsBasePath(), b));
      const marker = ownerCandidates.find((name) => name.includes('owner'));
      expect(marker).toBeDefined();
      await fs.writeFile(path.join(getTeamsBasePath(), b, marker!), '{broken');
      await expect(service.saveTeamOverride('builders', human)).rejects.toThrow();
      expect((await read('builders', 'team.meta.json')).reviewFlowSettings).toBeUndefined();
    });

    it('refuses a launch projection when the saved team metadata is unreadable', async () => {
      const { f, a } = await readyInProjectA();
      await fs.writeFile(path.join(getTeamsBasePath(), 'builders', 'team.meta.json'), '{broken');
      await expect(createLaunchReviewFlowProjection(f.ports.data)('builders', a))
        .rejects.toBeInstanceOf(ReviewFlowNotAppliedLaunchError);
    });

    it('keeps a copy that an ordinary team kept from an earlier period a board of its own', async () => {
      const { a, service } = await readyInProjectA();
      const metaPath = path.join(getTeamsBasePath(), 'builders', 'team.meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(metaPath, JSON.stringify({ ...meta, projectContextMode: 'shared' }));
      await service.saveTeamOverride(a, lead);
      expect(await boardFlow(a)).toEqual({ reviewFlow: 'lead_then_human', reviewFlowPrompt: undefined });
    });

    it('refuses a launch whose copy cannot take the team setting, a ready copy and a new one alike', async () => {
      const { f, a, project, service } = await readyInProjectA();
      await service.saveTeamOverride('builders', human);
      // Project A has something else on its board (an earlier save did not reach it).
      createController({ teamName: a, claudeDir: getClaudeBasePath() }).taskBoard.setReviewFlowSettings(lead);
      f.ports.data.setReviewFlowSettings = async () => {
        throw new Error('board lock timed out');
      };
      for (const cwd of [f.projectPath, await project('c')]) {
        const invoke = vi.fn(async () => ({ success: true as const, data: { runId: 'r1' } }));
        await expect(
          withPreparedContextLaunch({ teamName: 'builders', cwd }, f.ports, invoke as never)
        ).rejects.toBeInstanceOf(ReviewFlowNotAppliedLaunchError);
        // Nothing was started: the copy would otherwise run on another review flow than its team's.
        expect(invoke).not.toHaveBeenCalled();
      }
      expect(await boardFlow(a)).toEqual({ reviewFlow: 'lead_then_human', reviewFlowPrompt: undefined });
    });

    it('refuses launches while the saved setting cannot be read, keeps it, and a save repairs it', async () => {
      const { f, service } = await readyInProjectA();
      const metaPath = path.join(getTeamsBasePath(), 'builders', 'team.meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
      const broken = { reviewFlow: 'everyone' };
      await fs.writeFile(metaPath, JSON.stringify({ ...meta, reviewFlowSettings: broken }));
      const invoke = vi.fn(async () => ({ success: true as const, data: { runId: 'r1' } }));
      await expect(
        withPreparedContextLaunch({ teamName: 'builders', cwd: f.projectPath }, f.ports, invoke as never)
      ).rejects.toThrow(/cannot be read/);
      expect(invoke).not.toHaveBeenCalled();
      expect((await read('builders', 'team.meta.json')).reviewFlowSettings).toEqual(broken);
      expect((await service.getOverview()).projectTeams.builders).toMatchObject({ unreadable: true });

      await service.saveTeamOverride('builders', human);
      await withPreparedContextLaunch({ teamName: 'builders', cwd: f.projectPath }, f.ports, invoke as never);
      expect(invoke).toHaveBeenCalledOnce();
    });
  });
});

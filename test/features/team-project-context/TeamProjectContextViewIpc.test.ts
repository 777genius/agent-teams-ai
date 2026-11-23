import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEAM_PROJECT_CONTEXT_VIEW_CHANNEL } from '../../../src/features/team-project-context/contracts';
import { TeamProjectContextRegistry } from '../../../src/features/team-project-context/main';
import { trackProjectCopyLaunch } from '../../../src/features/team-project-context/main/projectCopyLaunches';
import { registerTeamProjectContextViewHandler } from '../../../src/features/team-project-context/main/TeamProjectContextViewIpc';
import { claimTeamForThisProfile } from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { TeamMetaStore } from '../../../src/main/services/team/TeamMetaStore';
import {
  getTasksBasePath,
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../src/main/utils/pathDecoder';

const roots: string[] = [];

async function fixture(mode?: 'shared' | 'per_project') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'team-context-view-')));
  roots.push(root);
  setClaudeBasePathOverride(path.join(root, 'claude'));
  setAppDataBasePath(path.join(root, 'app'));
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const teamDir = path.join(getTeamsBasePath(), 'builders');
  await Promise.all([
    fs.mkdir(teamDir, { recursive: true }),
    fs.mkdir(getTasksBasePath(), { recursive: true }),
    fs.mkdir(projectA),
    fs.mkdir(projectB),
  ]);
  await claimTeamForThisProfile({
    teamName: 'builders',
    teamsBasePath: getTeamsBasePath(),
    reason: 'create',
  });
  const store = new TeamMetaStore();
  await store.writeMeta('builders', {
    cwd: projectA,
    createdAt: 1,
    ...(mode ? { projectContextMode: mode } : {}),
  });
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipc = {
    handle: vi.fn((name: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(name, handler);
    }),
    removeHandler: vi.fn((name: string) => handlers.delete(name)),
  };
  const runtime = {
    getRuntimeState: vi.fn(async (teamName: string) => ({
      teamName,
      isAlive: false,
      runId: null as string | null,
      progress: null as import('../../../src/shared/types').TeamRuntimeState['progress'],
    })),
    hasProvisioningRun: vi.fn(() => false),
  };
  registerTeamProjectContextViewHandler(ipc as never, runtime);
  const resolve = async (projectPath: string | null, teamName = 'builders') => {
    const handler = handlers.get(TEAM_PROJECT_CONTEXT_VIEW_CHANNEL);
    if (!handler) throw new Error('Handler not registered');
    return handler(null, teamName, projectPath);
  };
  return { projectA, projectB, resolve, runtime };
}

afterEach(async () => {
  vi.restoreAllMocks();
  setClaudeBasePathOverride(null);
  setAppDataBasePath(null);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('project context view IPC (read-only)', () => {
  it('keeps absent-mode legacy teams on the original physical name', async () => {
    const f = await fixture();
    expect(await f.resolve(null)).toEqual({
      success: true,
      data: { mode: 'shared', state: 'ready', executionTeamName: 'builders' },
    });
  });

  it('distinguishes missing project, empty, pending and verified ready history', async () => {
    const f = await fixture('per_project');
    expect(await f.resolve(null)).toEqual({
      success: true,
      data: { mode: 'per_project', state: 'needs_project' },
    });
    expect(await f.resolve(f.projectB)).toEqual({
      success: true,
      data: { mode: 'per_project', state: 'empty' },
    });
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const reserved = await registry.reserve('builders', f.projectA);
    expect(await f.resolve(f.projectA)).toEqual({
      success: true,
      data: {
        mode: 'per_project',
        state: 'pending',
        reason: 'incomplete',
        projectPath: f.projectA,
        runId: null,
      },
    });
    const teamDir = path.join(getTeamsBasePath(), reserved.executionTeamName);
    await fs.mkdir(teamDir);
    await fs.mkdir(path.join(getTasksBasePath(), reserved.executionTeamName));
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: reserved.executionTeamName,
      })
    );
    await claimTeamForThisProfile({
      teamName: reserved.executionTeamName,
      teamsBasePath: getTeamsBasePath(),
      reason: 'create',
    });
    await registry.confirmReady('builders', f.projectA, reserved.executionTeamName);
    const handlerResult = await (() => {
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      const ipc = {
        handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(channel, fn);
        },
        removeHandler: (_channel: string) => undefined,
      };
      registerTeamProjectContextViewHandler(ipc as never);
      return handlers.get(TEAM_PROJECT_CONTEXT_VIEW_CHANNEL)!(
        null,
        reserved.executionTeamName,
        null
      );
    })();
    expect(handlerResult).toEqual({
      success: true,
      data: {
        mode: 'per_project',
        state: 'redirect',
        logicalTeamName: 'builders',
        projectPath: reserved.projectPath,
      },
    });
    expect(await f.resolve(f.projectA)).toEqual({
      success: true,
      data: {
        mode: 'per_project',
        state: 'ready',
        executionTeamName: reserved.executionTeamName,
        workContextId: reserved.id,
        projectPath: reserved.projectPath,
      },
    });
  });

  it('distinguishes a tracked launch from a stopped interrupted launch and unknown ownership', async () => {
    const f = await fixture('per_project');
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const reserved = await registry.reserve('builders', f.projectB);
    const tracked = trackProjectCopyLaunch(reserved.executionTeamName);
    try {
      expect(await f.resolve(f.projectB)).toMatchObject({
        data: { state: 'pending', reason: 'launching' },
      });
    } finally {
      tracked.end();
    }
    f.runtime.getRuntimeState.mockResolvedValue({
      teamName: reserved.executionTeamName,
      isAlive: false,
      runId: 'failed-before-restart',
      progress: {
        runId: 'failed-before-restart',
        teamName: reserved.executionTeamName,
        state: 'failed',
        message: 'Old failure',
        startedAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
    });
    expect(await f.resolve(f.projectB)).toMatchObject({
      data: {
        state: 'pending',
        reason: 'incomplete',
        runId: 'failed-before-restart',
        projectPath: f.projectB,
      },
    });
    f.runtime.getRuntimeState.mockResolvedValueOnce({
      teamName: reserved.executionTeamName,
      isAlive: false,
      runId: 'new-run',
      progress: {
        runId: 'old-run',
        teamName: reserved.executionTeamName,
        state: 'failed',
        message: 'Old failure',
        startedAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
    });
    expect(await f.resolve(f.projectB)).toMatchObject({ data: { reason: 'unknown' } });
    f.runtime.hasProvisioningRun.mockReturnValue(true);
    expect(await f.resolve(f.projectB)).toMatchObject({ data: { reason: 'unknown' } });
    f.runtime.hasProvisioningRun.mockReturnValue(false);
    f.runtime.getRuntimeState.mockRejectedValue(new Error('Cannot establish process ownership'));
    expect(await f.resolve(f.projectB)).toMatchObject({ data: { reason: 'unknown' } });
    expect(await registry.inspect('builders', f.projectB)).toEqual(reserved);
  });

  it('reports the verified current run while a project launch is still tracked', async () => {
    const f = await fixture('per_project');
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const reserved = await registry.reserve('builders', f.projectA);
    const tracked = trackProjectCopyLaunch(reserved.executionTeamName);
    try {
      f.runtime.getRuntimeState.mockResolvedValue({
        teamName: reserved.executionTeamName,
        isAlive: true,
        runId: 'current-launch',
        progress: {
          teamName: reserved.executionTeamName,
          runId: 'current-launch',
          state: 'spawning',
          message: 'Joining',
          startedAt: '2026-11-22',
          updatedAt: '2026-11-22',
        },
      });
      await expect(f.resolve(f.projectA)).resolves.toMatchObject({
        data: { reason: 'launching', runId: 'current-launch' },
      });
      f.runtime.getRuntimeState.mockResolvedValue({
        teamName: 'unrelated',
        isAlive: true,
        runId: 'other-run',
        progress: null,
      });
      await expect(f.resolve(f.projectA)).resolves.toMatchObject({
        data: { reason: 'unknown', runId: null },
      });
    } finally {
      tracked.end();
    }
  });

  it('names the pending project for edit recovery without opening or modifying its history', async () => {
    const f = await fixture('per_project');
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    await registry.reserve('builders', f.projectB);
    expect(await f.resolve(null)).toEqual({
      success: true,
      data: {
        mode: 'per_project',
        state: 'needs_project',
        recoveryProjectPath: f.projectB,
      },
    });
    expect(await f.resolve(f.projectA)).toEqual({
      success: true,
      data: {
        mode: 'per_project',
        state: 'empty',
      },
    });
  });

  it('refuses an alias whose logical team is not per-project instead of opening another history', async () => {
    const f = await fixture('per_project');
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const reserved = await registry.reserve('builders', f.projectA);
    const teamDir = path.join(getTeamsBasePath(), reserved.executionTeamName);
    await fs.mkdir(teamDir);
    await fs.mkdir(path.join(getTasksBasePath(), reserved.executionTeamName));
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: reserved.executionTeamName,
      })
    );
    await claimTeamForThisProfile({
      teamName: reserved.executionTeamName,
      teamsBasePath: getTeamsBasePath(),
      reason: 'create',
    });
    await registry.confirmReady('builders', f.projectA, reserved.executionTeamName);
    const store = new TeamMetaStore();
    await store.updateMeta('builders', (meta) => ({
      ...meta!,
      projectContextMode: 'shared',
    }));

    expect(await f.resolve(f.projectA)).toEqual({
      success: true,
      data: { mode: 'shared', state: 'ready', executionTeamName: 'builders' },
    });
    // The app never produces this combination (the mode is fixed at creation).
    // Fail closed rather than redirect into an unrelated shared history.
    expect(await f.resolve(null, reserved.executionTeamName)).toMatchObject({
      success: false,
      error: expect.stringContaining('not a per-project team'),
    });
  });

  it('never reveals an unowned alias even if the manifest says ready', async () => {
    const f = await fixture('per_project');
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const reserved = await registry.reserve('builders', f.projectA);
    const dir = path.join(getTeamsBasePath(), reserved.executionTeamName);
    await fs.mkdir(dir);
    await fs.mkdir(path.join(getTasksBasePath(), reserved.executionTeamName));
    await fs.writeFile(path.join(dir, 'config.json'), '{}');
    await claimTeamForThisProfile({
      teamName: reserved.executionTeamName,
      teamsBasePath: getTeamsBasePath(),
      reason: 'create',
    });
    await registry.confirmReady('builders', f.projectA, reserved.executionTeamName);
    await fs.unlink(path.join(dir, '.agent-teams-owner.json'));
    expect(await f.resolve(f.projectA)).toMatchObject({ success: false });
  });
});

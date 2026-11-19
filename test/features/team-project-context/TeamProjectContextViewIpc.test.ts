import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TEAM_PROJECT_CONTEXT_VIEW_CHANNEL } from '../../../src/features/team-project-context/contracts';
import { TeamProjectContextRegistry } from '../../../src/features/team-project-context/main';
import { registerTeamProjectContextViewHandler } from '../../../src/features/team-project-context/main/TeamProjectContextViewIpc';
import { TeamMetaStore } from '../../../src/main/services/team/TeamMetaStore';
import { claimTeamForThisProfile } from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import {
  getTasksBasePath,
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../src/main/utils/pathDecoder';

const roots: string[] = [];

async function fixture(mode?: 'shared' | 'per_project') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-context-view-'));
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
    teamName: 'builders', teamsBasePath: getTeamsBasePath(), reason: 'create',
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
  registerTeamProjectContextViewHandler(ipc as never);
  const resolve = async (projectPath: string | null, teamName = 'builders') => {
    const handler = handlers.get(TEAM_PROJECT_CONTEXT_VIEW_CHANNEL);
    if (!handler) throw new Error('Handler not registered');
    return handler(null, teamName, projectPath);
  };
  return { projectA, projectB, resolve };
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
      success: true, data: { mode: 'per_project', state: 'needs_project' },
    });
    expect(await f.resolve(f.projectB)).toEqual({
      success: true, data: { mode: 'per_project', state: 'empty' },
    });
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const reserved = await registry.reserve('builders', f.projectA);
    expect(await f.resolve(f.projectA)).toEqual({
      success: true, data: { mode: 'per_project', state: 'pending' },
    });
    const teamDir = path.join(getTeamsBasePath(), reserved.executionTeamName);
    await fs.mkdir(teamDir);
    await fs.mkdir(path.join(getTasksBasePath(), reserved.executionTeamName));
    await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify({
      name: reserved.executionTeamName,
    }));
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
      return handlers.get(TEAM_PROJECT_CONTEXT_VIEW_CHANNEL)!(null, reserved.executionTeamName, null);
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

  it('opens a verified old project alias after switching its logical team back to shared', async () => {
    const f = await fixture('per_project');
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const reserved = await registry.reserve('builders', f.projectA);
    const teamDir = path.join(getTeamsBasePath(), reserved.executionTeamName);
    await fs.mkdir(teamDir);
    await fs.mkdir(path.join(getTasksBasePath(), reserved.executionTeamName));
    await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify({
      name: reserved.executionTeamName,
    }));
    await claimTeamForThisProfile({
      teamName: reserved.executionTeamName,
      teamsBasePath: getTeamsBasePath(),
      reason: 'create',
    });
    await registry.confirmReady('builders', f.projectA, reserved.executionTeamName);
    const store = new TeamMetaStore();
    await store.updateMeta('builders', (meta) => ({
      ...meta!, projectContextMode: 'shared',
    }));

    expect(await f.resolve(f.projectA)).toEqual({
      success: true,
      data: { mode: 'shared', state: 'ready', executionTeamName: 'builders' },
    });
    expect(await f.resolve(null, reserved.executionTeamName)).toEqual({
      success: true,
      data: {
        mode: 'per_project',
        state: 'retained',
        logicalTeamName: 'builders',
        executionTeamName: reserved.executionTeamName,
        workContextId: reserved.id,
        projectPath: reserved.projectPath,
      },
    });
    await fs.unlink(path.join(teamDir, '.agent-teams-owner.json'));
    expect(await f.resolve(null, reserved.executionTeamName)).toMatchObject({ success: false });
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTeamWithProjectContext } from '../../../src/main/ipc/teams/teamProjectContextCreate';
import {
  getTasksBasePath,
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../src/main/utils/pathDecoder';
import { claimTeamForThisProfile } from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { TeamProjectContextRegistry } from '../../../src/features/team-project-context/main';

import type {
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
    async createTeamConfig(request: TeamCreateConfigRequest): Promise<void> {
      const name = request.teamName;
      const teamDir = path.join(getTeamsBasePath(), name);
      const taskDir = path.join(getTasksBasePath(), name);
      await fs.mkdir(teamDir);
      await fs.mkdir(taskDir);
      await fs.writeFile(path.join(teamDir, 'team.meta.json'), JSON.stringify({
        version: 1, cwd: request.cwd ?? '', createdAt: 1,
        projectContextMode: request.projectContextMode,
      }));
      if (request.projectContextMode === 'per_project') {
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
    async runConfigurationOperation<T>(_teamName: string, fn: () => Promise<T>): Promise<T> {
      return fn();
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

  it('preserves the native team name and paths in shared mode', async () => {
    const f = await fixture();
    await createTeamWithProjectContext({
      teamName: 'legacy', cwd: f.projectPath, members: [], projectContextMode: 'shared',
    }, f.onProgress, f.ports);
    expect(f.started).toEqual([expect.objectContaining({ teamName: 'legacy' })]);
    await expect(fs.readFile(path.join(getTeamsBasePath(), 'legacy', 'project-contexts.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TEAM_PROJECT_CONTEXT_SET_MODE_CHANNEL } from '../../../src/features/team-project-context/contracts';
import { registerTeamProjectContextModeHandler } from '../../../src/features/team-project-context/main/TeamProjectContextModeIpc';
import { TeamMetaStore } from '../../../src/main/services/team/TeamMetaStore';
import {
  claimTeamForThisProfile,
  readTeamOwnerProfileScope,
  resolveThisAppProfileScope,
} from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import {
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../src/main/utils/pathDecoder';

import type { TeamRuntimeState } from '../../../src/shared/types/team';

const roots: string[] = [];

async function fixture(options?: { owner?: string; mode?: 'shared' | 'per_project'; name?: string }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-history-mode-'));
  roots.push(root);
  setClaudeBasePathOverride(path.join(root, 'claude'));
  setAppDataBasePath(path.join(root, 'app'));
  const teamName = options?.name ?? 'builders';
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await fs.mkdir(teamDir, { recursive: true });
  const meta = new TeamMetaStore();
  await meta.writeMeta(teamName, {
    cwd: root, createdAt: 1,
    ...(options?.mode ? { projectContextMode: options.mode } : {}),
  });
  if (options?.owner) {
    await claimTeamForThisProfile({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      reason: 'create',
      profileScope: options.owner,
    });
  }
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipc = {
    handle: (_channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(_channel, fn),
    removeHandler: (_channel: string) => handlers.delete(_channel),
  };
  const runtime = {
    withLogicalTeamLock: async <T>(_: string, fn: () => Promise<T>): Promise<T> => fn(),
    getRuntimeState: vi.fn(async (teamName: string): Promise<TeamRuntimeState> => ({
      teamName, isAlive: false, runId: null, progress: null,
    })),
    hasProvisioningRun: vi.fn(() => false),
  };
  registerTeamProjectContextModeHandler(ipc as never, runtime);
  return {
    meta, teamDir, runtime,
    setMode: async (mode: unknown, name: unknown = teamName) => {
      const handler = handlers.get(TEAM_PROJECT_CONTEXT_SET_MODE_CHANNEL);
      if (!handler) throw new Error('Not registered');
      return handler(null, name, mode) as Promise<{ success: boolean; error?: string }>;
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('team history mode IPC', () => {
  it('changes the mode explicitly and leaves old data roots untouched', async () => {
    const f = await fixture();
    expect((await f.meta.getMeta('builders'))?.projectContextMode).toBeUndefined();
    expect(await f.setMode('per_project')).toMatchObject({ success: true });
    expect((await f.meta.getMeta('builders'))?.projectContextMode).toBe('per_project');
    expect(await readTeamOwnerProfileScope(f.teamDir)).toBe(resolveThisAppProfileScope());
    expect(await f.setMode('shared')).toMatchObject({ success: true });
    expect((await f.meta.getMeta('builders'))?.projectContextMode).toBe('shared');
  });

  it('denies changes for live teams and preserves the stored mode', async () => {
    const f = await fixture({ owner: 'x', mode: 'shared' });
    f.runtime.getRuntimeState.mockImplementation(async (teamName) => ({
      teamName, isAlive: true, runId: 'running', progress: null,
    }));
    expect(await f.setMode('per_project')).toMatchObject({ success: false });
    expect((await f.meta.getMeta('builders'))?.projectContextMode).toBe('shared');
  });

  it('rejects explicitly foreign ownership markers', async () => {
    const f = await fixture({ owner: 'another-profile' });
    const result = await f.setMode('per_project');
    expect(result).toMatchObject({ success: false });
    expect((await f.meta.getMeta('builders'))?.projectContextMode).toBeUndefined();
  });

  it('accepts legacy names up to 128 characters when switching team history mode', async () => {
    const name = 'legacy-' + 'a'.repeat(100);
    const f = await fixture({ name });
    expect(await f.setMode('per_project')).toMatchObject({ success: true });
    expect((await f.meta.getMeta(name))?.projectContextMode).toBe('per_project');
    expect(await readTeamOwnerProfileScope(f.teamDir)).toBe(resolveThisAppProfileScope());
  });

  it('rejects invalid modes instead of persisting unknown metadata', async () => {
    const f = await fixture();
    expect(await f.setMode('partial')).toMatchObject({
      success: false, error: 'Invalid project history mode',
    });
  });
});

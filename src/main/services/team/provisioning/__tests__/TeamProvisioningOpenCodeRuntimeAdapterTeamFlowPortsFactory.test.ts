import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeRuntimeAdapterTeamFlowPortsFromService,
  type TeamProvisioningOpenCodeRuntimeAdapterTeamFlowServiceHost,
} from '../TeamProvisioningOpenCodeRuntimeAdapterTeamFlowPortsFactory';
import { TEAM_CONFIG_MAX_BYTES, TEAM_JSON_READ_TIMEOUT_MS } from '../TeamProvisioningRunModel';

function createService(): TeamProvisioningOpenCodeRuntimeAdapterTeamFlowServiceHost {
  return {
    pathExists: vi.fn(async () => false),
    teamMetaStore: {
      writeMeta: vi.fn(async () => undefined),
    },
    membersMetaStore: {
      writeMembers: vi.fn(async () => undefined),
    },
    writeOpenCodeTeamConfig: vi.fn(async () => undefined),
    prepareFacade: {
      prepareOpenCodeRuntimeAdapterLaunch: vi.fn(),
    },
    resolveLaunchExpectedMembers: vi.fn(async () => ({
      members: [],
      source: 'config-fallback' as const,
    })),
    updateConfigProjectPath: vi.fn(async () => undefined),
    runOpenCodeWorktreeRootAggregateLaunch: vi.fn(),
    runOpenCodeTeamRuntimeAdapterLaunch: vi.fn(),
  };
}

describe('TeamProvisioningOpenCodeRuntimeAdapterTeamFlowPortsFactory', () => {
  it.skipIf(process.platform === 'win32')(
    'creates fresh team state privately through default ports under umask 002 without repairing existing paths',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'test-opencode-private-state-'));
      // eslint-disable-next-line sonarjs/file-permissions -- TEST-only umask reproduces group-write defaults; restored in finally and confined to this temporary directory.
      const previousUmask = process.umask(0o002);
      try {
        const claudeRoot = path.join(root, 'claude');
        const teamsRoot = path.join(claudeRoot, 'teams');
        const tasksRoot = path.join(claudeRoot, 'tasks');
        const ports = createOpenCodeRuntimeAdapterTeamFlowPortsFromService(createService(), {
          getTeamsBasePath: () => teamsRoot,
          getTasksBasePath: () => tasksRoot,
        });
        const teamDir = path.join(ports.getTeamsBasePath(), 'fresh');
        const tasksDir = path.join(ports.getTasksBasePath(), 'fresh');
        const inboxDir = path.join(teamDir, 'inboxes');
        const created = await ports.mkdir(teamDir);
        expect(created).toBe(claudeRoot);
        await ports.mkdir(tasksDir);
        if (created) await ports.mkdir(inboxDir);
        for (const directory of [claudeRoot, teamsRoot, teamDir, inboxDir, tasksRoot, tasksDir]) {
          const stat = await fs.stat(directory);
          expect(stat.mode & 0o777).toBe(0o700);
          expect(stat.uid).toBe(process.getuid?.());
        }
        const unsafeDirectory = path.join(teamsRoot, 'existing');
        await fs.mkdir(unsafeDirectory);
        const before = await fs.stat(unsafeDirectory);
        expect(before.mode & 0o777).toBe(0o775);
        expect(await ports.mkdir(unsafeDirectory)).toBeUndefined();
        const after = await fs.stat(unsafeDirectory);
        expect(after.ino).toBe(before.ino);
        expect(after.mode & 0o777).toBe(0o775);
      } finally {
        process.umask(previousUmask);
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );

  it('builds ports from service-shaped dependencies without freezing mutable functions', async () => {
    const service = createService();
    const secondPathExists = vi.fn(async () => true);
    const ports = createOpenCodeRuntimeAdapterTeamFlowPortsFromService(service, {
      getTeamsBasePathsToProbe: () => [{ location: 'configured', basePath: '/teams' }],
      getTeamsBasePath: () => '/teams',
      getTasksBasePath: () => '/tasks',
      ensureCwdExists: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      nowMs: () => 123,
      readExistingTasks: vi.fn(async () => []),
      warn: vi.fn(),
    });

    expect(ports.getTeamsBasePath()).toBe('/teams');
    expect(ports.getTasksBasePath()).toBe('/tasks');
    expect(ports.nowMs()).toBe(123);
    await expect(ports.pathExists('/first')).resolves.toBe(false);
    service.pathExists = secondPathExists;
    await expect(ports.pathExists('/second')).resolves.toBe(true);
    expect(secondPathExists).toHaveBeenCalledWith('/second');
  });

  it('reads raw team config from the configured teams base path', async () => {
    const service = createService();
    const readRegularFileUtf8 = vi.fn(async () => '{"teamName":"alpha"}');
    const ports = createOpenCodeRuntimeAdapterTeamFlowPortsFromService(service, {
      getTeamsBasePath: () => '/teams',
      readRegularFileUtf8,
    });

    await expect(ports.readTeamConfigRaw('alpha')).resolves.toBe('{"teamName":"alpha"}');
    expect(readRegularFileUtf8).toHaveBeenCalledWith(path.join('/teams', 'alpha', 'config.json'), {
      timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      maxBytes: TEAM_CONFIG_MAX_BYTES,
    });
  });
});

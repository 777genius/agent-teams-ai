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
    expect(readRegularFileUtf8).toHaveBeenCalledWith('/teams/alpha/config.json', {
      timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      maxBytes: TEAM_CONFIG_MAX_BYTES,
    });
  });
});

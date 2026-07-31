import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';
import { TeamDataConfigurationCompatibilityService } from '../../../../src/main/services/team/TeamDataConfigurationCompatibilityService';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { TeamConfig } from '../../../../src/shared/types';

const tempPaths: string[] = [];

function createService(
  configReader: Record<string, unknown>,
  invalidateNotificationContext = vi.fn(),
  invalidateGlobalTaskProjectionCache = vi.fn()
) {
  return {
    invalidateGlobalTaskProjectionCache,
    invalidateNotificationContext,
    service: new TeamDataConfigurationCompatibilityService(
      configReader as never,
      {} as never,
      {} as never,
      invalidateNotificationContext,
      invalidateGlobalTaskProjectionCache
    ),
  };
}

afterEach(async () => {
  setClaudeBasePathOverride(null);
  vi.restoreAllMocks();
  await Promise.all(
    tempPaths.splice(0).map((tempPath) => fs.rm(tempPath, { recursive: true, force: true }))
  );
});

describe('TeamDataConfigurationCompatibilityService', () => {
  it('soft-deletes from the verified config read, persists atomically, primes, and invalidates', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-config-compat-delete-'));
    tempPaths.push(claudeRoot);
    setClaudeBasePathOverride(claudeRoot);
    await fs.mkdir(path.join(claudeRoot, 'teams', 'alpha'), { recursive: true });

    const config: TeamConfig = { name: 'alpha', members: [] };
    const getConfig = vi.fn(async () => config);
    const getConfigSnapshot = vi.fn(async () => {
      throw new Error('snapshot reads must not coordinate mutations');
    });
    const primeConfig = vi.spyOn(TeamConfigReader, 'primeConfig').mockResolvedValue();
    const harness = createService({ getConfig, getConfigSnapshot });

    await harness.service.deleteTeam('alpha');

    const persisted = JSON.parse(
      await fs.readFile(path.join(claudeRoot, 'teams', 'alpha', 'config.json'), 'utf8')
    ) as TeamConfig;
    expect(persisted.deletedAt).toEqual(expect.any(String));
    expect(getConfig).toHaveBeenCalledWith('alpha');
    expect(getConfigSnapshot).not.toHaveBeenCalled();
    expect(primeConfig).toHaveBeenCalledWith(
      'alpha',
      expect.objectContaining({
        deletedAt: expect.any(String),
      })
    );
    expect(harness.invalidateNotificationContext).toHaveBeenCalledWith('alpha');
  });

  it('restores by removing the tombstone while preserving other config fields', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-config-compat-restore-'));
    tempPaths.push(claudeRoot);
    setClaudeBasePathOverride(claudeRoot);
    await fs.mkdir(path.join(claudeRoot, 'teams', 'alpha'), { recursive: true });

    const config: TeamConfig = {
      name: 'alpha',
      description: 'preserved',
      members: [],
      deletedAt: '2026-07-31T10:00:00.000Z',
    };
    vi.spyOn(TeamConfigReader, 'primeConfig').mockResolvedValue();
    const harness = createService({ getConfig: vi.fn(async () => config) });

    await harness.service.restoreTeam('alpha');

    const persisted = JSON.parse(
      await fs.readFile(path.join(claudeRoot, 'teams', 'alpha', 'config.json'), 'utf8')
    ) as TeamConfig;
    expect(persisted).toMatchObject({ name: 'alpha', description: 'preserved' });
    expect(persisted).not.toHaveProperty('deletedAt');
    expect(harness.invalidateNotificationContext).toHaveBeenCalledWith('alpha');
  });

  it('rejects delete and restore consistently when the team config is absent', async () => {
    const harness = createService({ getConfig: vi.fn(async () => null) });

    await expect(harness.service.deleteTeam('missing')).rejects.toThrow('Team not found: missing');
    await expect(harness.service.restoreTeam('missing')).rejects.toThrow('Team not found: missing');
    expect(harness.invalidateNotificationContext).not.toHaveBeenCalled();
  });

  it('uses snapshot reads only for UI projection compatibility', async () => {
    const verified = { name: 'verified', members: [] } as TeamConfig;
    const snapshot = { name: 'snapshot', members: [] } as TeamConfig;
    const getConfig = vi.fn(async () => verified);
    const getConfigSnapshot = vi.fn(async () => snapshot);
    const harness = createService({ getConfig, getConfigSnapshot });

    await expect(harness.service.readConfigForUiSnapshot('alpha')).resolves.toBe(snapshot);
    expect(getConfigSnapshot).toHaveBeenCalledWith('alpha');
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('delegates list/update behavior and invalidates updated notification context', async () => {
    const updated = { name: 'alpha', description: 'updated', members: [] } as TeamConfig;
    const listTeams = vi.fn(async () => []);
    const updateConfig = vi.fn(async () => updated);
    const harness = createService({ listTeams, updateConfig });

    await expect(harness.service.listTeams()).resolves.toEqual([]);
    await expect(harness.service.updateConfig('alpha', { description: 'updated' })).resolves.toBe(
      updated
    );
    expect(updateConfig).toHaveBeenCalledWith('alpha', { description: 'updated' });
    expect(harness.invalidateNotificationContext).toHaveBeenCalledWith('alpha');
  });
});

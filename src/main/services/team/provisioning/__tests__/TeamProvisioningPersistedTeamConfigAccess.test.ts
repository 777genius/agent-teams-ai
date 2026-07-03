import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  listPersistedTeamNames,
  type PersistedTeamConfigCacheEntry,
  readPersistedRuntimeMembers,
  readPersistedTeamConfig,
  readPersistedTeamProjectPath,
} from '../TeamProvisioningPersistedTeamConfigAccess';

const tempRoots: string[] = [];

function createTeamsBasePath(): string {
  const teamsBasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'persisted-team-config-'));
  tempRoots.push(teamsBasePath);
  return teamsBasePath;
}

function writeTeamConfig(
  teamsBasePath: string,
  teamName: string,
  config: Record<string, unknown> | string
): void {
  const teamDir = path.join(teamsBasePath, teamName);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, 'config.json'),
    typeof config === 'string' ? config : JSON.stringify(config),
    'utf8'
  );
}

function createCacheEntry(overrides: Partial<PersistedTeamConfigCacheEntry> = {}) {
  return {
    path: '/stale/config.json',
    size: 1,
    mtimeMs: 1,
    ctimeMs: 1,
    projectPath: '/stale',
    members: [{ name: 'stale' }],
    ...overrides,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('TeamProvisioningPersistedTeamConfigAccess', () => {
  it('reads, trims, caches, and clones persisted team config data', () => {
    const teamsBasePath = createTeamsBasePath();
    const cache = new Map<string, PersistedTeamConfigCacheEntry>();
    writeTeamConfig(teamsBasePath, 'team-a', {
      projectPath: ' /repo/team-a ',
      members: [{ name: 'builder', tmuxPaneId: '%1' }, null, 'bad', ['array-member']],
    });

    const access = { teamsBasePath, cache };
    const entry = readPersistedTeamConfig('team-a', access);

    expect(entry).toMatchObject({
      projectPath: '/repo/team-a',
      members: [{ name: 'builder', tmuxPaneId: '%1' }, { 0: 'array-member' }],
    });
    expect(readPersistedTeamConfig('team-a', access)).toBe(entry);
    expect(readPersistedTeamProjectPath('team-a', access)).toBe('/repo/team-a');

    const firstMembers = readPersistedRuntimeMembers('team-a', access);
    firstMembers[0].name = 'mutated';

    expect(readPersistedRuntimeMembers('team-a', access)).toEqual([
      { name: 'builder', tmuxPaneId: '%1' },
      { 0: 'array-member' },
    ]);
  });

  it('returns null values and empty members for missing or blank persisted config fields', () => {
    const teamsBasePath = createTeamsBasePath();
    const cache = new Map<string, PersistedTeamConfigCacheEntry>();
    writeTeamConfig(teamsBasePath, 'team-a', {
      projectPath: '   ',
      members: { name: 'not-array' },
    });

    const access = { teamsBasePath, cache };

    expect(readPersistedTeamProjectPath('team-a', access)).toBeNull();
    expect(readPersistedRuntimeMembers('team-a', access)).toEqual([]);
  });

  it('deletes stale cache entries when the config is missing or unreadable', () => {
    const teamsBasePath = createTeamsBasePath();
    const missingCache = new Map<string, PersistedTeamConfigCacheEntry>([
      ['missing', createCacheEntry()],
    ]);

    expect(readPersistedTeamConfig('missing', { teamsBasePath, cache: missingCache })).toBeNull();
    expect(missingCache.has('missing')).toBe(false);

    const invalidCache = new Map<string, PersistedTeamConfigCacheEntry>([
      ['invalid', createCacheEntry({ size: -1 })],
    ]);
    writeTeamConfig(teamsBasePath, 'invalid', '{ invalid json');

    expect(readPersistedTeamConfig('invalid', { teamsBasePath, cache: invalidCache })).toBeNull();
    expect(invalidCache.has('invalid')).toBe(false);
  });

  it('lists only persisted team directory names after trimming', () => {
    const teamsBasePath = createTeamsBasePath();
    fs.mkdirSync(path.join(teamsBasePath, ' Team A '));
    fs.mkdirSync(path.join(teamsBasePath, 'team-b'));
    fs.mkdirSync(path.join(teamsBasePath, '   '));
    fs.writeFileSync(path.join(teamsBasePath, 'not-a-team'), '', 'utf8');

    expect(listPersistedTeamNames(teamsBasePath).sort()).toEqual(['Team A', 'team-b']);
    expect(listPersistedTeamNames(path.join(teamsBasePath, 'missing'))).toEqual([]);
  });
});

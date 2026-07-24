import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  TeamProvisioningConfigMaintenance,
  type TeamProvisioningConfigMaintenancePorts,
} from '../TeamProvisioningConfigMaintenance';

import type { TeamCreateRequest, TeamMember } from '@shared/types';

const TEAM_BASE = '/teams';
const PROJECTS_BASE = '/projects';

interface Harness {
  files: Map<string, string>;
  maintenance: TeamProvisioningConfigMaintenance;
  ports: TeamProvisioningConfigMaintenancePorts;
  invalidatedTeams: string[];
  logs: { info: string[]; warn: string[]; debug: string[] };
}

function makeRequest(members: TeamCreateRequest['members']): TeamCreateRequest {
  return {
    teamName: 'launch-team',
    members,
    cwd: '/repo/app',
  };
}

function listFilesInDir(files: Map<string, string>, dirPath: string): string[] {
  const prefix = `${dirPath}${path.sep}`;
  return Array.from(files.keys())
    .filter((filePath) => filePath.startsWith(prefix))
    .map((filePath) => filePath.slice(prefix.length))
    .filter((relativePath) => relativePath.length > 0 && !relativePath.includes(path.sep));
}

function createHarness(
  options: {
    files?: Record<string, string>;
    metaMembers?: TeamMember[];
    rawMetaMembers?: TeamMember[];
    writeMembers?: TeamProvisioningConfigMaintenancePorts['membersMetaStore']['writeMembers'];
    getMembers?: TeamProvisioningConfigMaintenancePorts['membersMetaStore']['getMembers'];
    updateMembers?: TeamProvisioningConfigMaintenancePorts['membersMetaStore']['updateMembers'];
    writeFileUtf8?: TeamProvisioningConfigMaintenancePorts['writeFileUtf8'];
  } = {}
): Harness {
  const files = new Map(Object.entries(options.files ?? {}));
  const invalidatedTeams: string[] = [];
  const logs = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  const writeMembers =
    options.writeMembers ??
    vi.fn(async (_teamName: string, members: TeamMember[]) => {
      files.set('/members.meta.json', JSON.stringify(members, null, 2));
    });
  const getMembers = options.getMembers ?? vi.fn(async () => options.metaMembers ?? []);
  let rawMetaMembers = options.rawMetaMembers ?? options.metaMembers ?? [];
  const updateMembers =
    options.updateMembers ??
    vi.fn(async (teamName, update, memberOptions) => {
      rawMetaMembers = update(rawMetaMembers);
      if (memberOptions === undefined) {
        await writeMembers(teamName, rawMetaMembers);
      } else {
        await writeMembers(teamName, rawMetaMembers, memberOptions);
      }
    });

  const ports: TeamProvisioningConfigMaintenancePorts = {
    getTeamsBasePath: () => TEAM_BASE,
    getProjectsBasePath: () => PROJECTS_BASE,
    readRegularFileUtf8: vi.fn(async (filePath) => files.get(filePath) ?? null),
    writeFileUtf8:
      options.writeFileUtf8 ??
      vi.fn(async (filePath, contents) => {
        files.set(filePath, contents);
      }),
    unlink: vi.fn(async (filePath) => {
      if (!files.delete(filePath)) {
        throw new Error('missing');
      }
    }),
    readDir: vi.fn(async (dirPath) => listFilesInDir(files, dirPath)),
    stat: vi.fn(async () => ({ isFile: () => true, mtimeMs: 0 })),
    withCanonicalInboxLock: vi.fn(async (_filePath, fn) => fn()),
    scanForNewestProjectSession: vi.fn(async () => null),
    membersMetaStore: {
      getMembers,
      writeMembers,
      updateMembers,
    },
    invalidateTeam: vi.fn((teamName) => {
      invalidatedTeams.push(teamName);
    }),
    getLanguage: () => 'system',
    now: () => 123_456,
    logger: {
      info: vi.fn((message) => logs.info.push(message)),
      warn: vi.fn((message) => logs.warn.push(message)),
      debug: vi.fn((message) => logs.debug.push(message)),
    },
  };

  return {
    files,
    maintenance: new TeamProvisioningConfigMaintenance({
      ports,
      limits: {
        teamJsonReadTimeoutMs: 5_000,
        teamConfigMaxBytes: 10 * 1024 * 1024,
        teamInboxMaxBytes: 2 * 1024 * 1024,
      },
    }),
    ports,
    invalidatedTeams,
    logs,
  };
}

describe('TeamProvisioningConfigMaintenance', () => {
  it('backs up and normalizes launch config, then merges duplicate inboxes using in-memory ports', async () => {
    const teamName = 'launch-team';
    const configPath = path.join(TEAM_BASE, teamName, 'config.json');
    const backupPath = `${configPath}.prelaunch.bak`;
    const inboxDir = path.join(TEAM_BASE, teamName, 'inboxes');
    const configRaw = JSON.stringify({
      leadAgentId: 'lead-1',
      members: [
        { name: 'team-lead', agentType: 'team-lead', agentId: 'lead-1' },
        { name: 'Alice', agentType: 'general-purpose' },
      ],
    });
    const { files, maintenance, invalidatedTeams, logs } = createHarness({
      files: {
        [configPath]: configRaw,
        [path.join(inboxDir, 'Alice.json')]: JSON.stringify([
          { messageId: 'base', timestamp: '2026-01-01T00:00:00.000Z' },
        ]),
        [path.join(inboxDir, 'Alice-2.json')]: JSON.stringify([
          { messageId: 'dupe', timestamp: '2026-01-02T00:00:00.000Z' },
        ]),
      },
      metaMembers: [{ name: 'Alice' }],
    });

    await maintenance.normalizeTeamConfigForLaunch(teamName, configRaw);

    expect(files.get(backupPath)).toBe(configRaw);
    expect(JSON.parse(files.get(configPath) ?? '{}')).toEqual({
      leadAgentId: 'lead-1',
      members: [{ name: 'team-lead', agentType: 'team-lead', agentId: 'lead-1' }],
    });
    expect(JSON.parse(files.get(path.join(inboxDir, 'Alice.json')) ?? '[]')).toEqual([
      { messageId: 'dupe', timestamp: '2026-01-02T00:00:00.000Z' },
      { messageId: 'base', timestamp: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(files.has(path.join(inboxDir, 'Alice-2.json'))).toBe(false);
    expect(invalidatedTeams).toEqual([teamName]);
    expect(logs.info).toContain(
      '[launch-team] Normalized config.json for launch: kept 1 lead member(s)'
    );
  });

  it('does not normalize config or inboxes when the prelaunch backup write fails', async () => {
    const teamName = 'launch-team';
    const configPath = path.join(TEAM_BASE, teamName, 'config.json');
    const backupPath = `${configPath}.prelaunch.bak`;
    const inboxDir = path.join(TEAM_BASE, teamName, 'inboxes');
    const duplicateInboxPath = path.join(inboxDir, 'Alice-2.json');
    const configRaw = JSON.stringify({
      members: [
        { name: 'team-lead', agentType: 'team-lead' },
        { name: 'Alice', agentType: 'general-purpose' },
      ],
    });
    const initialFiles = {
      [configPath]: configRaw,
      [duplicateInboxPath]: JSON.stringify([{ messageId: 'dupe' }]),
    };
    const files = new Map(Object.entries(initialFiles));
    const writeFileUtf8 = vi.fn(async (filePath: string, contents: string) => {
      if (filePath === backupPath) {
        throw new Error('backup disk full');
      }
      files.set(filePath, contents);
    });
    const harness = createHarness({
      files: initialFiles,
      metaMembers: [{ name: 'Alice' }],
      writeFileUtf8,
    });
    for (const [filePath, contents] of files) {
      harness.files.set(filePath, contents);
    }

    await harness.maintenance.normalizeTeamConfigForLaunch(teamName, configRaw);

    expect(harness.files.get(configPath)).toBe(configRaw);
    expect(harness.files.has(duplicateInboxPath)).toBe(true);
    expect(harness.invalidatedTeams).toEqual([]);
    expect(writeFileUtf8).toHaveBeenCalledTimes(1);
    expect(harness.logs.warn).toEqual([
      '[launch-team] Failed to write config prelaunch backup: backup disk full',
    ]);
  });

  it('restores config.json from the prelaunch backup and invalidates the reader', async () => {
    const teamName = 'launch-team';
    const configPath = path.join(TEAM_BASE, teamName, 'config.json');
    const backupRaw = JSON.stringify({ members: [{ name: 'Alice' }] }, null, 2);
    const { files, maintenance, invalidatedTeams, logs } = createHarness({
      files: {
        [configPath]: JSON.stringify({ members: [{ name: 'team-lead' }] }),
        [`${configPath}.prelaunch.bak`]: backupRaw,
      },
    });

    await maintenance.restorePrelaunchConfig(teamName);

    expect(files.get(configPath)).toBe(backupRaw);
    expect(invalidatedTeams).toEqual([teamName]);
    expect(logs.info).toContain(
      '[launch-team] Restored config.json from prelaunch backup after launch failure'
    );
  });

  it('cleans CLI auto-suffixed config and metadata members with best-effort inbox merge', async () => {
    const teamName = 'launch-team';
    const configPath = path.join(TEAM_BASE, teamName, 'config.json');
    const inboxDir = path.join(TEAM_BASE, teamName, 'inboxes');
    const writeMembers = vi.fn(async () => undefined);
    const { files, maintenance, invalidatedTeams, logs, ports } = createHarness({
      files: {
        [configPath]: JSON.stringify({
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'Alice' },
            { name: 'Alice-2' },
          ],
        }),
        [path.join(inboxDir, 'Bob.json')]: JSON.stringify([
          { messageId: 'bob', timestamp: '2026-01-01T00:00:00.000Z' },
        ]),
        [path.join(inboxDir, 'Bob-2.json')]: JSON.stringify([
          { messageId: 'bob-2', timestamp: '2026-01-02T00:00:00.000Z' },
        ]),
      },
      metaMembers: [{ name: 'Bob' }],
      rawMetaMembers: [{ name: 'Bob' }, { name: 'Bob-2' }],
      writeMembers,
    });

    await maintenance.cleanupCliAutoSuffixedMembers(teamName);

    expect(
      JSON.parse(files.get(configPath) ?? '{}').members.map((member: TeamMember) => member.name)
    ).toEqual(['team-lead', 'Alice']);
    expect(writeMembers).toHaveBeenCalledWith(teamName, [{ name: 'Bob' }]);
    expect(ports.membersMetaStore.updateMembers).toHaveBeenCalledTimes(1);
    expect(JSON.parse(files.get(path.join(inboxDir, 'Bob.json')) ?? '[]')).toEqual([
      { messageId: 'bob-2', timestamp: '2026-01-02T00:00:00.000Z' },
      { messageId: 'bob', timestamp: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(files.has(path.join(inboxDir, 'Bob-2.json'))).toBe(false);
    expect(invalidatedTeams).toEqual([teamName]);
    expect(logs.warn).toContain(
      '[launch-team] Removed CLI auto-suffixed members from config.json: Alice-2'
    );
    expect(logs.warn).toContain(
      '[launch-team] Removed CLI auto-suffixed members from members.meta.json: Bob-2'
    );
  });

  it('does not persist members.meta.json when the request contains no teammates', async () => {
    const writeMembers = vi.fn(async () => undefined);
    const { maintenance, logs } = createHarness({ writeMembers });

    await maintenance.persistMembersMeta(
      'launch-team',
      makeRequest([{ name: 'team-lead' }, { name: 'user' }])
    );

    expect(writeMembers).not.toHaveBeenCalled();
    expect(logs.warn).toEqual([]);
  });

  it('retains removed-member tombstones when launch persistence rewrites members metadata', async () => {
    const writeMembers = vi.fn(async () => undefined);
    const removedAt = Date.parse('2026-07-14T17:00:00.000Z');
    const { maintenance, ports } = createHarness({
      metaMembers: [
        { name: 'Builder', role: 'Removed builder', removedAt },
        { name: 'Reviewer', role: 'Existing reviewer' },
      ],
      writeMembers,
    });

    await maintenance.persistMembersMeta(
      'launch-team',
      makeRequest([
        { name: 'builder', role: 'Stale builder' },
        { name: 'Reviewer', role: 'Current reviewer' },
      ])
    );

    expect(ports.membersMetaStore.updateMembers).toHaveBeenCalledTimes(1);
    expect(writeMembers).toHaveBeenCalledWith(
      'launch-team',
      [
        expect.objectContaining({
          name: 'Reviewer',
          role: 'Current reviewer',
          joinedAt: 123_456,
        }),
        { name: 'Builder', role: 'Removed builder', removedAt },
      ],
      { providerBackendId: undefined }
    );
  });

  it('logs and suppresses members.meta.json write errors', async () => {
    const writeMembers = vi.fn(async () => {
      throw new Error('readonly');
    });
    const { maintenance, logs } = createHarness({ writeMembers });

    await maintenance.persistMembersMeta(
      'launch-team',
      makeRequest([{ name: 'Builder', providerId: 'codex' }])
    );

    expect(writeMembers).toHaveBeenCalledTimes(1);
    expect(logs.warn).toEqual(['[launch-team] Failed to persist members.meta.json: readonly']);
  });
});

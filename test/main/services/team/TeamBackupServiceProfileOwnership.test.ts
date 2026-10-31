import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MemberWorkSyncTeamOperationGate } from '@features/member-work-sync/main';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOpenCodeAppProfileScope } from '../../../../src/main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import {
  claimTeamForThisProfile,
  createTeamProfileOwnership,
  TEAM_PROFILE_OWNER_MARKER_FILE,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { TeamBackupService } from '../../../../src/main/services/team/TeamBackupService';
import {
  getBackupsBasePath,
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

let root: string;
const services: TeamBackupService[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'TEST-backup-profile-ownership-'));
  setClaudeBasePathOverride(path.join(root, 'claude'));
  setAppDataBasePath(path.join(root, 'user-data-a'));
});

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await rm(root, { recursive: true, force: true });
});

const OWN = 'own';
const OTHER_PROFILE = 'other-profile';
const NATIVE_SESSION = 'session-1a2b3c';

function configPath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, 'config.json');
}

function inboxDir(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, 'inboxes');
}

function backupDir(teamName: string): string {
  return path.join(getBackupsBasePath(), 'teams', teamName);
}

/** The bytes a native Claude Code session or another app profile keeps writing. */
function foreignConfig(teamName: string): string {
  return `${JSON.stringify({ name: teamName, members: [{ name: 'team-lead' }] }, null, 2)}\n`;
}

async function writeTeams(): Promise<void> {
  for (const teamName of [OWN, OTHER_PROFILE, NATIVE_SESSION]) {
    await mkdir(path.dirname(configPath(teamName)), { recursive: true });
    await writeFile(configPath(teamName), foreignConfig(teamName));
  }
  await claimTeamForThisProfile({
    teamsBasePath: getTeamsBasePath(),
    teamName: OWN,
    reason: 'create',
  });
  await claimTeamForThisProfile({
    teamsBasePath: getTeamsBasePath(),
    teamName: OTHER_PROFILE,
    reason: 'launch',
    profileScope: buildOpenCodeAppProfileScope(
      path.join(root, 'user-data-b'),
      path.join(root, 'claude')
    ),
  });
}

async function createService(
  ownership?: ConstructorParameters<typeof TeamBackupService>[1],
  options: { workSyncRestore?: boolean } = {}
): Promise<TeamBackupService> {
  const service = new TeamBackupService(undefined, ownership);
  services.push(service);
  if (options.workSyncRestore) {
    // As in the app: startup restore of a live team defers its hole fill.
    service.configureWorkSyncRestore(new MemberWorkSyncTeamOperationGate(), {
      prepare: async () => ({ importAndVerify: async () => undefined }),
    });
  }
  await service.initialize();
  return service;
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false
  );
}

async function backupIdentityOf(teamName: string): Promise<unknown> {
  return (JSON.parse(await readFile(configPath(teamName), 'utf8')) as Record<string, unknown>)
    ._backupIdentityId;
}

describe('TeamBackupService and teams of other app profiles', () => {
  it('backs up only teams this profile manages, periodically and on file changes', async () => {
    await writeTeams();
    const service = await createService();

    await (service as unknown as { runPeriodicBackup(): Promise<void> }).runPeriodicBackup();
    // The file watcher asks for a backup of any team whose config changes.
    await service.backupTeam(OTHER_PROFILE);
    await service.backupTeam(NATIVE_SESSION);

    for (const teamName of [OTHER_PROFILE, NATIVE_SESSION]) {
      expect(await readFile(configPath(teamName), 'utf8')).toBe(foreignConfig(teamName));
      expect(await exists(backupDir(teamName))).toBe(false);
    }
    expect(await backupIdentityOf(OWN)).toEqual(expect.any(String));
    expect(await exists(path.join(backupDir(OWN), 'config.json'))).toBe(true);
  });

  it('leaves teams an older version registered alone in the quit-time backup', async () => {
    await writeTeams();
    // An older version backed up every team and registered it as active.
    const legacy = await createService({
      isManagedByThisProfile: async () => true,
      isManagedByThisProfileSync: () => true,
    });
    await (legacy as unknown as { runPeriodicBackup(): Promise<void> }).runPeriodicBackup();
    legacy.dispose();
    // Their owners have rewritten config.json since, dropping the identity marker.
    for (const teamName of [OWN, OTHER_PROFILE, NATIVE_SESSION]) {
      await writeFile(configPath(teamName), foreignConfig(teamName));
    }

    const service = await createService();
    service.runShutdownBackupSync();

    for (const teamName of [OTHER_PROFILE, NATIVE_SESSION]) {
      expect(await readFile(configPath(teamName), 'utf8')).toBe(foreignConfig(teamName));
    }
    expect(await backupIdentityOf(OWN)).toEqual(expect.any(String));
  });

  it.each([
    { workSyncRestore: false, label: 'legacy restore' },
    { workSyncRestore: true, label: 'deferred hole fill' },
  ])(
    'does not bring back files another profile deleted from its team ($label)',
    async ({ workSyncRestore }) => {
      await writeTeams();
      for (const teamName of [OWN, OTHER_PROFILE]) {
        await mkdir(inboxDir(teamName), { recursive: true });
        await writeFile(path.join(inboxDir(teamName), 'bob.json'), '[]\n');
      }
      // An older version backed up every team, the other profile's one included.
      const legacy = await createService({
        isManagedByThisProfile: async () => true,
        isManagedByThisProfileSync: () => true,
      });
      await (legacy as unknown as { runPeriodicBackup(): Promise<void> }).runPeriodicBackup();
      legacy.dispose();
      for (const teamName of [OWN, OTHER_PROFILE]) {
        await rm(path.join(inboxDir(teamName), 'bob.json'));
      }

      await createService(undefined, { workSyncRestore });

      // This profile's own team is still repaired from its backup.
      await vi.waitFor(async () => {
        expect(await exists(path.join(inboxDir(OWN), 'bob.json'))).toBe(true);
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await exists(path.join(inboxDir(OTHER_PROFILE), 'bob.json'))).toBe(false);
    }
  );

  it.each([
    { workSyncRestore: false, label: 'legacy restore' },
    { workSyncRestore: true, label: 'deferred hole fill' },
  ])(
    'finishes a restore of this profile interrupted before the owner marker ($label)',
    async ({ workSyncRestore }) => {
      await writeTeams();
      await mkdir(inboxDir(OWN), { recursive: true });
      await writeFile(path.join(inboxDir(OWN), 'bob.json'), '[]\n');
      const first = await createService();
      await first.backupTeam(OWN);
      first.dispose();
      // config.json is restored first; the app quit before the rest came back.
      const markerPath = path.join(getTeamsBasePath(), OWN, TEAM_PROFILE_OWNER_MARKER_FILE);
      await rm(markerPath);
      await rm(path.join(inboxDir(OWN), 'bob.json'));

      await createService(undefined, { workSyncRestore });

      await vi.waitFor(async () => {
        expect(await exists(markerPath)).toBe(true);
        expect(await exists(path.join(inboxDir(OWN), 'bob.json'))).toBe(true);
      });
    }
  );

  it('leaves a backed-up team alone once another profile has taken it over', async () => {
    await writeTeams();
    await mkdir(inboxDir(OWN), { recursive: true });
    await writeFile(path.join(inboxDir(OWN), 'bob.json'), '[]\n');
    const first = await createService();
    await first.backupTeam(OWN);
    first.dispose();
    const otherScope = buildOpenCodeAppProfileScope(
      path.join(root, 'user-data-b'),
      path.join(root, 'claude')
    );
    await claimTeamForThisProfile({
      teamsBasePath: getTeamsBasePath(),
      teamName: OWN,
      reason: 'launch',
      profileScope: otherScope,
    });
    await rm(path.join(inboxDir(OWN), 'bob.json'));

    await createService(undefined, { workSyncRestore: true });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await exists(path.join(inboxDir(OWN), 'bob.json'))).toBe(false);
    const marker = JSON.parse(
      await readFile(path.join(getTeamsBasePath(), OWN, TEAM_PROFILE_OWNER_MARKER_FILE), 'utf8')
    ) as { profileScope: string };
    expect(marker.profileScope).toBe(otherScope);
  });

  it('restores a team of this profile together with its owner marker', async () => {
    await writeTeams();
    const service = await createService();
    await service.backupTeam(OWN);
    await rm(path.dirname(configPath(OWN)), { recursive: true, force: true });

    expect(await service.restoreIfNeeded()).toContain(OWN);

    expect(await exists(path.join(getTeamsBasePath(), OWN, TEAM_PROFILE_OWNER_MARKER_FILE))).toBe(
      true
    );
    const ownership = createTeamProfileOwnership({ isTrackedInThisProcess: () => false });
    expect(await ownership.isManagedByThisProfile(OWN)).toBe(true);
    expect(ownership.isManagedByThisProfileSync(OWN)).toBe(true);
  });
});

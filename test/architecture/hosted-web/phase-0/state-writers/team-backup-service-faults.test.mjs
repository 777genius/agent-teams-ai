import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TeamBackupService } from '../../../../../src/main/services/team/TeamBackupService.ts';
import {
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../../../src/main/utils/pathDecoder.ts';

const MARKER_PREFIX = 'agent-teams-w3-team-backup-';

async function createMarkerFixture() {
  const root = await mkdtemp(join(tmpdir(), MARKER_PREFIX));
  const claudeRoot = join(root, 'provider-state');
  const appRoot = join(root, 'app-state');
  const paths = {
    root,
    claudeRoot,
    appRoot,
    teams: join(claudeRoot, 'teams'),
    tasks: join(claudeRoot, 'tasks'),
    backups: join(appRoot, 'backups'),
  };
  setClaudeBasePathOverride(claudeRoot);
  setAppDataBasePath(appRoot);
  await Promise.all([
    mkdir(paths.teams, { recursive: true }),
    mkdir(paths.tasks, { recursive: true }),
    mkdir(paths.backups, { recursive: true }),
  ]);
  return paths;
}

async function cleanupMarkerFixture(paths, services = []) {
  for (const service of services) service.dispose();
  setClaudeBasePathOverride(null);
  setAppDataBasePath(null);
  await rm(paths.root, { recursive: true, force: true });
}

async function writeTeam(paths, teamName, files = {}) {
  const teamDir = join(paths.teams, teamName);
  await mkdir(teamDir, { recursive: true });
  await writeFile(
    join(teamDir, 'config.json'),
    JSON.stringify({ name: teamName, projectPath: join(paths.root, 'project') }),
    'utf8'
  );
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = join(teamDir, relPath);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }
  return teamDir;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function manifestFor(teamName, identityId = `identity-${teamName}`) {
  return {
    teamName,
    identityId,
    status: 'active',
    firstBackupAt: '2026-07-11T00:00:00.000Z',
    lastBackupAt: '2026-07-11T00:00:00.000Z',
    fileStats: {},
  };
}

test('TB-01 characterizes config readiness, async/sync enumeration, and identity mutation', async () => {
  const paths = await createMarkerFixture();
  const service = new TeamBackupService();
  try {
    const teamName = 'enumeration-team';
    const teamDir = join(paths.teams, teamName);
    await mkdir(join(teamDir, 'inboxes'), { recursive: true });
    await mkdir(join(paths.tasks, teamName), { recursive: true });
    await writeFile(join(teamDir, 'config.json'), '{"notName":true}', 'utf8');
    await writeFile(join(teamDir, 'inboxes', 'worker.json'), '[]', 'utf8');
    await writeFile(join(paths.tasks, teamName, 'task-1.json'), '{"id":"task-1"}', 'utf8');

    await service.initialize();
    await service.backupTeam(teamName);
    assert.equal(existsSync(join(paths.backups, 'teams', teamName)), false);

    await writeFile(join(teamDir, 'config.json'), JSON.stringify({ name: teamName }), 'utf8');
    const asyncFiles = await service.enumerateTeamFilesWithErrors(teamName);
    const syncFiles = service.enumerateTeamFilesSync(teamName);
    assert.equal(asyncFiles.hasErrors, false);
    assert.deepEqual(
      asyncFiles.files.map(({ relPath }) => relPath).sort(),
      syncFiles.map(({ relPath }) => relPath).sort()
    );

    await service.backupTeam(teamName);
    const sourceConfig = await readJson(join(teamDir, 'config.json'));
    const manifest = await readJson(join(paths.backups, 'teams', teamName, 'manifest.json'));
    assert.equal(typeof sourceConfig._backupIdentityId, 'string');
    assert.equal(sourceConfig._backupIdentityId, manifest.identityId);
    assert.equal(
      existsSync(join(paths.backups, 'teams', teamName, 'inboxes', 'worker.json')),
      true
    );
    assert.equal(existsSync(join(paths.backups, 'teams', teamName, 'tasks', 'task-1.json')), true);
  } finally {
    await cleanupMarkerFixture(paths, [service]);
  }
});

test('TB-02/TB-03 characterize async copy failure and error-gated stale-file pruning', async () => {
  const paths = await createMarkerFixture();
  const service = new TeamBackupService();
  try {
    const teamName = 'async-fault-team';
    const teamDir = await writeTeam(paths, teamName);
    await service.initialize();
    await service.backupTeam(teamName);

    const backupDir = join(paths.backups, 'teams', teamName);
    const stalePath = join(backupDir, 'stale.json');
    await writeFile(stalePath, '{"stale":true}', 'utf8');
    const manifestPath = join(backupDir, 'manifest.json');
    const manifest = await readJson(manifestPath);
    manifest.fileStats['stale.json'] = { mtime: 1, size: 14 };
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    await writeFile(join(teamDir, 'team.meta.json'), '{"version":1}', 'utf8');

    const enumerate = service.enumerateTeamFilesWithErrors.bind(service);
    service.enumerateTeamFilesWithErrors = async (name) => {
      const result = await enumerate(name);
      return {
        files: [
          ...result.files,
          { sourcePath: join(paths.root, 'injected-unreadable.json'), relPath: 'injected.json' },
        ],
        hasErrors: true,
      };
    };
    await service.backupTeam(teamName);
    assert.equal(existsSync(stalePath), true, 'enumeration errors must suppress stale pruning');
    assert.equal(existsSync(join(backupDir, 'injected.json')), false, 'copy failure is swallowed');
    assert.equal(existsSync(join(backupDir, 'team.meta.json')), true, 'other files continue');
    assert.equal(
      existsSync(join(paths.backups, 'registry.json')),
      true,
      'publication still occurs'
    );

    service.enumerateTeamFilesWithErrors = enumerate;
    await writeFile(join(teamDir, 'team.meta.json'), '{"version":2}', 'utf8');
    await service.backupTeam(teamName);
    assert.equal(existsSync(stalePath), false, 'error-free enumeration permits stale pruning');
  } finally {
    await cleanupMarkerFixture(paths, [service]);
  }
});

test('TB-04/TB-05 expose non-atomic manifest and registry publication failures', async () => {
  const paths = await createMarkerFixture();
  const service = new TeamBackupService();
  try {
    await service.initialize();

    const manifestTeam = 'manifest-failure-team';
    await writeTeam(paths, manifestTeam);
    const saveManifest = service.saveManifest.bind(service);
    service.saveManifest = async () => {
      throw Object.assign(new Error('injected manifest publication failure'), { code: 'EIO' });
    };
    await assert.rejects(() => service.backupTeam(manifestTeam), /manifest publication failure/);
    const manifestBackupDir = join(paths.backups, 'teams', manifestTeam);
    assert.equal(
      existsSync(join(manifestBackupDir, 'config.json')),
      true,
      'file copy precedes manifest'
    );
    assert.equal(existsSync(join(manifestBackupDir, 'manifest.json')), false);
    assert.equal(service.registry.teams[manifestTeam], undefined);
    service.saveManifest = saveManifest;

    const registryTeam = 'registry-failure-team';
    await writeTeam(paths, registryTeam);
    const saveRegistry = service.saveRegistry.bind(service);
    service.saveRegistry = async () => {
      throw Object.assign(new Error('injected registry publication failure'), { code: 'EIO' });
    };
    await assert.rejects(() => service.backupTeam(registryTeam), /registry publication failure/);
    assert.equal(existsSync(join(paths.backups, 'teams', registryTeam, 'manifest.json')), true);
    assert.equal(
      existsSync(join(paths.backups, 'registry.json')),
      false,
      'manifest can publish alone'
    );
    assert.equal(service.registry.teams[registryTeam].teamName, registryTeam);
    service.saveRegistry = saveRegistry;
  } finally {
    await cleanupMarkerFixture(paths, [service]);
  }
});

test('TB-06/TB-07 characterize shutdown copy errors and swallowed manifest publication failure', async () => {
  const paths = await createMarkerFixture();
  const service = new TeamBackupService();
  try {
    const teamName = 'shutdown-fault-team';
    const teamDir = await writeTeam(paths, teamName);
    await service.initialize();
    await service.backupTeam(teamName);
    await writeFile(join(teamDir, 'sentMessages.json'), '[]', 'utf8');

    const enumerateSync = service.enumerateTeamFilesSync.bind(service);
    service.enumerateTeamFilesSync = (name) => [
      ...enumerateSync(name),
      { sourcePath: join(paths.root, 'injected-missing.bin'), relPath: 'injected-missing.bin' },
    ];
    service.runShutdownBackupSync();
    const backupDir = join(paths.backups, 'teams', teamName);
    assert.equal(existsSync(join(backupDir, 'sentMessages.json')), true);
    assert.equal(existsSync(join(backupDir, 'injected-missing.bin')), false);
    assert.equal(existsSync(join(paths.backups, 'registry.json')), true);

    await writeFile(join(teamDir, 'sentMessages.json'), '[{"second":true}]', 'utf8');
    service.saveManifestSync = () => {
      throw Object.assign(new Error('injected sync manifest publication failure'), { code: 'EIO' });
    };
    assert.doesNotThrow(() => service.runShutdownBackupSync());
    assert.equal(
      existsSync(join(paths.backups, 'registry.json')),
      true,
      'outer shutdown still saves registry'
    );
  } finally {
    await cleanupMarkerFixture(paths, [service]);
  }
});

test('TB-08/TB-09 rebuild a corrupt registry and restore a missing config from marker backups', async () => {
  const paths = await createMarkerFixture();
  const service = new TeamBackupService();
  try {
    const teamName = 'registry-rebuild-team';
    const identityId = 'identity-registry-rebuild';
    const backupDir = join(paths.backups, 'teams', teamName);
    await mkdir(backupDir, { recursive: true });
    await writeFile(
      join(backupDir, 'manifest.json'),
      JSON.stringify(manifestFor(teamName, identityId)),
      'utf8'
    );
    await writeFile(
      join(backupDir, 'config.json'),
      JSON.stringify({ name: teamName, _backupIdentityId: identityId }),
      'utf8'
    );
    await writeFile(join(backupDir, 'team.meta.json'), '{"restored":"missing-config"}', 'utf8');
    await writeFile(join(paths.backups, 'registry.json'), '{corrupt', 'utf8');

    await service.initialize();
    assert.equal(service.registry.teams[teamName].identityId, identityId);
    assert.equal(existsSync(join(paths.teams, teamName, 'config.json')), true);
    assert.deepEqual(await readJson(join(paths.teams, teamName, 'team.meta.json')), {
      restored: 'missing-config',
    });
  } finally {
    await cleanupMarkerFixture(paths, [service]);
  }
});

test('TB-10/TB-11 characterize corrupt-config full restore, mtime protection, and partial restore', async () => {
  const paths = await createMarkerFixture();
  const service = new TeamBackupService();
  try {
    const teamName = 'restore-fault-team';
    const identityId = 'identity-restore-fault';
    const teamDir = join(paths.teams, teamName);
    const backupDir = join(paths.backups, 'teams', teamName);
    await Promise.all([mkdir(teamDir, { recursive: true }), mkdir(backupDir, { recursive: true })]);
    await writeFile(
      join(backupDir, 'manifest.json'),
      JSON.stringify(manifestFor(teamName, identityId))
    );
    await writeFile(
      join(backupDir, 'config.json'),
      JSON.stringify({ name: teamName, _backupIdentityId: identityId })
    );
    await writeFile(join(backupDir, 'team.meta.json'), '{"from":"backup-old"}');
    await writeFile(join(backupDir, 'launch-state.json'), '{"from":"backup-new"}');
    await writeFile(join(backupDir, 'sentMessages.json'), '[{"from":"backup"}]');
    await writeFile(
      join(paths.backups, 'registry.json'),
      JSON.stringify({
        version: 1,
        teams: {
          [teamName]: {
            teamName,
            identityId,
            status: 'active',
            lastBackupAt: '2026-07-11T00:00:00.000Z',
          },
        },
      })
    );
    await writeFile(join(teamDir, 'config.json'), '{corrupt');
    await writeFile(join(teamDir, 'team.meta.json'), '{"from":"source-newer"}');
    await writeFile(join(teamDir, 'launch-state.json'), '{"from":"source-older"}');
    const oldTime = new Date('2026-07-10T00:00:00.000Z');
    const newTime = new Date('2026-07-12T00:00:00.000Z');
    await utimes(join(backupDir, 'team.meta.json'), oldTime, oldTime);
    await utimes(join(teamDir, 'team.meta.json'), newTime, newTime);
    await utimes(join(teamDir, 'launch-state.json'), oldTime, oldTime);
    await utimes(join(backupDir, 'launch-state.json'), newTime, newTime);

    await service.initialize();
    assert.equal((await readJson(join(teamDir, 'config.json')))._backupIdentityId, identityId);
    assert.deepEqual(await readJson(join(teamDir, 'team.meta.json')), { from: 'source-newer' });
    assert.deepEqual(await readJson(join(teamDir, 'launch-state.json')), { from: 'backup-new' });

    await writeFile(
      join(teamDir, 'config.json'),
      JSON.stringify({ name: teamName, _backupIdentityId: identityId })
    );
    await writeFile(join(teamDir, 'team.meta.json'), '{"from":"valid-source"}');
    await writeFile(join(teamDir, 'launch-state.json'), '{corrupt');
    await rm(join(teamDir, 'sentMessages.json'), { force: true });
    const restored = await service.restoreIfNeeded();
    assert.deepEqual(restored, [teamName]);
    assert.deepEqual(await readJson(join(teamDir, 'team.meta.json')), { from: 'valid-source' });
    assert.deepEqual(await readJson(join(teamDir, 'launch-state.json')), { from: 'backup-new' });
    assert.deepEqual(await readJson(join(teamDir, 'sentMessages.json')), [{ from: 'backup' }]);
  } finally {
    await cleanupMarkerFixture(paths, [service]);
  }
});

test('TB-12 characterizes retention prune and registry publication', async () => {
  const paths = await createMarkerFixture();
  const service = new TeamBackupService();
  try {
    await service.initialize();
    const oldTeam = 'old-deleted-team';
    const recentTeam = 'recent-deleted-team';
    await Promise.all([
      mkdir(join(paths.backups, 'teams', oldTeam), { recursive: true }),
      mkdir(join(paths.backups, 'teams', recentTeam), { recursive: true }),
    ]);
    service.registry.teams = {
      [oldTeam]: {
        teamName: oldTeam,
        identityId: 'identity-old',
        status: 'deleted_by_user',
        deletedByUserAt: '2020-01-01T00:00:00.000Z',
        lastBackupAt: '2020-01-01T00:00:00.000Z',
      },
      [recentTeam]: {
        teamName: recentTeam,
        identityId: 'identity-recent',
        status: 'deleted_by_user',
        deletedByUserAt: new Date().toISOString(),
        lastBackupAt: new Date().toISOString(),
      },
    };

    await service.pruneStaleBackups();
    assert.equal(existsSync(join(paths.backups, 'teams', oldTeam)), false);
    assert.equal(existsSync(join(paths.backups, 'teams', recentTeam)), true);
    const registry = await readJson(join(paths.backups, 'registry.json'));
    assert.equal(registry.teams[oldTeam], undefined);
    assert.equal(registry.teams[recentTeam].status, 'deleted_by_user');
    assert.equal(
      (await stat(paths.root)).isDirectory(),
      true,
      'fixture remains marker-owned until cleanup'
    );
  } finally {
    await cleanupMarkerFixture(paths, [service]);
  }
});

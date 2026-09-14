// Real filesystem stores and fake runtime; run with the repository Vitest configuration.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { withFileLock } from '../../../../src/main/services/team/fileLock';
import {
  clearOpenCodeRuntimeLaneStorage,
  getOpenCodeRuntimeManifestPath,
  setOpenCodeRuntimeActiveRunManifest,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { readCommittedOpenCodeBootstrapSessionEvidence } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { readOpenCodeStopSessionIdentity } from '../../../../src/main/services/team/opencode/store/OpenCodeStopSessionIdentity';
import { applyOpenCodeSecondaryEvidenceOverlay } from '../../../../src/main/services/team/provisioning/TeamProvisioningLaunchStateReconciliation';
import { TeamProvisioningLaunchStateStoreBoundary } from '../../../../src/main/services/team/provisioning/TeamProvisioningLaunchStateStoreBoundary';
import {
  commitOpenCodeRuntimeBootstrapSessionEvidence,
  createDefaultOpenCodeRuntimeBootstrapEvidencePorts,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningOpenCodeBootstrapEvidence';
import { TeamBackupRestoreService } from '../../../../src/main/services/team/TeamBackupRestoreService';
import { createPersistedLaunchSnapshot } from '../../../../src/main/services/team/TeamLaunchStateEvaluator';
import {
  TeamLaunchStateStore,
  withTeamLaunchStatePublicationLock,
} from '../../../../src/main/services/team/TeamLaunchStateStore';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

let temp: string;
let teamDir: string;
const team = 'recovery-fixture';
const at = '2026-09-09T00:00:00.000Z';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function missing(file: string) {
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
}
function snapshot(runId = 'new-run', phase: 'active' | 'finished' = 'finished') {
  return createPersistedLaunchSnapshot({
    teamName: team,
    expectedMembers: ['alice'],
    launchPhase: phase,
    members: {
      alice: {
        name: 'alice',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        runtimeRunId: runId,
        runtimeSessionId: 'session-a',
        lastEvaluatedAt: at,
      },
    },
  });
}
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-launch-recovery-'));
  setClaudeBasePathOverride(path.join(temp, 'claude'));
  teamDir = path.join(getTeamsBasePath(), team);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    JSON.stringify({ name: team, _backupIdentityId: 'identity-1' })
  );
});
afterEach(async () => {
  setClaudeBasePathOverride(null);
  await fs.rm(temp, { recursive: true, force: true });
});

test('seeded Stop -> authorized begin -> first finished result persists actual state and summary', async () => {
  const store = new TeamLaunchStateStore();
  await store.markStopped(team);
  assert.equal(await store.write(team, snapshot()), false);
  assert.equal(await store.beginLaunch(team, 'new-run', ['alice'], () => true), true);
  assert.equal(
    await store.write(team, snapshot(), { runId: 'new-run', isAuthorized: () => true }),
    true
  );
  const persisted = await store.read(team);
  assert.ok(persisted);
  assert.equal(persisted.members.alice.bootstrapConfirmed, true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(teamDir, 'launch-summary.json'), 'utf8'))
      .publicationRunId,
    'new-run'
  );
  await missing(path.join(teamDir, 'launch-stopped.json'));
});

test('Stop requested while begin waits inside publication queue wins over new launch and late snapshots', async () => {
  const store = new TeamLaunchStateStore();
  await store.markStopped(team);
  const entered = deferred();
  const release = deferred();
  const held = withTeamLaunchStatePublicationLock(team, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const begin = store.beginLaunch(team, 'new-run', ['alice'], () => true);
  const stop = store.markStopped(team);
  release.resolve();
  await held;
  assert.equal(await begin, false);
  await stop;
  assert.equal(await store.isStopped(team), true);
  assert.equal(await store.write(team, snapshot('new-run', 'active')), false);
  assert.equal(await store.write(team, snapshot()), false);
  await missing(path.join(teamDir, 'launch-state.json'));
});

test('current-run callback is checked inside queue; successor publication survives stale clear', async () => {
  const store = new TeamLaunchStateStore();
  await store.beginLaunch(team, 'first', ['alice'], () => true);
  const gate = deferred();
  const entered = deferred();
  const held = withTeamLaunchStatePublicationLock(team, async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  let current = 'first';
  const old = store.write(team, snapshot('first'), {
    runId: 'first',
    isAuthorized: () => current === 'first',
  });
  const clear = store.clear(team, () => current === 'first');
  current = 'successor';
  const successor = store.beginLaunch(team, 'successor', ['alice'], () => current === 'successor');
  gate.resolve();
  await held;
  assert.equal(await old, false);
  await clear;
  assert.equal(await successor, true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(teamDir, 'launch-state.json'), 'utf8')).publicationRunId,
    'successor'
  );
});

async function backupFixture() {
  const backup = path.join(temp, 'backup');
  await fs.mkdir(backup);
  await fs.copyFile(path.join(teamDir, 'config.json'), path.join(backup, 'config.json'));
  await fs.copyFile(
    path.join(teamDir, 'launch-stopped.json'),
    path.join(backup, 'launch-stopped.json')
  );
  return {
    backup,
    restore: new TeamBackupRestoreService({
      loadManifest: async () => ({
        teamName: team,
        identityId: 'identity-1',
        status: 'active',
        firstBackupAt: at,
        lastBackupAt: at,
        fileStats: {},
      }),
      getBackupDir: () => backup,
      enumerateBackupFiles: async () => ['config.json', 'launch-stopped.json'],
      getSourcePathForRelPath: (_, rel) => path.join(teamDir, rel),
    }),
  };
}
for (const full of [false, true])
  test(`old backup marker cannot commit over launch (${full ? 'full' : 'partial'} restore)`, async () => {
    const store = new TeamLaunchStateStore();
    await store.markStopped(team);
    const f = await backupFixture();
    await fs.rm(path.join(teamDir, 'launch-stopped.json'));
    if (full) await fs.rm(path.join(teamDir, 'config.json'));
    const observed = deferred();
    const release = deferred();
    const readFile = fs.readFile;
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const result = await readFile(...args);
      if (args[0] === path.join(f.backup, 'launch-stopped.json')) {
        observed.resolve();
        await release.promise;
      }
      return result;
    });
    try {
      const restoring = f.restore.restoreTeam(team);
      await observed.promise;
      assert.equal(await store.beginLaunch(team, 'new-run', ['alice'], () => true), true);
      release.resolve();
      await restoring;
      await missing(path.join(teamDir, 'launch-stopped.json'));
      assert.equal(await store.isStopped(team), false);
    } finally {
      release.resolve();
      readSpy.mockRestore();
    }
  });

test('matching backed-up Stop restores after marker loss; changed backup identity refuses restore', async () => {
  const store = new TeamLaunchStateStore();
  await store.markStopped(team);
  const f = await backupFixture();
  const original = await fs.readFile(path.join(teamDir, 'launch-stopped.json'), 'utf8');
  await fs.rm(path.join(teamDir, 'launch-stopped.json'));
  assert.equal(await f.restore.restoreTeam(team), true);
  assert.equal(await fs.readFile(path.join(teamDir, 'launch-stopped.json'), 'utf8'), original);
  await fs.rm(path.join(teamDir, 'launch-stopped.json'));
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    JSON.stringify({ name: team, _backupIdentityId: 'successor' })
  );
  assert.equal(await f.restore.restoreTeam(team), false);
  await missing(path.join(teamDir, 'launch-stopped.json'));
});

test('actual lane cleanup rejects successor run and same-run session replacement, preserving other lanes', async () => {
  const scope = {
    teamsBasePath: getTeamsBasePath(),
    teamName: team,
    laneId: 'primary',
    runId: 'old-run',
  };
  await setOpenCodeRuntimeActiveRunManifest(scope);
  const otherScope = { ...scope, laneId: 'secondary:opencode:bob', runId: 'other-run' };
  await setOpenCodeRuntimeActiveRunManifest(otherScope);
  const otherManifestPath = getOpenCodeRuntimeManifestPath(
    scope.teamsBasePath,
    team,
    otherScope.laneId
  );
  const otherManifest = await fs.readFile(otherManifestPath, 'utf8');
  const manifestPath = getOpenCodeRuntimeManifestPath(scope.teamsBasePath, team, 'primary');
  const sessionPath = path.join(path.dirname(manifestPath), 'opencode-sessions.json');
  const sessions = (id: string) =>
    JSON.stringify({
      sessions: [{ id, teamName: team, memberName: 'alice', laneId: 'primary', runId: 'old-run' }],
    });
  await fs.writeFile(sessionPath, sessions('old-session'));
  const identity = await readOpenCodeStopSessionIdentity(manifestPath);
  await fs.writeFile(sessionPath, sessions('successor-session'));
  assert.equal(
    await clearOpenCodeRuntimeLaneStorage({
      ...scope,
      expectedRunId: 'old-run',
      expectedSessionIdentityHash: identity,
    }),
    false
  );
  assert.match(await fs.readFile(sessionPath, 'utf8'), /successor-session/);
  await setOpenCodeRuntimeActiveRunManifest({ ...scope, runId: 'new-run' });
  assert.equal(
    await clearOpenCodeRuntimeLaneStorage({ ...scope, expectedRunId: 'old-run' }),
    false
  );
  await fs.access(manifestPath);
  assert.equal(await fs.readFile(otherManifestPath, 'utf8'), otherManifest);
});

test('boundary reports suppression truthfully through actual store', async () => {
  const store = new TeamLaunchStateStore();
  await store.markStopped(team);
  const boundary = new TeamProvisioningLaunchStateStoreBoundary({
    launchStateStore: store,
    getTrackedRunId: () => 'new-run',
    membersMetaStore: { getMembers: async () => [] },
    applyOpenCodeSecondaryEvidenceOverlay: async ({ snapshot }) => snapshot,
    applyBootstrapStallOverlay: () => null,
    areSnapshotsSemanticallyEqual: () => false,
    clearBootstrapState: async () => {},
    invalidateRuntimeSnapshotCaches() {},
    logDebug() {},
    nowMs: () => Date.now(),
  });
  assert.equal(
    (
      await boundary.writeLaunchStateSnapshotNow(team, snapshot(), {
        runId: 'new-run',
        requireTrackedRun: true,
      })
    ).wrote,
    false
  );
  await store.beginLaunch(team, 'new-run', ['alice'], () => true);
  assert.equal(
    (
      await boundary.writeLaunchStateSnapshotNow(team, snapshot(), {
        runId: 'new-run',
        requireTrackedRun: true,
      })
    ).wrote,
    true
  );
});

for (const mismatch of ['none', 'run', 'session', 'tombstone'] as const)
  test(`committed ready evidence and actual publication: ${mismatch}`, async () => {
    const store = new TeamLaunchStateStore();
    await store.markStopped(team);
    await store.beginLaunch(team, 'new-run', ['alice'], () => true);
    const laneId = 'secondary:opencode:alice';
    const scope = { teamsBasePath: getTeamsBasePath(), teamName: team, laneId };
    await setOpenCodeRuntimeActiveRunManifest({ ...scope, runId: 'new-run' });
    await commitOpenCodeRuntimeBootstrapSessionEvidence(
      {
        teamName: team,
        laneId,
        runId: 'new-run',
        memberName: 'alice',
        runtimeSessionId: 'session-a',
        observedAt: at,
      },
      createDefaultOpenCodeRuntimeBootstrapEvidencePorts({ teamsBasePath: getTeamsBasePath() })
    );
    const pending = snapshot();
    Object.assign(pending.members.alice, {
      providerId: 'opencode',
      laneId,
      laneKind: 'secondary',
      laneOwnerProviderId: 'opencode',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      runtimeRunId: mismatch === 'run' ? 'different-run' : 'new-run',
      runtimeSessionId: mismatch === 'session' ? 'different-session' : 'session-a',
    });
    const published = await applyOpenCodeSecondaryEvidenceOverlay(
      { teamName: team, snapshot: pending },
      {
        readLaneIndex: async () => ({
          lanes: { [laneId]: { laneId, state: 'active', updatedAt: at } },
        }),
        readCommittedBootstrapSessionEvidence: () =>
          readCommittedOpenCodeBootstrapSessionEvidence(scope),
        hasBootstrapCheckinTombstone: async () => mismatch === 'tombstone',
        nowIso: () => at,
      }
    );
    assert.equal(
      await store.write(team, published, { runId: 'new-run', isAuthorized: () => true }),
      true
    );
    assert.equal((await store.read(team))?.members.alice.bootstrapConfirmed, mismatch === 'none');
    if (mismatch === 'none') assert.equal((await store.read(team))?.summary.confirmedCount, 1);
  });

test('untracked active publication cannot authorize a new run over Stop', async () => {
  const store = new TeamLaunchStateStore();
  await store.markStopped(team);
  assert.equal(
    await store.write(team, snapshot('late-run', 'active'), {
      runId: 'late-run',
      isAuthorized: () => true,
    }),
    false
  );
  assert.equal(await store.isStopped(team), true);
});

test('failed marker retirement rolls publication back and keeps Stop recoverable', async () => {
  const store = new TeamLaunchStateStore();
  await store.markStopped(team);
  const rm = fs.rm;
  const failure = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
    if (file === path.join(teamDir, 'launch-stopped.json')) throw new Error('marker is busy');
    return rm(file, options);
  });
  try {
    await assert.rejects(
      store.beginLaunch(team, 'new-run', ['alice'], () => true),
      /marker is busy/
    );
    assert.deepEqual(
      vi.mocked(console.warn).mock.calls.map((args) => args.join(' ')),
      [
        '[Service:TeamLaunchStateStore] [recovery-fixture] Failed to persist launch-state: marker is busy',
      ]
    );
    vi.mocked(console.warn).mockClear();
  } finally {
    failure.mockRestore();
  }
  assert.equal(await store.isStopped(team), true);
  await missing(path.join(teamDir, 'launch-state.json'));
});

test('a replacement team directory survives publication rollback when Windows reports zero inodes', async () => {
  const store = new TeamLaunchStateStore();
  await store.markStopped(team);
  const stat = fs.stat;
  const rename = fs.rename;
  let directoryGeneration = 1;
  let replaced = false;
  const successorState = JSON.stringify({ successor: true });
  const statMock = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
    const observed = await stat(...args);
    if (args[0] === teamDir) {
      // Some filesystems do not expose usable inode numbers. The established
      // durable-path comparator uses birthtime as the identity fallback.
      Object.defineProperties(observed, {
        ino: { value: 0 },
        birthtimeMs: { value: directoryGeneration },
      });
    }
    return observed;
  });
  const renameMock = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    if (!replaced && to === path.join(teamDir, 'launch-state.json')) {
      replaced = true;
      await rename(teamDir, path.join(temp, 'retired-team'));
      await fs.mkdir(teamDir);
      await fs.writeFile(path.join(teamDir, 'launch-state.json'), successorState);
      directoryGeneration = 2;
    }
  });
  try {
    assert.equal(await store.beginLaunch(team, 'new-run', ['alice'], () => true), false);
    assert.equal(
      await fs.readFile(path.join(teamDir, 'launch-state.json'), 'utf8'),
      successorState
    );
    await missing(path.join(teamDir, 'launch-stopped.json'));
    await missing(path.join(teamDir, 'launch-freshness.json'));
  } finally {
    renameMock.mockRestore();
    statMock.mockRestore();
  }
});

test('aged cleanup owner keeps the lifecycle lock after CAS until successor publication can safely proceed', async () => {
  const scope = {
    teamsBasePath: getTeamsBasePath(),
    teamName: team,
    laneId: 'primary',
    runId: 'old-run',
  };
  await setOpenCodeRuntimeActiveRunManifest(scope);
  const manifestPath = getOpenCodeRuntimeManifestPath(scope.teamsBasePath, team, scope.laneId);
  const laneDirectory = path.dirname(manifestPath);
  const lockPath = path.join(path.dirname(laneDirectory), '.primary.lifecycle.lock');
  const identity = await readOpenCodeStopSessionIdentity(manifestPath);
  const entered = deferred();
  const release = deferred();
  // Hold the existing nested journal lock. Cleanup reaches this only AFTER the
  // lifecycle run/session CAS, while retaining the outer lifecycle acquisition.
  const journalOwner = withFileLock(
    path.join(laneDirectory, 'opencode-delivery-journal.json'),
    async () => release.promise
  );
  const realKill = process.kill;
  const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
    ...args: Parameters<typeof process.kill>
  ) => {
    entered.resolve();
    return realKill(...args);
  }) as typeof process.kill);
  let cleanup: Promise<boolean> | undefined;
  let successor: Promise<void> | undefined;
  try {
    cleanup = clearOpenCodeRuntimeLaneStorage({
      ...scope,
      expectedRunId: 'old-run',
      expectedSessionIdentityHash: identity,
    });
    await Promise.race([
      entered.promise,
      cleanup.then(() => {
        throw new Error('cleanup did not wait at the journal barrier');
      }),
    ]);
    const lock = await fs.readFile(lockPath, 'utf8');
    const aged = lock.replace(lock.split('\n')[1], String(Date.now() - 60_000));
    await fs.writeFile(lockPath, aged);
    killSpy.mockClear();
    successor = setOpenCodeRuntimeActiveRunManifest({ ...scope, runId: 'successor-run' });
    // The successor's first acquisition attempt runs synchronously before its wait.
    assert.ok(killSpy.mock.calls.length > 0);
    assert.equal(await fs.readFile(lockPath, 'utf8'), aged);
    release.resolve();
    await journalOwner;
    assert.equal(await cleanup, true);
    await successor;
    const envelope = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.equal((envelope.data ?? envelope).activeRunId, 'successor-run');
  } finally {
    release.resolve();
    await Promise.allSettled([journalOwner, cleanup, successor].filter(Boolean));
    killSpy.mockRestore();
  }
});

test('recreated app stores reject the old backup marker, persist first finished launch, and fence late heartbeat after a new Stop', async () => {
  const initial = new TeamLaunchStateStore();
  await initial.markStopped(team);
  const backup = await backupFixture();
  await initial.beginLaunch(team, 'successor', ['alice'], () => true);
  assert.equal(
    await initial.write(team, snapshot('successor'), {
      runId: 'successor',
      isAuthorized: () => true,
    }),
    true
  );
  const reopened = new TeamLaunchStateStore();
  await backup.restore.restoreTeam(team);
  await missing(path.join(teamDir, 'launch-stopped.json'));
  assert.equal((await reopened.read(team))?.publicationRunId, 'successor');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(teamDir, 'launch-summary.json'), 'utf8'))
      .publicationRunId,
    'successor'
  );
  assert.equal(
    await initial.write(team, snapshot('old-run', 'active'), {
      runId: 'old-run',
      isAuthorized: () => true,
    }),
    false
  );
  assert.equal((await reopened.read(team))?.publicationRunId, 'successor');
  await reopened.markStopped(team);
  const newMarker = await fs.readFile(path.join(teamDir, 'launch-stopped.json'), 'utf8');
  assert.equal(
    await initial.write(team, snapshot('successor', 'active'), {
      runId: 'successor',
      isAuthorized: () => true,
    }),
    false
  );
  await fs.rm(path.join(teamDir, 'launch-stopped.json'));
  await backup.restore.restoreTeam(team);
  await missing(path.join(teamDir, 'launch-stopped.json'));
  assert.equal(await reopened.isStopped(team), true); // Durable freshness still carries the newer Stop.
  assert.notEqual(
    newMarker,
    await fs.readFile(path.join(backup.backup, 'launch-stopped.json'), 'utf8')
  );
});

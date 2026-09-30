#!/usr/bin/env node

import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import {
  createStoppedStackArchive,
  restoreStoppedStackArchive,
  verifyStoppedStackArchive,
} from './stopped-stack-recovery.mjs';

export async function runProductionShapeRecoveryDrill() {
  const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-drill-'));
  const sourceRoot = join(root, 'source', '.agent-teams');
  const archiveRoot = join(root, 'recovery', 'app-volume-archive');
  const targetRoot = join(root, 'target', '.agent-teams');
  const fixtureLockRoots = [join(sourceRoot, 'instance-lock'), join(targetRoot, 'instance-lock')];
  try {
    await mkdir(join(sourceRoot, 'data', 'storage'), { recursive: true, mode: 0o700 });
    await mkdir(fixtureLockRoots[0], { mode: 0o755 });
    await writeFile(join(fixtureLockRoots[0], 'instance.lock'), '', { mode: 0o644 });
    await chmod(join(fixtureLockRoots[0], 'instance.lock'), 0o444);
    await chmod(fixtureLockRoots[0], 0o555);
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      `${JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_drill',
        hostedStateSchemaVersion: 1,
      })}\n`,
      { mode: 0o600 }
    );
    createDrillDatabase(join(sourceRoot, 'data', 'storage', 'app.db'));
    await mkdir(fixtureLockRoots[1], { recursive: true, mode: 0o755 });
    await writeFile(join(fixtureLockRoots[1], 'instance.lock'), '', { mode: 0o644 });
    await chmod(join(fixtureLockRoots[1], 'instance.lock'), 0o444);
    await chmod(fixtureLockRoots[1], 0o555);

    const backup = await createStoppedStackArchive({ sourceRoot, archiveRoot });
    const verification = await verifyStoppedStackArchive({ archiveRoot });
    const restored = await restoreStoppedStackArchive({
      archiveRoot,
      targetRoot,
      restoreGeneration: 1,
      random: (bytes) => Buffer.alloc(bytes, 7).toString('base64url'),
    });
    return Object.freeze({
      format: 'hosted-production-shape-recovery-drill/v1',
      status: 'passed',
      backup,
      verification,
      restored: {
        status: restored.status,
        manifestHash: restored.manifestHash,
        browserAuthorityRotated: restored.rotation.browserAuthorityRotated,
        runtimeAuthorityRotationRequired: restored.rotation.runtimeAuthorityRotationRequired,
        freshMountBindingsRequired: restored.rotation.freshMountBindingsRequired,
      },
    });
  } finally {
    try {
      await restoreFixtureOwnedPermissions(fixtureLockRoots);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function restoreFixtureOwnedPermissions(lockRoots) {
  let firstError;
  for (const lockRoot of lockRoots) {
    for (const [path, mode] of [
      [lockRoot, 0o755],
      [join(lockRoot, 'instance.lock'), 0o644],
    ]) {
      try {
        await chmod(path, mode);
      } catch (error) {
        if (error?.code !== 'ENOENT' && firstError === undefined) {
          firstError = error;
        }
      }
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

function createDrillDatabase(path) {
  const database = new Database(path);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE hosted_access_authority (
        singleton INTEGER PRIMARY KEY,
        state_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        rollback_fence_revision INTEGER NOT NULL
      );
      CREATE TABLE operator_sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        revoked_at INTEGER,
        revocation_reason TEXT
      );
      CREATE TABLE oidc_login_attempts (attempt_id TEXT PRIMARY KEY);
      CREATE TABLE oidc_logout_replay (jti TEXT PRIMARY KEY);
      CREATE TABLE coordination_event_journal_metadata (
        deployment_id TEXT PRIMARY KEY,
        event_epoch TEXT NOT NULL,
        UNIQUE (deployment_id, event_epoch)
      );
      CREATE TABLE coordination_event_journal (
        deployment_id TEXT NOT NULL,
        event_epoch TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        PRIMARY KEY (deployment_id, event_epoch, event_sequence),
        FOREIGN KEY (deployment_id, event_epoch)
          REFERENCES coordination_event_journal_metadata(deployment_id, event_epoch)
          ON UPDATE RESTRICT
      );
    `);
    const state = {
      schemaVersion: 1,
      revision: 2,
      binding: { deploymentId: 'deployment_drill', restoreGeneration: 0 },
      expectedKeyringId: 'akr_xoriginal00',
      consumedResetGeneration: 0,
      operatorId: 'opr_xoperator00',
      pairingChallenges: [],
      deviceFamilies: [{ retained: false }],
      deviceGrants: [{ retained: false }],
      sessions: [{ retained: false }],
      resetIntent: null,
    };
    database
      .prepare('INSERT INTO hosted_access_authority VALUES (1, ?, 2, 2)')
      .run(JSON.stringify(state));
    database
      .prepare("INSERT INTO operator_sessions VALUES ('session', 'active', NULL, NULL)")
      .run();
    database
      .prepare(
        "INSERT INTO coordination_event_journal_metadata VALUES ('deployment_drill', 'epoch_old')"
      )
      .run();
    database
      .prepare("INSERT INTO coordination_event_journal VALUES ('deployment_drill', 'epoch_old', 1)")
      .run();
  } finally {
    database.close();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.stdout.write(`${JSON.stringify(await runProductionShapeRecoveryDrill())}\n`);
}

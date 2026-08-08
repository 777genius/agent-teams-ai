import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createStoppedStackArchive,
  restoreStoppedStackArchive,
  verifyStoppedStackArchive,
} from '../../../scripts/hosted-web/phase-10/state-compatibility/stopped-stack-recovery.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('stopped-stack recovery', () => {
  it('refuses direct execution without the stopped-stack instance lease', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/hosted-web/phase-10/state-compatibility/stopped-stack-recovery.mjs', 'verify'],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('hosted_recovery_refused:stopped_stack_instance_lease_required\n');
  });

  it('runs the production-shape recovery drill and removes its hardened fixture', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'hosted-recovery-drill-test-'));
    roots.push(fixtureRoot);
    const result = spawnSync(
      process.execPath,
      ['scripts/hosted-web/phase-10/state-compatibility/recovery-drill.mjs'],
      {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: fixtureRoot, TEMP: fixtureRoot, TMP: fixtureRoot },
      }
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      format: 'hosted-production-shape-recovery-drill/v1',
      status: 'passed',
      restored: {
        status: 'restored',
        browserAuthorityRotated: true,
        runtimeAuthorityRotationRequired: true,
        freshMountBindingsRequired: true,
      },
    });
    await expect(readdir(fixtureRoot)).resolves.toEqual([]);
  });

  it('leaves interrupted targets fail closed and never merges into them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-refusal-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    const targetRoot = join(root, 'target');
    await mkdir(join(sourceRoot, 'data'), { recursive: true });
    await mkdir(targetRoot);
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );
    await createStoppedStackArchive({ sourceRoot, archiveRoot });
    await writeFile(join(targetRoot, 'interrupted-copy'), 'partial');

    await expect(
      restoreStoppedStackArchive({ archiveRoot, targetRoot, restoreGeneration: 1 })
    ).rejects.toThrow('stopped_stack_restore_target_not_empty');
    await expect(readFile(join(targetRoot, 'interrupted-copy'), 'utf8')).resolves.toBe('partial');
  });

  it('refuses a corrupt committed archive before writing the empty target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-corrupt-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    const targetRoot = join(root, 'target');
    await mkdir(join(sourceRoot, 'data'), { recursive: true });
    await mkdir(targetRoot);
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );
    await createStoppedStackArchive({ sourceRoot, archiveRoot });
    await writeFile(join(archiveRoot, 'payload', 'data', 'hosted-state-header.v1.json'), 'corrupt');

    await expect(
      restoreStoppedStackArchive({ archiveRoot, targetRoot, restoreGeneration: 1 })
    ).rejects.toThrow('stopped_stack_archive_checksum_mismatch');
    await expect(readdir(targetRoot)).resolves.toEqual([]);
  });

  it('refuses a symlink swap after verification and before descriptor-bound copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-swap-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    const targetRoot = join(root, 'target');
    await mkdir(join(sourceRoot, 'data'), { recursive: true });
    await mkdir(targetRoot);
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );
    await createStoppedStackArchive({ sourceRoot, archiveRoot });
    const payload = join(archiveRoot, 'payload', 'data', 'hosted-state-header.v1.json');
    const moved = `${payload}.swapped`;

    await expect(
      restoreStoppedStackArchive({
        archiveRoot,
        targetRoot,
        restoreGeneration: 1,
        async onRestoreStage(stage: string) {
          if (stage === 'archive_verified') {
            await rename(payload, moved);
            await symlink(moved, payload);
          }
        },
      })
    ).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(
      readFile(join(targetRoot, 'data', 'hosted-state-header.v1.json'))
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a checksum-valid cross-snapshot archive before writing the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-cross-snapshot-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    const targetRoot = join(root, 'target');
    await mkdir(join(sourceRoot, 'data'), { recursive: true });
    await mkdir(targetRoot);
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );
    await createStoppedStackArchive({ sourceRoot, archiveRoot });
    const manifestPath = join(archiveRoot, 'manifest.json');
    const manifestBody = await readFile(manifestPath, 'utf8');
    const crossSnapshotBody = manifestBody.replace('"deployment_fixture"', '"deployment_other"');
    const manifestHash = createHash('sha256').update(crossSnapshotBody).digest('hex');
    await overwriteHardenedArchiveFile(manifestPath, crossSnapshotBody);
    await overwriteHardenedArchiveFile(
      join(archiveRoot, 'READY.json'),
      JSON.stringify({
        format: 'hosted-stopped-stack-ready/v1',
        manifestHash,
        schemaVersion: 1,
      })
    );

    await expect(
      restoreStoppedStackArchive({ archiveRoot, targetRoot, restoreGeneration: 1 })
    ).rejects.toThrow('stopped_stack_archive_state_identity_mismatch');
    await expect(readdir(targetRoot)).resolves.toEqual([]);
  });

  it('recovers an interrupted journal publication without treating the target as user state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-journal-staging-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    const targetRoot = join(root, 'target');
    await mkdir(join(sourceRoot, 'data'), { recursive: true });
    await mkdir(join(targetRoot, 'data'), { recursive: true });
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );
    await writeFile(
      join(targetRoot, 'data', 'hosted-restore-journal.v1.json.staging'),
      '{interrupted'
    );
    await createStoppedStackArchive({ sourceRoot, archiveRoot });

    await expect(
      restoreStoppedStackArchive({
        archiveRoot,
        targetRoot,
        restoreGeneration: 1,
        openDatabase: createEmptyDatabaseAdapter,
      })
    ).resolves.toMatchObject({ status: 'restored' });
    await expect(
      readFile(join(targetRoot, 'data', 'hosted-restore-journal.v1.json'), 'utf8')
    ).resolves.toContain('"phase":"completed"');
  });

  it('excludes recovery controls across repeated generations and resumes after payload copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-repeat-generation-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const firstArchiveRoot = join(root, 'archive-1');
    const firstTargetRoot = join(root, 'target-1');
    const secondArchiveRoot = join(root, 'archive-2');
    const secondTargetRoot = join(root, 'target-2');
    await mkdir(join(sourceRoot, 'data'), { recursive: true });
    await mkdir(firstTargetRoot);
    await mkdir(secondTargetRoot);
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );
    for (const control of [
      'hosted-restore-rotation.v1.json',
      'hosted-restore-journal.v1.json',
      'hosted-restore-rotation.completed.v1.json',
    ]) {
      await writeFile(join(sourceRoot, 'data', control), '{stale-control');
    }

    await createStoppedStackArchive({ sourceRoot, archiveRoot: firstArchiveRoot });
    const firstManifest = JSON.parse(
      await readFile(join(firstArchiveRoot, 'manifest.json'), 'utf8')
    );
    expect(firstManifest.entries.map((entry: { path: string }) => entry.path)).toEqual([
      'data/hosted-state-header.v1.json',
    ]);

    const random = (bytes: number) => Buffer.alloc(bytes, 4).toString('base64url');
    await expect(
      restoreStoppedStackArchive({
        archiveRoot: firstArchiveRoot,
        targetRoot: firstTargetRoot,
        restoreGeneration: 1,
        random,
        openDatabase: createEmptyDatabaseAdapter,
        onRestoreStage(stage: string) {
          if (stage === 'payload_copy_completed') throw new Error('simulated_payload_copy_crash');
        },
      })
    ).rejects.toThrow('simulated_payload_copy_crash');
    const interruptedJournal = JSON.parse(
      await readFile(join(firstTargetRoot, 'data', 'hosted-restore-journal.v1.json'), 'utf8')
    );
    expect(interruptedJournal).toMatchObject({
      phase: 'initialized',
      rotation: { restoreGeneration: 1 },
    });
    await expect(
      restoreStoppedStackArchive({
        archiveRoot: firstArchiveRoot,
        targetRoot: firstTargetRoot,
        restoreGeneration: 1,
        random: () => {
          throw new Error('resume_must_reuse_first_generation');
        },
        openDatabase: createEmptyDatabaseAdapter,
      })
    ).resolves.toMatchObject({ status: 'restored' });

    const rotationPath = join(firstTargetRoot, 'data', 'hosted-restore-rotation.v1.json');
    const completedPath = join(
      firstTargetRoot,
      'data',
      'hosted-restore-rotation.completed.v1.json'
    );
    await writeFile(completedPath, await readFile(rotationPath));
    await unlink(rotationPath);
    await unlink(join(firstTargetRoot, 'data', 'hosted-restore-journal.v1.json'));
    await createStoppedStackArchive({
      sourceRoot: firstTargetRoot,
      archiveRoot: secondArchiveRoot,
    });
    const secondManifest = JSON.parse(
      await readFile(join(secondArchiveRoot, 'manifest.json'), 'utf8')
    );
    expect(secondManifest.entries.map((entry: { path: string }) => entry.path)).not.toContain(
      'data/hosted-restore-rotation.completed.v1.json'
    );
    await expect(
      restoreStoppedStackArchive({
        archiveRoot: secondArchiveRoot,
        targetRoot: secondTargetRoot,
        restoreGeneration: 2,
        random: (bytes: number) => Buffer.alloc(bytes, 5).toString('base64url'),
        openDatabase: createEmptyDatabaseAdapter,
      })
    ).resolves.toMatchObject({
      status: 'restored',
      rotation: { restoreGeneration: 2 },
    });
    await expect(
      readFile(join(secondTargetRoot, 'data', 'hosted-restore-rotation.completed.v1.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('integrity-checks a descriptor-bound SQLite snapshot across a verifier-window swap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-sqlite-verifier-swap-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    await mkdir(join(sourceRoot, 'data', 'storage'), { recursive: true });
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );
    const sourceDatabase = new DatabaseSync(join(sourceRoot, 'data', 'storage', 'app.db'));
    sourceDatabase.exec('CREATE TABLE descriptor_bound(value TEXT NOT NULL)');
    sourceDatabase.close();
    await createStoppedStackArchive({ sourceRoot, archiveRoot });
    const archivedDatabase = join(archiveRoot, 'payload', 'data', 'storage', 'app.db');
    const inventoriedDatabase = `${archivedDatabase}.inventoried`;
    let swapped = false;

    await expect(
      verifyStoppedStackArchive({
        archiveRoot,
        async onSqliteSourceDescriptorVerified(path: string) {
          expect(path).toBe('data/storage/app.db');
          await rename(archivedDatabase, inventoriedDatabase);
          await writeFile(archivedDatabase, 'not a sqlite database');
          swapped = true;
        },
      })
    ).resolves.toMatchObject({ status: 'verified' });
    expect(swapped).toBe(true);
    await expect(readFile(archivedDatabase, 'utf8')).resolves.toBe('not a sqlite database');
  });

  it('fails closed when an inventoried parent directory is swapped without touching the external tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-parent-swap-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    const externalData = join(root, 'external-data');
    await mkdir(join(sourceRoot, 'data'), { recursive: true });
    await mkdir(join(externalData, 'storage'), { recursive: true });
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );
    await createStoppedStackArchive({ sourceRoot, archiveRoot });
    const externalDatabase = join(externalData, 'storage', 'app.db');
    const externalBytes = Buffer.from('external sqlite path must remain unopened');
    await writeFile(externalDatabase, externalBytes);
    const archivedData = join(archiveRoot, 'payload', 'data');
    let swapped = false;

    await expect(
      verifyStoppedStackArchive({
        archiveRoot,
        async onDirectoryDescriptorVerified(path: string) {
          if (!swapped && path === 'data') {
            await rename(archivedData, `${archivedData}.pinned`);
            await symlink(externalData, archivedData);
            swapped = true;
          }
        },
      })
    ).rejects.toThrow();
    expect(swapped).toBe(true);
    await expect(readFile(externalDatabase)).resolves.toEqual(externalBytes);
    await expect(readdir(join(externalData, 'storage'))).resolves.toEqual(['app.db']);
  });

  it('keeps every restore write pinned when the target parent is swapped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-target-parent-swap-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    const targetRoot = join(root, 'target');
    const pinnedTargetRoot = join(root, 'target-pinned');
    const externalRoot = join(root, 'external');
    await mkdir(join(sourceRoot, 'data'), { recursive: true });
    await mkdir(targetRoot);
    await mkdir(externalRoot);
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );
    await createStoppedStackArchive({ sourceRoot, archiveRoot });
    let swapped = false;

    await expect(
      restoreStoppedStackArchive({
        archiveRoot,
        targetRoot,
        restoreGeneration: 1,
        openDatabase: createEmptyDatabaseAdapter,
        async onTargetRootDescriptorVerified() {
          await rename(targetRoot, pinnedTargetRoot);
          await symlink(externalRoot, targetRoot);
          swapped = true;
        },
      })
    ).resolves.toMatchObject({ status: 'restored' });
    expect(swapped).toBe(true);
    await expect(readdir(externalRoot)).resolves.toEqual([]);
    await expect(
      readFile(join(pinnedTargetRoot, 'data', 'hosted-state-header.v1.json'), 'utf8')
    ).resolves.toContain('deployment_fixture');
    await expect(
      readFile(join(pinnedTargetRoot, 'data', 'hosted-restore-journal.v1.json'), 'utf8')
    ).resolves.toContain('"phase":"completed"');
    await expect(
      readFile(join(pinnedTargetRoot, 'data', 'hosted-auth-secrets', 'identity.key'), 'utf8')
    ).resolves.toBeTruthy();
  });

  it('fails closed on a target data-directory swap without writing externally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-target-data-swap-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    const targetRoot = join(root, 'target');
    const externalData = join(root, 'external-data');
    await mkdir(join(sourceRoot, 'data'), { recursive: true });
    await mkdir(targetRoot);
    await mkdir(externalData);
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );
    await createStoppedStackArchive({ sourceRoot, archiveRoot });
    let swapped = false;

    await expect(
      restoreStoppedStackArchive({
        archiveRoot,
        targetRoot,
        restoreGeneration: 1,
        openDatabase: createEmptyDatabaseAdapter,
        async onRestoreStage(stage: string) {
          if (stage === 'journal_published') {
            await rename(join(targetRoot, 'data'), join(targetRoot, 'data-pinned'));
            await symlink(externalData, join(targetRoot, 'data'));
            swapped = true;
          }
        },
      })
    ).rejects.toThrow();
    expect(swapped).toBe(true);
    await expect(readdir(externalData)).resolves.toEqual([]);
    await expect(
      readFile(join(targetRoot, 'data-pinned', 'hosted-restore-journal.v1.json'), 'utf8')
    ).resolves.toContain('"phase":"initialized"');
  });

  it('publishes archive metadata and root in deterministic durability order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-durability-order-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    const observed: string[] = [];
    await mkdir(join(sourceRoot, 'data'), { recursive: true });
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );

    await expect(
      createStoppedStackArchive({
        sourceRoot,
        archiveRoot,
        onArchiveCommitStage(stage: string) {
          observed.push(stage);
        },
      })
    ).resolves.toMatchObject({ status: 'committed' });
    expect(observed).toEqual([
      'payload_directories_synced',
      'manifest_durable',
      'ready_durable',
      'staging_directory_synced',
      'archive_published',
      'archive_parent_synced',
    ]);
    await expect(verifyStoppedStackArchive({ archiveRoot })).resolves.toMatchObject({
      status: 'verified',
    });
  });

  it.each([
    'journal_published',
    'rotation_marker_published',
    'payload_copy_completed',
    'payload_restored',
    'database_transaction_committed',
    'database_rotated',
    'secret_generation_published',
    'secrets_published',
    'restore_completed',
  ])('resumes crash-atomically after %s', async (crashStage) => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-interrupted-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    const targetRoot = join(root, 'target');
    await mkdir(join(sourceRoot, 'data'), { recursive: true });
    await mkdir(targetRoot);
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );
    await createStoppedStackArchive({ sourceRoot, archiveRoot });

    const openDatabase = createEmptyDatabaseAdapter;
    await expect(
      restoreStoppedStackArchive({
        archiveRoot,
        targetRoot,
        restoreGeneration: 1,
        random: (bytes: number) => Buffer.alloc(bytes, 9).toString('base64url'),
        openDatabase,
        onRestoreStage(stage: string) {
          if (stage === crashStage) throw new Error(`simulated_interruption:${stage}`);
        },
      })
    ).rejects.toThrow(`simulated_interruption:${crashStage}`);
    const journal = JSON.parse(
      await readFile(join(targetRoot, 'data', 'hosted-restore-journal.v1.json'), 'utf8')
    );
    const keyringId = journal.secretPlan?.keyring.keyringId ?? journal.keyringId;

    await expect(
      restoreStoppedStackArchive({
        archiveRoot,
        targetRoot,
        restoreGeneration: 1,
        random: () => {
          throw new Error('resume_must_not_regenerate_authority');
        },
        openDatabase,
      })
    ).resolves.toMatchObject({ status: 'restored', rotation: journal.rotation });
    const keyring = JSON.parse(
      await readFile(
        join(targetRoot, 'data', 'hosted-auth-secrets', 'personal-keyring.json'),
        'utf8'
      )
    );
    expect(keyring.keyringId).toBe(keyringId);
    const completed = JSON.parse(
      await readFile(join(targetRoot, 'data', 'hosted-restore-journal.v1.json'), 'utf8')
    );
    expect(completed).toMatchObject({ phase: 'completed', keyringId });
    expect(completed).not.toHaveProperty('secretPlan');
  });

  it('rolls back database rotation when foreign-key verification fails before commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recovery-foreign-key-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    const targetRoot = join(root, 'target');
    await mkdir(join(sourceRoot, 'data'), { recursive: true });
    await mkdir(targetRoot);
    await writeFile(
      join(sourceRoot, 'data', 'hosted-state-header.v1.json'),
      JSON.stringify({
        format: 'hosted-state-header/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_fixture',
        hostedStateSchemaVersion: 1,
      })
    );
    await createStoppedStackArchive({ sourceRoot, archiveRoot });
    let committed = false;
    const openDatabase = () => ({
      pragma(statement: string) {
        return mockPragma(statement, [{ table: 'broken_reference' }]);
      },
      transaction(callback: () => void) {
        return () => {
          callback();
          committed = true;
        };
      },
      prepare() {
        return { get: () => undefined, run: () => undefined };
      },
      close() {
        return;
      },
    });

    await expect(
      restoreStoppedStackArchive({
        archiveRoot,
        targetRoot,
        restoreGeneration: 1,
        openDatabase,
      })
    ).rejects.toThrow('stopped_stack_restore_foreign_key_failed');
    expect(committed).toBe(false);
    await expect(
      readFile(join(targetRoot, 'data', 'hosted-auth-secrets', 'personal-keyring.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function createEmptyDatabaseAdapter() {
  return {
    pragma(statement: string) {
      return mockPragma(statement, []);
    },
    transaction(callback: () => void) {
      return callback;
    },
    prepare() {
      return { get: () => undefined, run: () => undefined };
    },
    close() {
      return;
    },
  };
}

function mockPragma(statement: string, foreignKeyFailures: readonly unknown[]): unknown {
  return new Map<string, unknown>([
    ['integrity_check', 'ok'],
    ['foreign_key_check', foreignKeyFailures],
  ]).get(statement);
}

async function overwriteHardenedArchiveFile(path: string, body: string): Promise<void> {
  await chmod(path, 0o600);
  try {
    await writeFile(path, body);
  } finally {
    await chmod(path, 0o400);
  }
}

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createHostedStateCompatibilityAdmission,
  createNodeHostedStateCompatibilityAdmission,
  NodeHostedStateCompatibilityRuntime,
  type NodeHostedStateCompatibilityRuntimeOptions,
  type HostedRestoredSqliteFamilyEntry,
  type HostedStateCompatibilityRuntime,
  HostedStateStartupRefusedError,
} from '@features/hosted-state-compatibility/main';
import {
  createStoppedStackArchive,
  restoreStoppedStackArchive,
} from '../../../../scripts/hosted-web/phase-10/state-compatibility/stopped-stack-recovery.mjs';
import { afterEach, describe, expect, it } from 'vitest';

import { artifactManifest, stateHeader } from '../fixtures';

const roots: string[] = [];

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function sqliteFamily(root: string): Promise<readonly HostedRestoredSqliteFamilyEntry[]> {
  const family: HostedRestoredSqliteFamilyEntry[] = [];
  for (const name of ['app.db', 'app.db-wal', 'app.db-shm']) {
    const path = join(root, 'storage', name);
    try {
      const [body, metadata] = await Promise.all([readFile(path), lstat(path)]);
      family.push({
        path: `data/storage/${name}` as HostedRestoredSqliteFamilyEntry['path'],
        byteLength: metadata.size,
        mode: metadata.mode & 0o777,
        sha256: createHash('sha256').update(body).digest('hex'),
      });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return family;
}

function completedRestoreJournal(
  request: Record<string, unknown>,
  databaseFamily: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly mode: number;
    readonly sha256: string;
  }[] = []
) {
  const secretPlan = {
    identityKey: 'i'.repeat(32),
    keyring: {
      binding: { deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration },
      createdAt: 0,
      csrfKey: 'c'.repeat(32),
      format: 'hosted-access-keyring/v1',
      hashKey: 'h'.repeat(32),
      keyringId: 'akr_x123456789012345678',
    },
  };
  const sqliteAuthority = {
    format: 'hosted-stopped-stack-sqlite-authority/v1',
    schemaVersion: 1,
    preRotation: databaseFamily,
    databaseIdentity: databaseFamily.find((entry) => entry.path === 'data/storage/app.db')
      ? { sourceManifestHash: request.sourceManifestHash, ...databaseFamily.find((entry) => entry.path === 'data/storage/app.db') }
      : null,
    postRotation: {
      databaseFamily,
      databaseFamilyIdentity: createHash('sha256').update(stableJson(databaseFamily)).digest('hex'),
      rotationScope: `${request.sourceManifestHash}.g-${request.restoreGeneration}`,
      immutableArchiveReplay: {
        format: 'hosted-immutable-restore-archive-replay/v1',
        sourceManifestHash: request.sourceManifestHash,
        restoreGeneration: request.restoreGeneration,
        rotationScope: `${request.sourceManifestHash}.g-${request.restoreGeneration}`,
      },
      rotationSha256: createHash('sha256').update(stableJson({ rotation: request, keyringId: secretPlan.keyring.keyringId })).digest('hex'),
      audit: (() => {
        const rotationScope = `${request.sourceManifestHash}.g-${request.restoreGeneration}`;
        const preRotationIdentity = createHash('sha256').update(stableJson(databaseFamily)).digest('hex');
        const databaseFamilyIdentity = createHash('sha256').update(stableJson(databaseFamily)).digest('hex');
        const rotationSha256 = createHash('sha256').update(stableJson({ rotation: request, keyringId: secretPlan.keyring.keyringId })).digest('hex');
        return {
          format: 'hosted-stopped-stack-sqlite-rotation-transition/v1',
          sourceManifestHash: request.sourceManifestHash,
          rotationScope,
          preRotationIdentity,
          checkpointIdentity: preRotationIdentity,
          databaseFamilyIdentity,
          auditSha256: createHash('sha256').update(stableJson({
            sourceManifestHash: request.sourceManifestHash,
            rotationScope,
            preRotationIdentity,
            checkpointIdentity: preRotationIdentity,
            databaseFamilyIdentity,
            rotationSha256,
          })).digest('hex'),
        };
      })(),
    },
  };
  return {
    format: 'hosted-stopped-stack-restore-journal/v1',
    schemaVersion: 1,
    manifestHash: request.sourceManifestHash,
    phase: 'completed',
    rotation: request,
    secretPlan,
    sqliteAuthority,
    keyringId: secretPlan.keyring.keyringId,
    secretPlanSha256: createHash('sha256').update(stableJson(secretPlan)).digest('hex'),
  };
}

async function publishFreshRuntimeAuthority(
  paths: { readonly stateDirectory: string },
  request: Record<string, unknown>
): Promise<void> {
  const journal = completedRestoreJournal(request);
  await mkdir(join(paths.stateDirectory, 'hosted-auth-secrets'), { recursive: true });
  await writeFile(
    join(paths.stateDirectory, 'hosted-auth-secrets', 'personal-keyring.json'),
    `${stableJson(journal.secretPlan.keyring)}\n`
  );
  await writeFile(
    join(paths.stateDirectory, 'hosted-auth-secrets', 'identity.key'),
    `${journal.secretPlan.identityKey}\n`
  );
}

async function fixture(options: {
  state?: unknown;
  manifest?: unknown;
  onReadAndSyncStage?: (stage: 'file_fsynced_before_directory_fsync', path: string) => void | Promise<void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-state-admission-'));
  roots.push(root);
  const artifactDirectory = join(root, 'artifact');
  const stateDirectory = join(root, 'state');
  await mkdir(artifactDirectory);
  await mkdir(stateDirectory);
  const manifestBody = `${JSON.stringify(
    options.manifest ??
      artifactManifest({
        manifestId: 'hosted-state-v1-artifact-test',
        artifactVersion: 'test',
        hostedStateSchemaVersion: 1,
        minimumReadableHostedStateVersion: 1,
        orderedMigrations: [],
      })
  )}\n`;
  await writeFile(join(artifactDirectory, 'manifest.json'), manifestBody);
  await writeFile(
    join(artifactDirectory, 'manifest.json.sha256'),
    `${createHash('sha256').update(manifestBody).digest('hex')}\n`
  );
  if (options.state !== undefined) {
    await writeFile(
      join(stateDirectory, 'hosted-state-header.v1.json'),
      typeof options.state === 'string' ? options.state : JSON.stringify(options.state)
    );
  }
  const immutableRestoreFamilies = new Map<string, readonly HostedRestoredSqliteFamilyEntry[]>();
  return {
    artifactDirectory,
    stateDirectory,
    immutableRestoreFamilies,
    runtime: createTestRuntime({
      immutableRestoreFamilies,
      onReadAndSyncStage: options.onReadAndSyncStage,
    }),
  };
}

function createTestRuntime(options: {
  immutableRestoreFamilies?: ReadonlyMap<string, readonly HostedRestoredSqliteFamilyEntry[]>;
  onReadAndSyncStage?: (stage: 'file_fsynced_before_directory_fsync', path: string) => void | Promise<void>;
} = {}): HostedStateCompatibilityRuntime {
  return {
    sha256: (body) => createHash('sha256').update(body).digest('hex'),
    ensureDirectory: (path, mode) => mkdir(path, { recursive: true, mode }).then(() => undefined),
    readDirectory: (path) => readdir(path),
    async readRegularBoundedUtf8(path, maximumBytes) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maximumBytes) {
          throw new Error('hosted_state_metadata_file_invalid');
        }
        const body = await handle.readFile('utf8');
        const after = await handle.stat();
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          Buffer.byteLength(body) !== before.size
        ) {
          throw new Error('hosted_state_metadata_file_changed_during_read');
        }
        return body;
      } finally {
        await handle.close();
      }
    },
    async readRegularBoundedBytes(path, maximumBytes) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maximumBytes) throw new Error('hosted_state_metadata_file_invalid');
        const body = await handle.readFile();
        const after = await handle.stat();
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs || body.byteLength !== before.size) {
          throw new Error('hosted_state_metadata_file_changed_during_read');
        }
        return body;
      } finally {
        await handle.close();
      }
    },
    async replayImmutableRestoreArchiveSqliteFamily(request) {
      // This is the test double for the independently owned archive replay
      // authority. It never reads the mutable target or restore journal.
      return options.immutableRestoreFamilies?.get(
        `${request.sourceManifestHash}.g-${request.restoreGeneration}`
      ) ?? [];
    },
    async readAndSyncRegularBoundedUtf8(path, maximumBytes) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maximumBytes) {
          throw new Error('hosted_state_metadata_file_invalid');
        }
        const body = await handle.readFile('utf8');
        const beforeSync = await handle.stat();
        if (
          beforeSync.dev !== before.dev ||
          beforeSync.ino !== before.ino ||
          beforeSync.size !== before.size ||
          beforeSync.mtimeMs !== before.mtimeMs ||
          Buffer.byteLength(body) !== before.size
        ) {
          throw new Error('hosted_state_metadata_file_changed_during_read');
        }
        await handle.sync();
        const after = await handle.stat();
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs
        ) {
          throw new Error('hosted_state_metadata_file_changed_during_sync');
        }
        // A complete inode is not a durable recovery record until its parent
        // directory entry is flushed too. Keep the descriptor open through
        // both checks so a retry cannot settle from an orphaned inode.
        await options.onReadAndSyncStage?.('file_fsynced_before_directory_fsync', path);
        const directory = await open(
          dirname(path),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        const named = await lstat(path);
        const afterDirectorySync = await handle.stat();
        if (
          named.isSymbolicLink() ||
          named.dev !== before.dev ||
          named.ino !== before.ino ||
          named.size !== before.size ||
          named.mtimeMs !== before.mtimeMs ||
          afterDirectorySync.dev !== before.dev ||
          afterDirectorySync.ino !== before.ino ||
          afterDirectorySync.size !== before.size ||
          afterDirectorySync.mtimeMs !== before.mtimeMs
        ) {
          throw new Error('hosted_state_metadata_directory_entry_changed_during_sync');
        }
        return body;
      } finally {
        await handle.close();
      }
    },
    async writeExclusiveDurable(path, body, mode) {
      const staging = `${path}.staging`;
      const handle = await open(
        staging,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        mode
      );
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staging, path);
    },
    async writeStagingExclusiveDurable(path, body, mode) {
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        mode
      );
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
    async promoteStagingExclusive(stagingPath, finalPath) {
      // link(2) is no-replace: unlike rename(2), EEXIST preserves a
      // concurrently settled final binding.
      await link(stagingPath, finalPath);
      await unlink(stagingPath);
      const directory = await open(dirname(finalPath), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
    async removeFileDurable(path) {
      await unlink(path);
      const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
    async verifyAndSettleRuntimeMountAdmission(receipt, request) {
      if (
        receipt.format !== 'hosted-runtime-mount-admission-receipt/v1' ||
        receipt.schemaVersion !== 1 || receipt.authorityId !== 'test-runtime-authority' ||
        receipt.operationId !== `operation-${request.restoreGeneration}` ||
        receipt.admissionEpoch !== `epoch-${request.restoreGeneration}` ||
        receipt.signature !== 'test-authority-signature' ||
        receipt.deploymentId !== request.deploymentId || receipt.targetDeploymentId !== request.deploymentId ||
        receipt.sourceManifestHash !== request.sourceManifestHash ||
        receipt.restoreGeneration !== request.restoreGeneration ||
        receipt.bootId !== request.bootId || receipt.eventEpoch !== request.eventEpoch
      ) {
        throw new Error('test_runtime_mount_authority_rejected');
      }
      return {
        receipt,
        receiptSha256: createHash('sha256').update(stableJson(receipt)).digest('hex'),
        currentOperationId: receipt.operationId,
        currentAdmissionEpoch: receipt.admissionEpoch,
        durableHighWaterAdmissionEpoch: receipt.admissionEpoch,
      };
    },
  };
}

function runtimeMountAdmission(request: {
  readonly deploymentId: string;
  readonly sourceManifestHash: string;
  readonly restoreGeneration: number;
  readonly bootId: string;
  readonly eventEpoch: string;
}) {
  return {
    format: 'hosted-runtime-mount-admission-receipt/v1' as const,
    schemaVersion: 1 as const,
    authorityId: 'test-runtime-authority',
    operationId: `operation-${request.restoreGeneration}`,
    deploymentId: request.deploymentId,
    targetDeploymentId: request.deploymentId,
    sourceManifestHash: request.sourceManifestHash,
    restoreGeneration: request.restoreGeneration,
    bootId: request.bootId,
    eventEpoch: request.eventEpoch,
    admissionEpoch: `epoch-${request.restoreGeneration}`,
    signature: 'test-authority-signature',
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('hosted state production startup admission', () => {
  it('fails closed for a completed journal produced before immutable archive replay was required', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: 'f'.repeat(64), restoreGeneration: 30,
      bootId: 'boot_pre_archive_replay', eventEpoch: 'epoch_pre_archive_replay',
      browserAuthorityRotated: true as const, runtimeAuthorityRotationRequired: true as const,
      freshMountBindingsRequired: true as const,
    };
    const journal = completedRestoreJournal(request) as {
      sqliteAuthority: { postRotation: Record<string, unknown> };
    };
    delete journal.sqliteAuthority.postRotation.immutableArchiveReplay;
    await writeFile(
      join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`),
      JSON.stringify(request)
    );
    await writeFile(
      join(paths.stateDirectory, 'hosted-restore-journal.v1.json'),
      JSON.stringify(journal)
    );
    await publishFreshRuntimeAuthority(paths, request);
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(composition.completeOfflineRestoreRotation({
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch,
      runtimeMountAdmission: runtimeMountAdmission(request),
    })).rejects.toThrow('hosted_restore_rotation_journal_invalid');
  });

  it('rejects a row mutation against a real descriptor-bound immutable archive replay before settlement', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const root = dirname(paths.stateDirectory);
    const archiveSource = join(root, 'immutable-archive-source');
    const archive = join(root, 'immutable-archive');
    const restoredRoot = join(root, 'immutable-restored-state');
    const storage = join(archiveSource, 'data', 'storage');
    await mkdir(storage, { recursive: true });
    await writeFile(join(archiveSource, 'data', 'hosted-state-header.v1.json'), JSON.stringify(stateHeader(1)));
    const databasePath = join(storage, 'app.db');
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("CREATE TABLE admitted_rows(value TEXT NOT NULL); INSERT INTO admitted_rows VALUES ('sealed');");
    } finally {
      database.close();
    }
    const backup = await createStoppedStackArchive({ sourceRoot: archiveSource, archiveRoot: archive });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: backup.manifestHash, restoreGeneration: 32,
      bootId: 'boot_immutable_archive_replay', eventEpoch: 'epoch_immutable_archive_replay',
      browserAuthorityRotated: true as const, runtimeAuthorityRotationRequired: true as const,
      freshMountBindingsRequired: true as const,
    };
    const sealedPlan = completedRestoreJournal(request) as { readonly secretPlan: unknown };
    await mkdir(restoredRoot);
    await restoreStoppedStackArchive({
      archiveRoot: archive,
      targetRoot: restoredRoot,
      restoreDeploymentId: request.deploymentId,
      restoreGeneration: request.restoreGeneration,
      expectedManifestHash: request.sourceManifestHash,
      restoreAuthorityPlan: { rotation: request, secretPlan: sealedPlan.secretPlan },
    });
    const stateDirectory = join(restoredRoot, 'data');
    const restoredDatabasePath = join(stateDirectory, 'storage', 'app.db');

    const substituted = new DatabaseSync(restoredDatabasePath);
    try {
      substituted.exec("UPDATE admitted_rows SET value = 'substituted';");
    } finally {
      substituted.close();
    }
    // An attacker can regenerate every hash derived from the journal and the
    // mutable application files. The admission authority must still compare
    // the target bytes with its isolated immutable-archive replay.
    const forgedFamily = await sqliteFamily(stateDirectory);
    type MutableCompletedJournal = {
      secretPlan: { keyring: { keyringId: string } };
      keyringId: string;
      secretPlanSha256: string;
      sqliteAuthority: {
        preRotation: unknown;
        databaseIdentity: unknown;
        checkpointTransformation?: { postCheckpoint: unknown };
        postRotation: {
          databaseFamily: unknown;
          databaseFamilyIdentity: string;
          rotationSha256: string;
          audit: unknown;
        };
      };
    };
    const liveJournal = JSON.parse(
      await readFile(join(stateDirectory, 'hosted-restore-journal.v1.json'), 'utf8')
    ) as MutableCompletedJournal;
    const forged = completedRestoreJournal(request, forgedFamily) as MutableCompletedJournal;
    // All journal-derived fields below are recomputed after modifying live
    // rows. The production runtime must nevertheless reject based on the
    // selected archive descriptor and its sealed replay plan.
    forged.secretPlan = liveJournal.secretPlan;
    forged.keyringId = liveJournal.keyringId;
    forged.secretPlanSha256 = createHash('sha256').update(stableJson(forged.secretPlan)).digest('hex');
    forged.sqliteAuthority.preRotation = liveJournal.sqliteAuthority.preRotation;
    forged.sqliteAuthority.databaseIdentity = liveJournal.sqliteAuthority.databaseIdentity;
    const keyringId = forged.secretPlan.keyring.keyringId;
    const rotationScope = `${request.sourceManifestHash}.g-${request.restoreGeneration}`;
    const preRotationIdentity = createHash('sha256').update(stableJson(forged.sqliteAuthority.preRotation)).digest('hex');
    const databaseFamilyIdentity = createHash('sha256').update(stableJson(forgedFamily)).digest('hex');
    const rotationSha256 = createHash('sha256').update(stableJson({ rotation: request, keyringId })).digest('hex');
    forged.sqliteAuthority.postRotation.databaseFamilyIdentity = databaseFamilyIdentity;
    forged.sqliteAuthority.postRotation.rotationSha256 = rotationSha256;
    forged.sqliteAuthority.postRotation.audit = {
      format: 'hosted-stopped-stack-sqlite-rotation-transition/v1',
      sourceManifestHash: request.sourceManifestHash,
      rotationScope,
      preRotationIdentity,
      checkpointIdentity: liveJournal.sqliteAuthority.checkpointTransformation
        ? createHash('sha256').update(stableJson(liveJournal.sqliteAuthority.checkpointTransformation.postCheckpoint)).digest('hex')
        : preRotationIdentity,
      databaseFamilyIdentity,
      auditSha256: createHash('sha256').update(stableJson({
        sourceManifestHash: request.sourceManifestHash,
        rotationScope,
        preRotationIdentity,
        checkpointIdentity: liveJournal.sqliteAuthority.checkpointTransformation
          ? createHash('sha256').update(stableJson(liveJournal.sqliteAuthority.checkpointTransformation.postCheckpoint)).digest('hex')
          : preRotationIdentity,
        databaseFamilyIdentity,
        rotationSha256,
      })).digest('hex'),
    };
    await writeFile(
      join(stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(forged)
    );
    let settlements = 0;
    const runtimeOptions: NodeHostedStateCompatibilityRuntimeOptions = {
      immutableRestoreArchiveAuthority: {
        async resolveArchive(scope) {
          expect(scope).toEqual(request);
          return {
            archiveDirectory: archive,
            sourceManifestHash: request.sourceManifestHash,
            restoreGeneration: request.restoreGeneration,
            replayAuthorityPlan: { rotation: request, secretPlan: sealedPlan.secretPlan },
          };
        },
      },
      async verifyAndSettleRuntimeMountAdmission(receipt) {
        settlements += 1;
        return {
          receipt,
          receiptSha256: createHash('sha256').update(stableJson(receipt)).digest('hex'),
          currentOperationId: receipt.operationId,
          currentAdmissionEpoch: receipt.admissionEpoch,
          durableHighWaterAdmissionEpoch: receipt.admissionEpoch,
        };
      },
    };
    const runtime = new NodeHostedStateCompatibilityRuntime(runtimeOptions);
    const composition = createNodeHostedStateCompatibilityAdmission({
      artifactDirectory: paths.artifactDirectory,
      stateDirectory,
      expectedDeploymentId: 'deployment-fixture',
      runtimeOptions,
    });

    // The same production worker accepts the intact selected archive and
    // derives the original rotated family before the forged target is tested.
    await expect(runtime.replayImmutableRestoreArchiveSqliteFamily(request)).resolves.toEqual(
      liveJournal.sqliteAuthority.postRotation.databaseFamily
    );

    await expect(composition.completeOfflineRestoreRotation({
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch,
      runtimeMountAdmission: runtimeMountAdmission(request),
    })).rejects.toThrow('hosted_restore_rotation_journal_sqlite_family_invalid');
    expect(settlements).toBe(0);
  });

  it('rejects a malformed selected archive and removes its isolated replay state', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const archive = join(dirname(paths.stateDirectory), 'malformed-immutable-archive');
    await mkdir(archive);
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: '9'.repeat(64), restoreGeneration: 9,
      bootId: 'boot_malformed_replay', eventEpoch: 'epoch_malformed_replay',
      browserAuthorityRotated: true as const, runtimeAuthorityRotationRequired: true as const,
      freshMountBindingsRequired: true as const,
    };
    const sealedPlan = completedRestoreJournal(request) as { readonly secretPlan: unknown };
    const scratchBefore = (await readdir(tmpdir())).filter((entry) => entry.startsWith('hosted-immutable-restore-replay-'));
    const runtime = new NodeHostedStateCompatibilityRuntime({
      immutableRestoreArchiveAuthority: {
        async resolveArchive() {
          return {
            archiveDirectory: archive,
            sourceManifestHash: request.sourceManifestHash,
            restoreGeneration: request.restoreGeneration,
            replayAuthorityPlan: { rotation: request, secretPlan: sealedPlan.secretPlan },
          };
        },
      },
      async verifyAndSettleRuntimeMountAdmission() { throw new Error('unexpected_settlement'); },
    });
    await expect(runtime.replayImmutableRestoreArchiveSqliteFamily(request)).rejects.toThrow(
      'hosted_restore_archive_replay_failed'
    );
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('hosted-immutable-restore-replay-'))).toEqual(scratchBefore);
  });

  it('rejects an archive pathname replacement after the selected descriptor is bound', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const root = dirname(paths.stateDirectory);
    const archive = join(root, 'selected-immutable-archive');
    const archived = join(root, 'selected-immutable-archive-original');
    const worker = join(root, 'replace-selected-archive.mjs');
    await mkdir(archive);
    await writeFile(worker, [
      "import { mkdir, rename } from 'node:fs/promises';",
      `await rename(${JSON.stringify(archive)}, ${JSON.stringify(archived)});`,
      `await mkdir(${JSON.stringify(archive)});`,
      "process.stdout.write(JSON.stringify({ format: 'hosted-immutable-restore-archive-sqlite-family/v1', family: [] }) + '\\n');",
    ].join('\n'));
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: '7'.repeat(64), restoreGeneration: 7,
      bootId: 'boot_archive_swap', eventEpoch: 'epoch_archive_swap',
      browserAuthorityRotated: true as const, runtimeAuthorityRotationRequired: true as const,
      freshMountBindingsRequired: true as const,
    };
    const sealedPlan = completedRestoreJournal(request) as { readonly secretPlan: unknown };
    const runtime = new NodeHostedStateCompatibilityRuntime({
      immutableRestoreArchiveAuthority: {
        async resolveArchive() {
          return {
            archiveDirectory: archive,
            sourceManifestHash: request.sourceManifestHash,
            restoreGeneration: request.restoreGeneration,
            replayAuthorityPlan: { rotation: request, secretPlan: sealedPlan.secretPlan },
          };
        },
      },
      async verifyAndSettleRuntimeMountAdmission() { throw new Error('unexpected_settlement'); },
      replayWorkerPath: worker,
    });
    await expect(runtime.replayImmutableRestoreArchiveSqliteFamily(request)).rejects.toThrow(
      'hosted_restore_archive_identity_changed'
    );
  });

  it('bounds the production replay worker and removes its isolated replay state on timeout', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const root = dirname(paths.stateDirectory);
    const source = join(root, 'timeout-immutable-source');
    const archive = join(root, 'timeout-immutable-archive');
    await mkdir(join(source, 'data', 'storage'), { recursive: true });
    await writeFile(join(source, 'data', 'hosted-state-header.v1.json'), JSON.stringify(stateHeader(1)));
    const database = new DatabaseSync(join(source, 'data', 'storage', 'app.db'));
    try {
      database.exec('CREATE TABLE timeout_proof(value TEXT NOT NULL);');
    } finally {
      database.close();
    }
    const backup = await createStoppedStackArchive({ sourceRoot: source, archiveRoot: archive });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: backup.manifestHash, restoreGeneration: 8,
      bootId: 'boot_timeout_replay', eventEpoch: 'epoch_timeout_replay',
      browserAuthorityRotated: true as const, runtimeAuthorityRotationRequired: true as const,
      freshMountBindingsRequired: true as const,
    };
    const sealedPlan = completedRestoreJournal(request) as { readonly secretPlan: unknown };
    const scratchBefore = (await readdir(tmpdir())).filter((entry) => entry.startsWith('hosted-immutable-restore-replay-'));
    const runtime = new NodeHostedStateCompatibilityRuntime({
      immutableRestoreArchiveAuthority: {
        async resolveArchive() {
          return {
            archiveDirectory: archive,
            sourceManifestHash: request.sourceManifestHash,
            restoreGeneration: request.restoreGeneration,
            replayAuthorityPlan: { rotation: request, secretPlan: sealedPlan.secretPlan },
          };
        },
      },
      async verifyAndSettleRuntimeMountAdmission() { throw new Error('unexpected_settlement'); },
      replayTimeoutMs: 10,
    });
    await expect(runtime.replayImmutableRestoreArchiveSqliteFamily(request)).rejects.toThrow(
      'hosted_restore_archive_replay_failed'
    );
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('hosted-immutable-restore-replay-'))).toEqual(scratchBefore);
  });

  it('hashes the actual completed SQLite family before it can settle admission', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: 'd'.repeat(64), restoreGeneration: 31,
      bootId: 'boot_sqlite_family', eventEpoch: 'epoch_sqlite_family', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    const original = Buffer.from('sealed-sqlite-family-member');
    const family = [{
      path: 'data/storage/app.db', byteLength: original.byteLength, mode: 0o600,
      sha256: createHash('sha256').update(original).digest('hex'),
    }];
    await mkdir(join(paths.stateDirectory, 'storage'), { recursive: true });
    await writeFile(join(paths.stateDirectory, 'storage', 'app.db'), original);
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request, family)));
    await publishFreshRuntimeAuthority(paths, request);
    await writeFile(join(paths.stateDirectory, 'storage', 'app.db'), 'substituted-sqlite-family-member');
    const settle = paths.runtime.verifyAndSettleRuntimeMountAdmission;
    let settlements = 0;
    paths.runtime.verifyAndSettleRuntimeMountAdmission = async (...args) => {
      settlements += 1;
      return await settle(...args);
    };
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

    await expect(composition.completeOfflineRestoreRotation({
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
    })).rejects.toThrow('hosted_restore_rotation_journal_sqlite_family_invalid');
    expect(settlements).toBe(0);
  });

  it('creates the header only for an empty target and admits compatible state', async () => {
    const paths = await fixture();
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(composition.admitBeforeListenerExposure()).resolves.toEqual({
      status: 'read_write',
      hostedStateSchemaVersion: 1,
    });
  });

  it.each([
    ['future state', stateHeader(2), 'refused'],
    ['corrupt state', '{not-json', 'state_metadata_invalid'],
    ['cross-snapshot state', stateHeader(1, 'deployment-other'), 'state_deployment_mismatch'],
  ])(
    'fails closed on %s before a caller can expose a listener',
    async (_label, state, diagnostic) => {
      const paths = await fixture({ state });
      const exposeListener = vi.fn();
      const composition = createHostedStateCompatibilityAdmission({
        ...paths,
        expectedDeploymentId: 'deployment-fixture',
      });

      await expect(composition.admitBeforeListenerExposure()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostedStateStartupRefusedError &&
          (diagnostic === 'refused'
            ? error.admission?.status === 'refused'
            : error.diagnostic === diagnostic)
      );
      expect(exposeListener).not.toHaveBeenCalled();
    }
  );

  it('refuses a missing header when persisted state already exists', async () => {
    const paths = await fixture();
    await writeFile(join(paths.stateDirectory, 'foreign-state'), 'present');
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(composition.admitBeforeListenerExposure()).rejects.toMatchObject({
      diagnostic: 'state_metadata_invalid',
    });
  });

  it('refuses a corrupt built-manifest hash without initializing empty state', async () => {
    const paths = await fixture();
    await writeFile(join(paths.artifactDirectory, 'manifest.json.sha256'), `${'0'.repeat(64)}\n`);
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(composition.admitBeforeListenerExposure()).rejects.toMatchObject({
      diagnostic: 'artifact_manifest_integrity_failed',
    });
    await expect(readdir(paths.stateDirectory)).resolves.toEqual([]);
  });

  it('refuses symlink-swapped metadata through the descriptor-bound runtime seam', async () => {
    const paths = await fixture();
    const manifestPath = join(paths.artifactDirectory, 'manifest.json');
    await unlink(manifestPath);
    await symlink('/dev/null', manifestPath);
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(composition.admitBeforeListenerExposure()).rejects.toMatchObject({
      diagnostic: 'state_metadata_invalid',
    });
    await expect(readdir(paths.stateDirectory)).resolves.toEqual([]);
  });

  it('holds restored state until the operations lane proves session, runtime and mount rotation', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const,
      schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture',
      sourceManifestHash: 'a'.repeat(64),
      restoreGeneration: 2,
      bootId: 'boot_rotated',
      eventEpoch: 'epoch_rotated',
      browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const,
      freshMountBindingsRequired: true as const,
    };
    await writeFile(
      join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`),
      JSON.stringify(request)
    );
    await writeFile(
      join(paths.stateDirectory, 'hosted-restore-journal.v1.json'),
      JSON.stringify(completedRestoreJournal(request))
    );
    await publishFreshRuntimeAuthority(paths, request);
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(composition.inspectPendingOfflineRestoreRotation()).resolves.toEqual(request);
    await expect(composition.admitBeforeListenerExposure()).rejects.toMatchObject({
      diagnostic: 'offline_restore_rotation_pending',
    });
    await expect(
      composition.completeOfflineRestoreRotation({
        deploymentId: request.deploymentId,
        restoreGeneration: request.restoreGeneration,
        bootId: request.bootId,
        eventEpoch: request.eventEpoch,
        runtimeMountAdmission: runtimeMountAdmission(request),
      })
    ).resolves.toBeUndefined();
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain(
      'hosted-restore-journal.v1.json'
    );
    await expect(composition.admitBeforeListenerExposure()).resolves.toMatchObject({
      status: 'read_write',
    });
    // A subsequent restore must select only its own generation and leave the
    // prior completion record historical. This exercises the same production
    // admission path across two restore/completion cycles.
    const second = {
      ...request,
      sourceManifestHash: 'c'.repeat(64),
      restoreGeneration: 4,
      bootId: 'boot_second',
      eventEpoch: 'epoch_second',
    };
    await writeFile(
      join(paths.stateDirectory, `hosted-restore-rotation.v1.${second.sourceManifestHash}.g-${second.restoreGeneration}.json`),
      JSON.stringify(second)
    );
    await writeFile(
      join(paths.stateDirectory, 'hosted-restore-journal.v1.json'),
      JSON.stringify(completedRestoreJournal(second))
    );
    await publishFreshRuntimeAuthority(paths, second);
    await expect(composition.admitBeforeListenerExposure()).rejects.toMatchObject({
      diagnostic: 'offline_restore_rotation_pending',
    });
    await expect(composition.completeOfflineRestoreRotation({
      deploymentId: second.deploymentId,
      restoreGeneration: second.restoreGeneration,
      bootId: second.bootId,
      eventEpoch: second.eventEpoch,
      runtimeMountAdmission: runtimeMountAdmission(second),
    })).resolves.toBeUndefined();
    await expect(composition.admitBeforeListenerExposure()).resolves.toMatchObject({ status: 'read_write' });
  });

  it('resumes an interrupted rotation completion after the durable completion marker', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const,
      schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture',
      sourceManifestHash: 'b'.repeat(64),
      restoreGeneration: 3,
      bootId: 'boot_resumed',
      eventEpoch: 'epoch_resumed',
      browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const,
      freshMountBindingsRequired: true as const,
    };
    const body = JSON.stringify(request);
    await writeFile(
      join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`),
      body
    );
    await writeFile(
      join(paths.stateDirectory, `hosted-restore-rotation.completed.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`),
      body
    );
    await writeFile(
      join(paths.stateDirectory, 'hosted-restore-journal.v1.json'),
      JSON.stringify(completedRestoreJournal(request))
    );
    await publishFreshRuntimeAuthority(paths, request);
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(
      composition.completeOfflineRestoreRotation({
        deploymentId: request.deploymentId,
        restoreGeneration: request.restoreGeneration,
        bootId: request.bootId,
        eventEpoch: request.eventEpoch,
        runtimeMountAdmission: runtimeMountAdmission(request),
      })
    ).resolves.toBeUndefined();
    await expect(composition.admitBeforeListenerExposure()).resolves.toMatchObject({
      status: 'read_write',
    });
  });

  it('re-verifies the already-settled receipt after a crash between binding publication and marker retirement', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: '7'.repeat(64), restoreGeneration: 7,
      bootId: 'boot_binding_crash', eventEpoch: 'epoch_binding_crash', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    const proof = {
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
    };
    let settlements = 0;
    const settle = paths.runtime.verifyAndSettleRuntimeMountAdmission;
    paths.runtime.verifyAndSettleRuntimeMountAdmission = async (...args) => {
      settlements += 1;
      return await settle(...args);
    };
    const write = paths.runtime.writeExclusiveDurable;
    let crashBeforeRetirement = true;
    paths.runtime.writeExclusiveDurable = async (path, body, mode) => {
      if (crashBeforeRetirement && path.includes('hosted-restore-rotation.completed.')) {
        throw new Error('test_crash_after_binding_publication');
      }
      return await write(path, body, mode);
    };
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

    await expect(composition.completeOfflineRestoreRotation(proof)).rejects.toThrow('test_crash_after_binding_publication');
    const bindingPath = join(paths.stateDirectory, `hosted-restored-runtime-mount-binding.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`);
    const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
    expect(binding.runtimeMountAdmissionReceipt).toEqual(proof.runtimeMountAdmission);
    expect(binding.runtimeMountAdmissionReceiptSha256).toBe(
      createHash('sha256').update(stableJson(proof.runtimeMountAdmission)).digest('hex')
    );

    const freshProof = {
      ...proof,
      runtimeMountAdmission: { ...proof.runtimeMountAdmission, operationId: 'fresh-operation', admissionEpoch: 'fresh-epoch', signature: 'fresh-signature' },
    };
    await expect(composition.completeOfflineRestoreRotation(freshProof)).rejects.toThrow(
      'hosted_restore_runtime_mount_binding_operation_mismatch'
    );
    expect(settlements).toBe(1);

    crashBeforeRetirement = false;
    await expect(composition.completeOfflineRestoreRotation(proof)).resolves.toBeUndefined();
    expect(settlements).toBe(2);
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain('hosted-restore-journal.v1.json');
  });

  it('recovers a durable runtime binding staging payload after interruption before promotion', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: '6'.repeat(64), restoreGeneration: 6,
      bootId: 'boot_staging_interrupt', eventEpoch: 'epoch_staging_interrupt', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    const proof = {
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
    };
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });
    const bindingName = `hosted-restored-runtime-mount-binding.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`;
    const stagingPath = join(paths.stateDirectory, `${bindingName}.staging`);
    // This is the pre-mutex staging shape from an interrupted prior release.
    // Recovery validates its receipt, retires it under the stable mutex, then
    // creates a fresh stage owned by the retrying publisher.
    await writeFile(stagingPath, JSON.stringify({ runtimeMountAdmissionReceipt: proof.runtimeMountAdmission }));
    await expect(composition.completeOfflineRestoreRotation(proof)).resolves.toBeUndefined();
    await expect(readFile(join(paths.stateDirectory, bindingName), 'utf8')).resolves.toContain(
      proof.runtimeMountAdmission.operationId
    );
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain(`${bindingName}.staging`);
  });

  it('retires a torn runtime binding staging file and rebuilds it without changing the receipt', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: '5'.repeat(64), restoreGeneration: 5,
      bootId: 'boot_torn_staging', eventEpoch: 'epoch_torn_staging', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    const bindingName = `hosted-restored-runtime-mount-binding.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`;
    await writeFile(join(paths.stateDirectory, `${bindingName}.staging`), '{"format":"torn"');
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });
    const proof = {
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
    };

    await expect(composition.completeOfflineRestoreRotation(proof)).resolves.toBeUndefined();
    const binding = JSON.parse(await readFile(join(paths.stateDirectory, bindingName), 'utf8'));
    expect(binding.runtimeMountAdmissionReceipt).toEqual(proof.runtimeMountAdmission);
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain(`${bindingName}.staging`);
  });

  it('serializes concurrent matching publishers into one complete, owned binding', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: 'c'.repeat(64), restoreGeneration: 12,
      bootId: 'boot_concurrent_publish', eventEpoch: 'epoch_concurrent_publish', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    const proof = {
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
    };
    const first = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });
    const second = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

    await expect(Promise.all([
      first.completeOfflineRestoreRotation(proof),
      second.completeOfflineRestoreRotation(proof),
    ])).resolves.toEqual([undefined, undefined]);
    const bindingName = `hosted-restored-runtime-mount-binding.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`;
    const binding = JSON.parse(await readFile(join(paths.stateDirectory, bindingName), 'utf8'));
    expect(binding.runtimeMountAdmissionReceipt).toEqual(proof.runtimeMountAdmission);
    expect(binding.runtimeMountBindingStagingOwner).toMatchObject({
      format: 'hosted-runtime-mount-binding-staging-owner/v1',
      pid: process.pid,
    });
    expect((await readdir(paths.stateDirectory)).filter((entry) => entry.startsWith(`${bindingName}.staging`))).toEqual([]);
  });

  it('rejects B before persisting an intent that would poison A\'s staged recovery', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: '4'.repeat(64), restoreGeneration: 4,
      bootId: 'boot_competing_final', eventEpoch: 'epoch_competing_final', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    const proofA = {
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
    };
    const proofB = {
      ...proofA,
      runtimeMountAdmission: {
        ...proofA.runtimeMountAdmission,
        operationId: 'b-competing-operation', admissionEpoch: 'b-competing-epoch', signature: 'b-competing-signature',
      },
    };
    const bindingName = `hosted-restored-runtime-mount-binding.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`;
    const stagingPath = join(paths.stateDirectory, `${bindingName}.staging.a-staged-operation`);
    await writeFile(stagingPath, JSON.stringify({ runtimeMountAdmissionReceipt: proofA.runtimeMountAdmission }));
    let settlements = 0;
    const settle = paths.runtime.verifyAndSettleRuntimeMountAdmission;
    paths.runtime.verifyAndSettleRuntimeMountAdmission = async (...args) => {
      settlements += 1;
      return await settle(...args);
    };
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

    await expect(composition.completeOfflineRestoreRotation(proofB)).rejects.toThrow(
      'hosted_restore_runtime_mount_binding_staging_operation_mismatch'
    );
    expect(settlements).toBe(0);
    await expect(readFile(stagingPath, 'utf8')).resolves.toContain(proofA.runtimeMountAdmission.operationId);
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain(`${bindingName}.pre-settlement-intent`);
    await expect(composition.completeOfflineRestoreRotation(proofA)).resolves.toBeUndefined();
  });

  it('keeps A\'s matching staged operation durable through B\'s settlement window', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: 'd'.repeat(64), restoreGeneration: 14,
      bootId: 'boot_matching_predecessor', eventEpoch: 'epoch_matching_predecessor', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    const proof = {
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
    };
    const bindingName = `hosted-restored-runtime-mount-binding.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`;
    const predecessor = join(paths.stateDirectory, `${bindingName}.staging.a-crashed-before-settlement`);
    await writeFile(predecessor, JSON.stringify({ runtimeMountAdmissionReceipt: proof.runtimeMountAdmission }));
    const settle = paths.runtime.verifyAndSettleRuntimeMountAdmission;
    paths.runtime.verifyAndSettleRuntimeMountAdmission = async (...args) => {
      // This is the former A-delete/B-settlement gap. If B crashes here, A's
      // receipt must still be the durable operation identity for its retry.
      await expect(readFile(predecessor, 'utf8')).resolves.toContain(proof.runtimeMountAdmission.operationId);
      await expect(readdir(paths.stateDirectory)).resolves.not.toContain(bindingName);
      return await settle(...args);
    };
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

    await expect(composition.completeOfflineRestoreRotation(proof)).resolves.toBeUndefined();
    await expect(readFile(join(paths.stateDirectory, bindingName), 'utf8')).resolves.toContain(proof.runtimeMountAdmission.operationId);
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain(`${bindingName}.staging.a-crashed-before-settlement`);
  });

  it('recovers a torn same-operation O_EXCL intent before settlement', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: 'e'.repeat(64), restoreGeneration: 18,
      bootId: 'boot_torn_intent', eventEpoch: 'epoch_torn_intent', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    const proof = {
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
    };
    const bindingName = `hosted-restored-runtime-mount-binding.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`;
    const intentPath = join(paths.stateDirectory, `${bindingName}.pre-settlement-intent`);
    // This same operation was torn before its complete record could be
    // fsynced, so recovery must recreate the exact receipt rather than adopt
    // incomplete bytes as authority evidence.
    await writeFile(intentPath, `{"runtimeMountAdmissionReceipt":{"operationId":"${proof.runtimeMountAdmission.operationId}"`);
    const settle = paths.runtime.verifyAndSettleRuntimeMountAdmission;
    paths.runtime.verifyAndSettleRuntimeMountAdmission = async (...args) => {
      await expect(readFile(intentPath, 'utf8')).resolves.toContain(proof.runtimeMountAdmission.operationId);
      await expect(readFile(intentPath, 'utf8')).resolves.toContain(proof.runtimeMountAdmission.admissionEpoch);
      return await settle(...args);
    };
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

    await expect(composition.completeOfflineRestoreRotation(proof)).resolves.toBeUndefined();
    await expect(readFile(join(paths.stateDirectory, bindingName), 'utf8')).resolves.toContain(proof.runtimeMountAdmission.operationId);
  });

  it('revalidates a recovered intent directory entry after file fsync before settlement', async () => {
    let interruptAfterFileFsync = true;
    let recoveredIntentFileFsyncs = 0;
    const paths = await fixture({
      state: stateHeader(1),
      onReadAndSyncStage(stage, path) {
        if (stage !== 'file_fsynced_before_directory_fsync' || !path.endsWith('.pre-settlement-intent')) return;
        recoveredIntentFileFsyncs += 1;
        if (interruptAfterFileFsync) {
          interruptAfterFileFsync = false;
          throw new Error('simulated_crash_after_recovered_intent_file_fsync');
        }
      },
    });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: 'a'.repeat(64), restoreGeneration: 17,
      bootId: 'boot_recovered_intent_directory', eventEpoch: 'epoch_recovered_intent_directory', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    const proof = {
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
    };
    const bindingName = `hosted-restored-runtime-mount-binding.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`;
    const intentPath = join(paths.stateDirectory, `${bindingName}.pre-settlement-intent`);
    const settle = paths.runtime.verifyAndSettleRuntimeMountAdmission;
    const read = paths.runtime.readRegularBoundedUtf8;
    let settlements = 0;
    let crashBeforePublication = true;
    paths.runtime.verifyAndSettleRuntimeMountAdmission = async (...args) => {
      settlements += 1;
      return await settle(...args);
    };
    paths.runtime.readRegularBoundedUtf8 = async (path, maximumBytes) => {
      if (crashBeforePublication && settlements === 1 && path.endsWith('hosted-state-header.v1.json')) {
        crashBeforePublication = false;
        throw new Error('simulated_crash_after_initial_settlement');
      }
      return await read(path, maximumBytes);
    };
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

    await expect(composition.completeOfflineRestoreRotation(proof)).rejects.toThrow(
      'simulated_crash_after_initial_settlement'
    );
    await expect(composition.completeOfflineRestoreRotation(proof)).rejects.toThrow(
      'simulated_crash_after_recovered_intent_file_fsync'
    );
    // The interruption is exactly between the recovered file fsync and the
    // directory-entry fsync, so it must not consume a second settlement.
    expect(settlements).toBe(1);
    expect(recoveredIntentFileFsyncs).toBe(1);
    await expect(readFile(intentPath, 'utf8')).resolves.toContain(proof.runtimeMountAdmission.operationId);

    await expect(composition.completeOfflineRestoreRotation(proof)).resolves.toBeUndefined();
    expect(settlements).toBe(2);
    expect(recoveredIntentFileFsyncs).toBe(2);
  });

  it('durably binds A before settlement, rejects B after an A settlement/publication crash, and resumes only A', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: 'f'.repeat(64), restoreGeneration: 16,
      bootId: 'boot_pre_settlement_intent', eventEpoch: 'epoch_pre_settlement_intent', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    const proofA = {
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
    };
    const proofB = {
      ...proofA,
      runtimeMountAdmission: { ...proofA.runtimeMountAdmission, operationId: 'replacement-operation-b', admissionEpoch: 'replacement-epoch-b' },
    };
    const bindingName = `hosted-restored-runtime-mount-binding.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`;
    const intentPath = join(paths.stateDirectory, `${bindingName}.pre-settlement-intent`);
    const settle = paths.runtime.verifyAndSettleRuntimeMountAdmission;
    const read = paths.runtime.readRegularBoundedUtf8;
    const syncIntent = paths.runtime.readAndSyncRegularBoundedUtf8;
    let settlements = 0;
    let recoveredIntentSyncs = 0;
    let crashBeforePublication = true;
    paths.runtime.verifyAndSettleRuntimeMountAdmission = async (...args) => {
      if (settlements > 0) expect(recoveredIntentSyncs).toBeGreaterThan(0);
      settlements += 1;
      return await settle(...args);
    };
    paths.runtime.readAndSyncRegularBoundedUtf8 = async (path, maximumBytes) => {
      if (path === intentPath) recoveredIntentSyncs += 1;
      return await syncIntent(path, maximumBytes);
    };
    paths.runtime.readRegularBoundedUtf8 = async (path, maximumBytes) => {
      if (crashBeforePublication && settlements === 1 && path.endsWith('hosted-state-header.v1.json')) {
        crashBeforePublication = false;
        throw new Error('simulated_crash_after_a_settlement_before_publication');
      }
      return await read(path, maximumBytes);
    };
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

    await expect(composition.completeOfflineRestoreRotation(proofA)).rejects.toThrow(
      'simulated_crash_after_a_settlement_before_publication'
    );
    await expect(readFile(intentPath, 'utf8')).resolves.toContain(proofA.runtimeMountAdmission.operationId);
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain(bindingName);

    await expect(composition.completeOfflineRestoreRotation(proofB)).rejects.toThrow(
      'hosted_restore_runtime_mount_binding_pre_settlement_intent_mismatch'
    );
    expect(settlements).toBe(1);

    // Discard B's rejected recovery probe. The following assertion in the
    // settlement seam must be satisfied by A's matching recovered intent.
    recoveredIntentSyncs = 0;
    await expect(composition.completeOfflineRestoreRotation(proofA)).resolves.toBeUndefined();
    expect(settlements).toBe(2);
    expect(recoveredIntentSyncs).toBeGreaterThan(0);
    await expect(readFile(join(paths.stateDirectory, bindingName), 'utf8')).resolves.toContain(proofA.runtimeMountAdmission.operationId);
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain(`${bindingName}.pre-settlement-intent`);
  });

  it('keeps the binding mutex alive when the publisher process title contains spaces and parentheses', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: 'e'.repeat(64), restoreGeneration: 15,
      bootId: 'boot_title_spaces', eventEpoch: 'epoch_title_spaces', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    const priorTitle = process.title;
    process.title = 'phase ten (title)';
    try {
      const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });
      await expect(composition.completeOfflineRestoreRotation({
        deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
        bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
      })).resolves.toBeUndefined();
    } finally {
      process.title = priorTitle;
    }
  });

  it('rejects a settlement whose asserted receipt digest was not atomically verified', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: '8'.repeat(64), restoreGeneration: 8,
      bootId: 'boot_digest_substitution', eventEpoch: 'epoch_digest_substitution', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    const settle = paths.runtime.verifyAndSettleRuntimeMountAdmission;
    paths.runtime.verifyAndSettleRuntimeMountAdmission = async (...args) => ({
      ...(await settle(...args)), receiptSha256: '0'.repeat(64),
    });
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

    await expect(composition.completeOfflineRestoreRotation({
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
    })).rejects.toThrow('hosted_restore_runtime_mount_admission_invalid');
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain(
      `hosted-restored-runtime-mount-binding.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`
    );
  });

  it.each(['identity.key', 'csrfKey', 'hashKey', 'keyring data'] as const)(
    'rejects a substituted completed-journal secret (%s) before binding publication',
    async (kind) => {
      const paths = await fixture({ state: stateHeader(1) });
      const request = {
        format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
        deploymentId: 'deployment-fixture', sourceManifestHash: 'a'.repeat(64), restoreGeneration: 10,
        bootId: 'boot_secret_substitution', eventEpoch: 'epoch_secret_substitution', browserAuthorityRotated: true as const,
        runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
      };
      await writeFile(
        join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`),
        JSON.stringify(request)
      );
      await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
      await publishFreshRuntimeAuthority(paths, request);
      const secretsDirectory = join(paths.stateDirectory, 'hosted-auth-secrets');
      if (kind === 'identity.key') {
        await writeFile(join(secretsDirectory, kind), `${'z'.repeat(32)}\n`);
      } else {
        const keyring = JSON.parse(await readFile(join(secretsDirectory, 'personal-keyring.json'), 'utf8')) as Record<string, unknown>;
        keyring[kind === 'keyring data' ? 'unexpected' : kind] = 'substituted';
        await writeFile(join(secretsDirectory, 'personal-keyring.json'), `${stableJson(keyring)}\n`);
      }
      let settlements = 0;
      const settle = paths.runtime.verifyAndSettleRuntimeMountAdmission;
      paths.runtime.verifyAndSettleRuntimeMountAdmission = async (...args) => {
        settlements += 1;
        return await settle(...args);
      };
      const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

      await expect(composition.completeOfflineRestoreRotation({
        deploymentId: request.deploymentId,
        restoreGeneration: request.restoreGeneration,
        bootId: request.bootId,
        eventEpoch: request.eventEpoch,
        runtimeMountAdmission: runtimeMountAdmission(request),
      })).rejects.toThrow('hosted_restore_runtime_mount_binding_invalid');
      expect(settlements).toBe(0);
      await expect(readdir(paths.stateDirectory)).resolves.not.toContain(
        `hosted-restored-runtime-mount-binding.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`
      );
      await expect(readFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), 'utf8')).resolves.toContain('"phase":"completed"');
    }
  );

  it('rejects an unexpected hosted auth secret before runtime binding publication', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: 'b'.repeat(64), restoreGeneration: 11,
      bootId: 'boot_secret_inventory', eventEpoch: 'epoch_secret_inventory', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    await writeFile(join(paths.stateDirectory, 'hosted-auth-secrets', 'unexpected.secret'), 'unexpected\n');
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

    await expect(composition.completeOfflineRestoreRotation({
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch, runtimeMountAdmission: runtimeMountAdmission(request),
    })).rejects.toThrow('hosted_restore_runtime_mount_binding_invalid');
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain(
      `hosted-restored-runtime-mount-binding.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`
    );
  });

  it('rejects controller-style boolean rotation claims without an authority receipt', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const,
      schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: '9'.repeat(64), restoreGeneration: 9,
      bootId: 'boot_boolean_claim', eventEpoch: 'epoch_boolean_claim', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    await publishFreshRuntimeAuthority(paths, request);
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

    await expect(composition.completeOfflineRestoreRotation({
      deploymentId: request.deploymentId, restoreGeneration: request.restoreGeneration,
      bootId: request.bootId, eventEpoch: request.eventEpoch,
      browserSessionsRevoked: true, runtimeAuthorityRotated: true, mountBindingsRotated: true,
    } as unknown as Parameters<typeof composition.completeOfflineRestoreRotation>[0])).rejects.toThrow(
      'hosted_restore_rotation_proof_invalid'
    );
    await expect(composition.admitBeforeListenerExposure()).rejects.toMatchObject({
      diagnostic: 'offline_restore_rotation_pending',
    });
  });

  it('selects the journal-bound scoped marker, not an older marker with a higher directory order', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const current = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: 'c'.repeat(64), restoreGeneration: 2,
      bootId: 'boot_current', eventEpoch: 'epoch_current', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    const historical = { ...current, sourceManifestHash: 'd'.repeat(64), restoreGeneration: 99, bootId: 'boot_old', eventEpoch: 'epoch_old' };
    for (const request of [historical, current]) {
      await writeFile(
        join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`),
        JSON.stringify(request)
      );
    }
    await writeFile(
      join(paths.stateDirectory, `hosted-restore-rotation.completed.v1.${historical.sourceManifestHash}.g-${historical.restoreGeneration}.json`),
      JSON.stringify(historical)
    );
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(current)));
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });
    await expect(composition.inspectPendingOfflineRestoreRotation()).resolves.toEqual(current);
    await expect(composition.admitBeforeListenerExposure()).rejects.toMatchObject({ diagnostic: 'offline_restore_rotation_pending' });
  });

  it('retires verified historical pending markers before journal removal across two restores', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const first = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: '1'.repeat(64), restoreGeneration: 1,
      bootId: 'boot_first', eventEpoch: 'epoch_first', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    const second = {
      ...first, sourceManifestHash: '2'.repeat(64), restoreGeneration: 2,
      bootId: 'boot_second', eventEpoch: 'epoch_second',
    };
    const rotationPath = (request: typeof first) => join(
      paths.stateDirectory,
      `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`
    );
    const completionPath = (request: typeof first) => join(
      paths.stateDirectory,
      `hosted-restore-rotation.completed.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`
    );
    // First completion was durable, but a crash preserved its pending marker.
    await writeFile(rotationPath(first), JSON.stringify(first));
    await writeFile(completionPath(first), JSON.stringify(first));
    await writeFile(rotationPath(second), JSON.stringify(second));
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(second)));
    await publishFreshRuntimeAuthority(paths, second);
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });

    await expect(composition.completeOfflineRestoreRotation({
      deploymentId: second.deploymentId,
      restoreGeneration: second.restoreGeneration,
      bootId: second.bootId,
      eventEpoch: second.eventEpoch,
      runtimeMountAdmission: runtimeMountAdmission(second),
    })).resolves.toBeUndefined();
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain(
      `hosted-restore-rotation.v1.${first.sourceManifestHash}.g-${first.restoreGeneration}.json`
    );
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain('hosted-restore-journal.v1.json');
    await expect(composition.admitBeforeListenerExposure()).resolves.toMatchObject({ status: 'read_write' });
  });

  it('rejects a superseded pending marker that has no matching completion record', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const active = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: 'f'.repeat(64), restoreGeneration: 7,
      bootId: 'boot_active', eventEpoch: 'epoch_active', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    const stale = { ...active, sourceManifestHash: 'e'.repeat(64), restoreGeneration: 6, bootId: 'boot_stale', eventEpoch: 'epoch_stale' };
    for (const request of [stale, active]) {
      await writeFile(
        join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`),
        JSON.stringify(request)
      );
    }
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(active)));
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });
    await expect(composition.inspectPendingOfflineRestoreRotation()).rejects.toThrow(
      'hosted_restore_rotation_superseded_pending_unretired'
    );
  });

  it('fails closed for an unbound legacy marker rather than treating pending rotation as absent', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    await writeFile(join(paths.stateDirectory, 'hosted-restore-rotation.v1.json'), JSON.stringify({
      format: 'hosted-restored-authority-rotation/v1', schemaVersion: 1, deploymentId: 'deployment-fixture',
      restoreGeneration: 1, bootId: 'legacy', eventEpoch: 'legacy', browserAuthorityRotated: true,
      runtimeAuthorityRotationRequired: true, freshMountBindingsRequired: true,
    }));
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });
    await expect(composition.inspectPendingOfflineRestoreRotation()).rejects.toThrow('hosted_restore_rotation_legacy_binding_invalid');
    await expect(composition.admitBeforeListenerExposure()).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
  });

  it('rejects mixed legacy and generation-scoped marker formats before selection', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: '9'.repeat(64), restoreGeneration: 9,
      bootId: 'boot_mixed', eventEpoch: 'epoch_mixed', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(join(paths.stateDirectory, 'hosted-restore-rotation.v1.json'), JSON.stringify(request));
    await writeFile(
      join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`),
      JSON.stringify(request)
    );
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });
    await expect(composition.inspectPendingOfflineRestoreRotation()).rejects.toThrow(
      'hosted_restore_rotation_mixed_marker_format'
    );
  });

  it('rejects a valid scoped marker copied under another generation filename', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture', sourceManifestHash: 'e'.repeat(64), restoreGeneration: 4,
      bootId: 'bound', eventEpoch: 'bound', browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
    };
    await writeFile(
      join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-5.json`),
      JSON.stringify(request)
    );
    await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(completedRestoreJournal(request)));
    const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });
    await expect(composition.inspectPendingOfflineRestoreRotation()).rejects.toThrow('hosted_restore_rotation_scoped_filename_invalid');
  });

  it.each(['missing authority', 'marker-only authority', 'substituted database family'] as const)(
    'rejects a completed journal with %s before production admission',
    async (kind) => {
      const paths = await fixture({ state: stateHeader(1) });
      const request = {
        format: 'hosted-restored-authority-rotation/v1' as const, schemaVersion: 1 as const,
        deploymentId: 'deployment-fixture', sourceManifestHash: 'c'.repeat(64), restoreGeneration: 12,
        bootId: 'boot_sqlite_authority', eventEpoch: 'epoch_sqlite_authority', browserAuthorityRotated: true as const,
        runtimeAuthorityRotationRequired: true as const, freshMountBindingsRequired: true as const,
      };
      const journal = structuredClone(completedRestoreJournal(request)) as Record<string, unknown>;
      if (kind === 'missing authority') delete journal.sqliteAuthority;
      if (kind === 'marker-only authority') journal.sqliteAuthority = { format: 'hosted-stopped-stack-sqlite-authority/v1', schemaVersion: 1 };
      if (kind === 'substituted database family') {
        const authority = journal.sqliteAuthority as { postRotation: { databaseFamily: unknown[] } };
        authority.postRotation.databaseFamily = [{ path: 'data/storage/app.db', byteLength: 1, mode: 0o600, sha256: 'a'.repeat(64) }];
      }
      await writeFile(join(paths.stateDirectory, `hosted-restore-rotation.v1.${request.sourceManifestHash}.g-${request.restoreGeneration}.json`), JSON.stringify(request));
      await writeFile(join(paths.stateDirectory, 'hosted-restore-journal.v1.json'), JSON.stringify(journal));
      const composition = createHostedStateCompatibilityAdmission({ ...paths, expectedDeploymentId: 'deployment-fixture' });
      await expect(composition.inspectPendingOfflineRestoreRotation()).rejects.toThrow('hosted_restore_rotation_journal_invalid');
    }
  );
});

import {
  AdmitOfflineRestore,
  type AdmitOfflineRestoreDependencies,
  createRestoreSetIdentity,
  EvaluateHostedStateStartup,
  type EvaluateHostedStateStartupDependencies,
} from '@features/hosted-state-compatibility';

import {
  archiveReadModel,
  artifactEnvelope,
  backupManifest,
  checksum,
  coordinationSnapshot,
  migrationJournal,
  stateHeader,
} from './fixtures';

import type { ImmutableBackupVerification } from '@features/coordination-backup';

function startupDependencies(
  overrides: Partial<EvaluateHostedStateStartupDependencies> = {}
): EvaluateHostedStateStartupDependencies {
  return {
    artifactManifestReader: { readBuiltArtifactManifest: async () => artifactEnvelope() },
    artifactIntegrityProbe: { verify: async () => ({ status: 'verified' }) },
    stateHeaderReader: { readStateHeader: async () => stateHeader(1) },
    migrationJournalReader: { readMigrationJournal: async () => null },
    ...overrides,
  };
}

function immutableVerification(): ImmutableBackupVerification {
  return {
    status: 'verified',
    inspection: {
      manifest: backupManifest(),
      measuredEntries: [checksum()],
    } as never,
  };
}

function restoreDependencies(
  overrides: Partial<AdmitOfflineRestoreDependencies> = {}
): AdmitOfflineRestoreDependencies {
  return {
    artifactManifestReader: { readBuiltArtifactManifest: async () => artifactEnvelope() },
    artifactIntegrityProbe: { verify: async () => ({ status: 'verified' }) },
    archiveReader: { readArchive: async () => archiveReadModel() },
    archiveIntegrityProbe: { verify: async () => immutableVerification() },
    controllerStateProbe: { inspectControllerState: async () => 'stopped' },
    targetProbe: { inspectTarget: async () => 'empty' },
    ...overrides,
  };
}

describe('EvaluateHostedStateStartup', () => {
  it('reads only through ports and returns migration admission', async () => {
    const useCase = new EvaluateHostedStateStartup(startupDependencies());

    await expect(useCase.execute()).resolves.toMatchObject({
      status: 'migration_required',
      fromVersion: 1,
      toVersion: 2,
    });
  });

  it('fails closed when the built artifact integrity probe rejects the manifest', async () => {
    const useCase = new EvaluateHostedStateStartup(
      startupDependencies({
        artifactIntegrityProbe: {
          verify: async () => ({ status: 'invalid', reason: 'manifest-hash-mismatch' }),
        },
      })
    );

    await expect(useCase.execute()).resolves.toEqual({
      status: 'refused',
      reason: 'artifact_manifest_integrity_failed',
    });
  });

  it('surfaces interrupted migration recovery without invoking a writer', async () => {
    const useCase = new EvaluateHostedStateStartup(
      startupDependencies({
        migrationJournalReader: {
          readMigrationJournal: async () => migrationJournal(),
        },
      })
    );

    await expect(useCase.execute()).resolves.toMatchObject({
      status: 'migration_recovery_required',
      recovery: 'resume_idempotently',
    });
  });
});

describe('AdmitOfflineRestore', () => {
  it('projects public backup/snapshot contracts into an admitted restore identity', async () => {
    const manifest = backupManifest();
    const snapshot = coordinationSnapshot();
    const useCase = new AdmitOfflineRestore(restoreDependencies());

    const result = await useCase.execute({
      archiveRef: 'archive-fixture',
      mode: 'replace_deployment',
      sourceOfflineAttested: true,
      expectedRestoreSet: createRestoreSetIdentity(manifest, snapshot),
    });

    expect(result).toMatchObject({ status: 'admitted' });
  });

  it('refuses checksum mismatch returned through the integrity probe', async () => {
    const verification = immutableVerification();
    if (verification.status !== 'verified') throw new Error('fixture-invalid');
    const useCase = new AdmitOfflineRestore(
      restoreDependencies({
        archiveIntegrityProbe: {
          verify: async () => ({
            ...verification,
            inspection: {
              ...verification.inspection,
              measuredEntries: [checksum({ byteLength: 1 })],
            },
          }),
        },
      })
    );

    const result = await useCase.execute({
      archiveRef: 'archive-fixture',
      mode: 'replace_deployment',
      sourceOfflineAttested: true,
      expectedRestoreSet: createRestoreSetIdentity(backupManifest(), coordinationSnapshot()),
    });

    expect(result).toEqual({ status: 'refused', reasons: ['archive_checksum_mismatch'] });
  });

  it('refuses a snapshot from another event topology', async () => {
    const useCase = new AdmitOfflineRestore(
      restoreDependencies({
        archiveReader: {
          readArchive: async () => ({
            ...archiveReadModel(),
            snapshotMetadata: coordinationSnapshot({ eventEpoch: 'another-epoch' }),
          }),
        },
      })
    );

    const result = await useCase.execute({
      archiveRef: 'archive-fixture',
      mode: 'replace_deployment',
      sourceOfflineAttested: true,
      expectedRestoreSet: createRestoreSetIdentity(
        backupManifest(),
        coordinationSnapshot({ eventEpoch: 'another-epoch' })
      ),
    });

    expect(result).toEqual({ status: 'refused', reasons: ['snapshot_topology_mismatch'] });
  });

  it('refuses before restore when the target is not empty', async () => {
    const useCase = new AdmitOfflineRestore(
      restoreDependencies({ targetProbe: { inspectTarget: async () => 'non_empty' } })
    );

    const result = await useCase.execute({
      archiveRef: 'archive-fixture',
      mode: 'replace_deployment',
      sourceOfflineAttested: true,
      expectedRestoreSet: createRestoreSetIdentity(backupManifest(), coordinationSnapshot()),
    });

    expect(result).toEqual({ status: 'refused', reasons: ['target_not_empty'] });
  });

  it('refuses a missing or partial archive with other independent preflight faults', async () => {
    const useCase = new AdmitOfflineRestore(
      restoreDependencies({
        archiveReader: { readArchive: async () => null },
        controllerStateProbe: { inspectControllerState: async () => 'running' },
      })
    );

    const result = await useCase.execute({
      archiveRef: 'missing-archive',
      mode: 'fork_deployment',
      sourceOfflineAttested: false,
      expectedRestoreSet: createRestoreSetIdentity(backupManifest(), coordinationSnapshot()),
    });

    expect(result).toEqual({
      status: 'refused',
      reasons: [
        'archive_incomplete',
        'restore_mode_unsupported',
        'controller_not_stopped',
        'source_offline_not_attested',
      ],
    });
  });
});

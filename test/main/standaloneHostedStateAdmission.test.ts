import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createInitialAuthorityState,
  parseAuthKeyringId,
  parseAuthorityDeploymentId,
} from '@features/hosted-access';
import { attestOidcPreHeaderState } from '@features/hosted-state-compatibility/main/infrastructure/attestOidcPreHeaderState';
import {
  INTERNAL_STORAGE_APPLICATION_ID,
  INTERNAL_STORAGE_SCHEMA_VERSION,
} from '@features/internal-storage/main';
import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import { admitStandaloneHostedState } from '@main/standaloneHostedStateAdmission';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createReleasedInternalStorageSchema } from '../features/internal-storage/fixtures/releasedInternalStorageSchema';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'standalone-state-admission-'));
  roots.push(root);
  const builtServerDirectory = join(root, 'built');
  const stateDirectory = join(root, 'data');
  await mkdir(builtServerDirectory);
  await mkdir(stateDirectory);
  const output = join(builtServerDirectory, 'state-compatibility', 'manifest.json');
  const generated = spawnSync(process.execPath, [
    'scripts/hosted-web/phase-10/state-compatibility/generate-built-manifest.mjs',
    '--output',
    output,
  ]);
  expect(generated.status, generated.stderr.toString()).toBe(0);
  const environment = { AUTH_DEPLOYMENT_ID: 'deployment_synthetic', AUTH_RESTORE_GENERATION: '0' };
  return { builtServerDirectory, stateDirectory, environment, output };
}

async function preHeaderDatabase(
  stateDirectory: string,
  version: 30 | 31,
  mode: 'personal' | 'oidc',
  binding = { deploymentId: 'deployment_synthetic', restoreGeneration: 0 },
  walMode = false
): Promise<string> {
  const storage = join(stateDirectory, 'storage');
  await mkdir(storage);
  const path = join(storage, 'app.db');
  const database = new Database(path);
  try {
    createReleasedInternalStorageSchema(database, version);
    database.pragma(`application_id = ${INTERNAL_STORAGE_APPLICATION_ID}`);
    database
      .prepare(
        'INSERT INTO hosted_auth_configuration (singleton, auth_mode, configured_at) VALUES (1, ?, 1)'
      )
      .run(mode);
    if (mode === 'personal') {
      database
        .prepare(
          `INSERT INTO hosted_access_authority
        (singleton, state_json, revision, rollback_fence_revision) VALUES (1, ?, 0, 0)`
        )
        .run(
          JSON.stringify(
            createInitialAuthorityState({
              binding: {
                ...binding,
                deploymentId: parseAuthorityDeploymentId(binding.deploymentId),
              },
              keyringId: parseAuthKeyringId('akr_synthetic0001'),
            })
          )
        );
    }
    if (walMode) database.pragma('journal_mode = WAL');
  } finally {
    database.close();
  }
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('standalone hosted state admission', () => {
  it('resumes a marker-only crash with the bound deployment and clears the marker durably', async () => {
    const input = await fixture();
    const first = await admitStandaloneHostedState(
      input.environment, input.builtServerDirectory, input.stateDirectory, true);
    expect(first.pendingCanonicalFirstBoot).toBe(true);
    const withHeader = await admitStandaloneHostedState(
      input.environment, input.builtServerDirectory, input.stateDirectory, true);
    expect(withHeader.pendingCanonicalFirstBoot).toBe(true);
    await expect(admitStandaloneHostedState(
      { ...input.environment, AUTH_RESTORE_GENERATION: '1' },
      input.builtServerDirectory, input.stateDirectory, true
    )).rejects.toThrow('hosted_canonical_first_boot_marker_invalid');
    // This is the on-disk state if the process stopped after the marker sync and before header publication.
    await unlink(join(input.stateDirectory, 'hosted-state-header.v1.json'));
    const recovered = await admitStandaloneHostedState(
      input.environment, input.builtServerDirectory, input.stateDirectory, true);
    expect(recovered.pendingCanonicalFirstBoot).toBe(true);
    await recovered.completeCanonicalFirstBoot();
    const established = await admitStandaloneHostedState(
      input.environment, input.builtServerDirectory, input.stateDirectory, true);
    expect(established.pendingCanonicalFirstBoot).toBe(false);
    expect(await readdir(input.stateDirectory)).toEqual(['hosted-state-header.v1.json']);
  });

  it('initializes fresh state once and admits the same existing state on restart', async () => {
    const input = await fixture();
    await admitStandaloneHostedState(
      input.environment,
      input.builtServerDirectory,
      input.stateDirectory
    );
    const headerPath = join(input.stateDirectory, 'hosted-state-header.v1.json');
    const initial = await readFile(headerPath, 'utf8');
    expect(JSON.parse(initial)).toEqual({
      format: 'hosted-state-header/v1',
      schemaVersion: 1,
      deploymentId: 'deployment_synthetic',
      hostedStateSchemaVersion: 1,
    });
    await admitStandaloneHostedState(
      input.environment,
      input.builtServerDirectory,
      input.stateDirectory
    );
    expect(await readFile(headerPath, 'utf8')).toBe(initial);
  });

  it('refuses an existing state with no header and does not rewrite it', async () => {
    const input = await fixture();
    await writeFile(join(input.stateDirectory, 'storage'), 'persisted bytes');
    await expect(
      admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      )
    ).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
    expect(await readdir(input.stateDirectory)).toEqual(['storage']);
  });

  it('initializes a pre-header deployment only from its intact matching authority database', async () => {
    const input = await fixture();
    await preHeaderDatabase(input.stateDirectory, 30, 'personal');
    await admitStandaloneHostedState(
      input.environment,
      input.builtServerDirectory,
      input.stateDirectory
    );
    expect(
      JSON.parse(await readFile(join(input.stateDirectory, 'hosted-state-header.v1.json'), 'utf8'))
    ).toMatchObject({ deploymentId: 'deployment_synthetic', hostedStateSchemaVersion: 1 });
    const database = new Database(join(input.stateDirectory, 'storage', 'app.db'));
    try {
      expect(database.pragma('user_version', { simple: true })).toBe(30);
      runInternalStorageMigrations(database);
      expect(database.pragma('user_version', { simple: true })).toBe(
        INTERNAL_STORAGE_SCHEMA_VERSION
      );
    } finally {
      database.close();
    }
  });

  it('refuses a foreign pre-header authority without writing a header', async () => {
    const input = await fixture();
    await preHeaderDatabase(input.stateDirectory, 30, 'personal', {
      deploymentId: 'deployment_other0001',
      restoreGeneration: 0,
    });
    await expect(
      admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      )
    ).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
    expect(await readdir(input.stateDirectory)).toEqual(['storage']);
  });

  it('refuses a pre-header authority from another restore generation', async () => {
    const input = await fixture();
    await preHeaderDatabase(input.stateDirectory, 31, 'personal', {
      deploymentId: 'deployment_synthetic',
      restoreGeneration: 1,
    });
    await expect(
      admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      )
    ).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
    expect(await readdir(input.stateDirectory)).toEqual(['storage']);
  });

  it.each([30, 31] as const)(
    'requires explicit matching offline attestation for OIDC v%i pre-header state',
    async (version) => {
      const input = await fixture();
      const databasePath = await preHeaderDatabase(input.stateDirectory, version, 'oidc');
      await expect(
        admitStandaloneHostedState(
          input.environment,
          input.builtServerDirectory,
          input.stateDirectory
        )
      ).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
      expect(await readdir(input.stateDirectory)).toEqual(['storage']);
      const digest = createHash('sha256')
        .update(await readFile(databasePath))
        .digest('hex');
      await expect(
        attestOidcPreHeaderState({
          stateDirectory: input.stateDirectory,
          deploymentId: 'deployment_synthetic',
          restoreGeneration: 0,
          expectedDatabaseSha256: '0'.repeat(64),
        })
      ).rejects.toThrow('hosted_preheader_attestation_digest_mismatch');
      if (version === 30) {
        const result = spawnSync(process.execPath, [
          '--import',
          'tsx',
          'scripts/hosted-web/phase-10/state-compatibility/attest-oidc-preheader.mjs',
          '--state-directory',
          input.stateDirectory,
          '--deployment-id',
          'deployment_synthetic',
          '--restore-generation',
          '0',
          '--database-sha256',
          digest,
          '--confirm-stopped',
          'yes',
        ]);
        expect(result.status, result.stderr.toString()).toBe(0);
      } else {
        await attestOidcPreHeaderState({
          stateDirectory: input.stateDirectory,
          deploymentId: 'deployment_synthetic',
          restoreGeneration: 0,
          expectedDatabaseSha256: digest,
        });
      }
      await admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      );
      expect(
        JSON.parse(
          await readFile(join(input.stateDirectory, 'hosted-state-header.v1.json'), 'utf8')
        )
      ).toMatchObject({ deploymentId: 'deployment_synthetic', hostedStateSchemaVersion: 1 });
    }
  );

  it.each([30, 31] as const)(
    'attests and admits cleanly shut down WAL-mode OIDC v%i without creating sidecars',
    async (version) => {
      const input = await fixture();
      const databasePath = await preHeaderDatabase(
        input.stateDirectory,
        version,
        'oidc',
        undefined,
        true
      );
      const storagePath = join(input.stateDirectory, 'storage');
      expect(await readdir(storagePath)).toEqual(['app.db']);
      const before = await readFile(databasePath);
      expect([...before.subarray(18, 20)]).toEqual([2, 2]);
      await attestOidcPreHeaderState({
        stateDirectory: input.stateDirectory,
        deploymentId: 'deployment_synthetic',
        restoreGeneration: 0,
        expectedDatabaseSha256: createHash('sha256').update(before).digest('hex'),
      });
      expect(await readdir(storagePath)).toEqual(['app.db']);
      expect(await readFile(databasePath)).toEqual(before);
      await admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      );
      expect(await readdir(storagePath)).toEqual(['app.db']);
      expect(await readFile(databasePath)).toEqual(before);
      expect(await readdir(input.stateDirectory)).toContain('hosted-state-header.v1.json');
    }
  );

  it('refuses pre-existing uncheckpointed WAL bytes before attestation or admission', async () => {
    const input = await fixture();
    const databasePath = await preHeaderDatabase(input.stateDirectory, 31, 'oidc', undefined, true);
    const storagePath = join(input.stateDirectory, 'storage');
    const writer = new Database(databasePath);
    try {
      writer.prepare('UPDATE hosted_auth_configuration SET configured_at = 2').run();
      expect(await readdir(storagePath)).toEqual(
        expect.arrayContaining(['app.db-wal', 'app.db-shm'])
      );
      await expect(
        attestOidcPreHeaderState({
          stateDirectory: input.stateDirectory,
          deploymentId: 'deployment_synthetic',
          restoreGeneration: 0,
          expectedDatabaseSha256: createHash('sha256')
            .update(await readFile(databasePath))
            .digest('hex'),
        })
      ).rejects.toThrow('hosted_preheader_attestation_database_not_quiescent');
      expect(await readdir(input.stateDirectory)).toEqual(['storage']);
      expect(await readdir(storagePath)).toEqual(
        expect.arrayContaining(['app.db-wal', 'app.db-shm'])
      );
    } finally {
      writer.close();
    }
    const attestedDigest = createHash('sha256')
      .update(await readFile(databasePath))
      .digest('hex');
    await attestOidcPreHeaderState({
      stateDirectory: input.stateDirectory,
      deploymentId: 'deployment_synthetic',
      restoreGeneration: 0,
      expectedDatabaseSha256: attestedDigest,
    });
    const secondWriter = new Database(databasePath);
    try {
      secondWriter.prepare('UPDATE hosted_auth_configuration SET configured_at = 3').run();
      expect(await readdir(storagePath)).toEqual(
        expect.arrayContaining(['app.db-wal', 'app.db-shm'])
      );
      expect(
        createHash('sha256')
          .update(await readFile(databasePath))
          .digest('hex')
      ).toBe(attestedDigest);
      await expect(
        admitStandaloneHostedState(
          input.environment,
          input.builtServerDirectory,
          input.stateDirectory
        )
      ).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
      expect(await readdir(input.stateDirectory)).not.toContain('hosted-state-header.v1.json');
      expect(await readdir(storagePath)).toEqual(
        expect.arrayContaining(['app.db-wal', 'app.db-shm'])
      );
    } finally {
      secondWriter.close();
    }
  });

  it.each([30, 31] as const)(
    'admits cleanly shut down WAL-mode personal v%i and refuses its live sidecar',
    async (version) => {
      const input = await fixture();
      const databasePath = await preHeaderDatabase(
        input.stateDirectory,
        version,
        'personal',
        undefined,
        true
      );
      const writer = new Database(databasePath);
      try {
        writer.prepare('UPDATE hosted_auth_configuration SET configured_at = 2').run();
        await expect(
          admitStandaloneHostedState(
            input.environment,
            input.builtServerDirectory,
            input.stateDirectory
          )
        ).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
      } finally {
        writer.close();
      }
      expect(await readdir(join(input.stateDirectory, 'storage'))).toEqual(['app.db']);
      await admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      );
      expect(await readdir(join(input.stateDirectory, 'storage'))).toEqual(['app.db']);
    }
  );

  it('rejects a copied OIDC attestation for a different database or binding', async () => {
    const input = await fixture();
    const databasePath = await preHeaderDatabase(input.stateDirectory, 31, 'oidc');
    const digest = createHash('sha256')
      .update(await readFile(databasePath))
      .digest('hex');
    await attestOidcPreHeaderState({
      stateDirectory: input.stateDirectory,
      deploymentId: 'deployment_other',
      restoreGeneration: 0,
      expectedDatabaseSha256: digest,
    });
    await expect(
      admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      )
    ).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
    const proofPath = join(input.stateDirectory, 'hosted-preheader-oidc-attestation.v1.json');
    await writeFile(
      proofPath,
      JSON.stringify({
        format: 'hosted-preheader-oidc-attestation/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_synthetic',
        restoreGeneration: 1,
        databaseSha256: digest,
      })
    );
    await expect(
      admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      )
    ).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
    await writeFile(
      proofPath,
      JSON.stringify({
        format: 'hosted-preheader-oidc-attestation/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_synthetic',
        restoreGeneration: 0,
        databaseSha256: '0'.repeat(64),
      })
    );
    await expect(
      admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      )
    ).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
  });

  it('keeps restored OIDC state pending after valid pre-header attestation', async () => {
    const input = await fixture();
    const databasePath = await preHeaderDatabase(input.stateDirectory, 31, 'oidc');
    await attestOidcPreHeaderState({
      stateDirectory: input.stateDirectory,
      deploymentId: 'deployment_synthetic',
      restoreGeneration: 0,
      expectedDatabaseSha256: createHash('sha256')
        .update(await readFile(databasePath))
        .digest('hex'),
    });
    await writeFile(
      join(input.stateDirectory, 'hosted-restore-rotation.v1.json'),
      JSON.stringify({
        format: 'hosted-restored-authority-rotation/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_synthetic',
        restoreGeneration: 1,
        bootId: 'boot_synthetic',
        eventEpoch: 'epoch_synthetic',
        browserAuthorityRotated: true,
        runtimeAuthorityRotationRequired: true,
        freshMountBindingsRequired: true,
      })
    );
    await expect(
      admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      )
    ).rejects.toMatchObject({ diagnostic: 'offline_restore_rotation_pending' });
  });

  it('rejects future pre-header SQLite state even with matching personal binding', async () => {
    const input = await fixture();
    const path = await preHeaderDatabase(input.stateDirectory, 31, 'personal');
    const database = new Database(path);
    database.pragma(`user_version = ${INTERNAL_STORAGE_SCHEMA_VERSION + 1}`);
    database.close();
    await expect(
      admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      )
    ).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
  });

  it('rejects a damaged manifest before state initialization', async () => {
    const input = await fixture();
    await writeFile(input.output, `${await readFile(input.output, 'utf8')} `);
    await expect(
      admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      )
    ).rejects.toMatchObject({ diagnostic: 'artifact_manifest_integrity_failed' });
    expect(await readdir(input.stateDirectory)).toEqual([]);
  });

  it('holds a restored state before storage and listener startup when rotation proof is unavailable', async () => {
    const input = await fixture();
    await admitStandaloneHostedState(
      input.environment,
      input.builtServerDirectory,
      input.stateDirectory
    );
    await writeFile(
      join(input.stateDirectory, 'hosted-restore-rotation.v1.json'),
      JSON.stringify({
        format: 'hosted-restored-authority-rotation/v1',
        schemaVersion: 1,
        deploymentId: 'deployment_synthetic',
        restoreGeneration: 1,
        bootId: 'boot_synthetic',
        eventEpoch: 'epoch_synthetic',
        browserAuthorityRotated: true,
        runtimeAuthorityRotationRequired: true,
        freshMountBindingsRequired: true,
      })
    );
    await expect(
      admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      )
    ).rejects.toMatchObject({ diagnostic: 'offline_restore_rotation_pending' });
    expect(await readdir(input.stateDirectory)).toContain('hosted-restore-rotation.v1.json');
  });

  it('refuses an interrupted restore journal with its rotation marker missing', async () => {
    const input = await fixture();
    await admitStandaloneHostedState(
      input.environment,
      input.builtServerDirectory,
      input.stateDirectory
    );
    await writeFile(join(input.stateDirectory, 'hosted-restore-journal.v1.json'), '{}');
    await expect(
      admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      )
    ).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
  });
});

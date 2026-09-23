import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  INTERNAL_STORAGE_APPLICATION_ID,
  INTERNAL_STORAGE_SCHEMA_VERSION,
} from '@features/internal-storage/main';
import { admitStandaloneHostedState } from '@main/standaloneHostedStateAdmission';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('standalone hosted state admission', () => {
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
    const storage = join(input.stateDirectory, 'storage');
    await mkdir(storage);
    const database = new Database(join(storage, 'app.db'));
    try {
      database.pragma(`application_id = ${INTERNAL_STORAGE_APPLICATION_ID}`);
      database.pragma(`user_version = ${INTERNAL_STORAGE_SCHEMA_VERSION}`);
      database.exec(
        'CREATE TABLE hosted_access_authority (singleton INTEGER PRIMARY KEY, state_json TEXT NOT NULL)'
      );
      database.prepare('INSERT INTO hosted_access_authority VALUES (1, ?)').run(
        JSON.stringify({
          binding: { deploymentId: 'deployment_synthetic', restoreGeneration: 0 },
        })
      );
    } finally {
      database.close();
    }
    await admitStandaloneHostedState(
      input.environment,
      input.builtServerDirectory,
      input.stateDirectory
    );
    expect(
      JSON.parse(await readFile(join(input.stateDirectory, 'hosted-state-header.v1.json'), 'utf8'))
    ).toMatchObject({ deploymentId: 'deployment_synthetic', hostedStateSchemaVersion: 1 });
  });

  it('refuses a foreign pre-header authority without writing a header', async () => {
    const input = await fixture();
    const storage = join(input.stateDirectory, 'storage');
    await mkdir(storage);
    const database = new Database(join(storage, 'app.db'));
    try {
      database.pragma(`application_id = ${INTERNAL_STORAGE_APPLICATION_ID}`);
      database.pragma(`user_version = ${INTERNAL_STORAGE_SCHEMA_VERSION}`);
      database.exec(
        'CREATE TABLE hosted_access_authority (singleton INTEGER PRIMARY KEY, state_json TEXT NOT NULL)'
      );
      database
        .prepare('INSERT INTO hosted_access_authority VALUES (1, ?)')
        .run(
          JSON.stringify({ binding: { deploymentId: 'deployment_other', restoreGeneration: 0 } })
        );
    } finally {
      database.close();
    }
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
    const storage = join(input.stateDirectory, 'storage');
    await mkdir(storage);
    const database = new Database(join(storage, 'app.db'));
    try {
      database.pragma(`application_id = ${INTERNAL_STORAGE_APPLICATION_ID}`);
      database.pragma(`user_version = ${INTERNAL_STORAGE_SCHEMA_VERSION}`);
      database.exec(
        'CREATE TABLE hosted_access_authority (singleton INTEGER PRIMARY KEY, state_json TEXT NOT NULL)'
      );
      database.prepare('INSERT INTO hosted_access_authority VALUES (1, ?)').run(
        JSON.stringify({
          binding: { deploymentId: 'deployment_synthetic', restoreGeneration: 1 },
        })
      );
    } finally {
      database.close();
    }
    await expect(
      admitStandaloneHostedState(
        input.environment,
        input.builtServerDirectory,
        input.stateDirectory
      )
    ).rejects.toMatchObject({ diagnostic: 'state_metadata_invalid' });
    expect(await readdir(input.stateDirectory)).toEqual(['storage']);
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

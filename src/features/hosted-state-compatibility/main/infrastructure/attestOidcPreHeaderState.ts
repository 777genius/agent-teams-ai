import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  databaseDigest,
  OIDC_ATTESTATION_FILE,
  SHA256,
  supportedPreHeaderDatabase,
  validBinding,
} from './preHeaderStateInspection';

/** Explicit offline operator attestation. The caller supplies a database digest and binding independently. */
export async function attestOidcPreHeaderState(input: {
  readonly stateDirectory: string;
  readonly deploymentId: string;
  readonly restoreGeneration: number;
  readonly expectedDatabaseSha256: string;
}): Promise<void> {
  if (!validBinding(input) || !SHA256.test(input.expectedDatabaseSha256)) {
    throw new Error('hosted_preheader_attestation_input_invalid');
  }
  const entries = await readdir(input.stateDirectory);
  if (
    entries.some(
      (entry) =>
        entry.startsWith('hosted-state-header.') ||
        entry.startsWith('hosted-restore-') ||
        entry === OIDC_ATTESTATION_FILE
    )
  ) {
    throw new Error('hosted_preheader_attestation_state_not_eligible');
  }
  const databasePath = join(input.stateDirectory, 'storage', 'app.db');
  const storageEntries = await readdir(join(input.stateDirectory, 'storage'));
  if (storageEntries.some((entry) => /^app\.db-(?:wal|shm|journal)$/.test(entry))) {
    throw new Error('hosted_preheader_attestation_database_not_quiescent');
  }
  // This is a Node operator command; the app's better-sqlite3 build may target Electron's ABI.
  const { default: Database } = await import('better-sqlite3-node');
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (!supportedPreHeaderDatabase(database)) {
      throw new Error('hosted_preheader_attestation_database_invalid');
    }
    const mode = database
      .prepare('SELECT auth_mode FROM hosted_auth_configuration WHERE singleton = 1')
      .get() as { auth_mode?: unknown } | undefined;
    const authority = database
      .prepare('SELECT COUNT(*) AS count FROM hosted_access_authority')
      .get() as { count?: unknown } | undefined;
    if (mode?.auth_mode !== 'oidc' || authority?.count !== 0) {
      throw new Error('hosted_preheader_attestation_database_invalid');
    }
  } finally {
    database.close();
  }
  if ((await databaseDigest(databasePath)) !== input.expectedDatabaseSha256) {
    throw new Error('hosted_preheader_attestation_digest_mismatch');
  }
  const path = join(input.stateDirectory, OIDC_ATTESTATION_FILE);
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(
      `${JSON.stringify({
        format: 'hosted-preheader-oidc-attestation/v1',
        schemaVersion: 1,
        deploymentId: input.deploymentId,
        restoreGeneration: input.restoreGeneration,
        databaseSha256: input.expectedDatabaseSha256,
      })}\n`
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  const parent = await open(
    input.stateDirectory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

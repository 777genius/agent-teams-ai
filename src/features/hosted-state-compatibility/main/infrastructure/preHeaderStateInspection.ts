import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import {
  INTERNAL_STORAGE_APPLICATION_ID,
  INTERNAL_STORAGE_SCHEMA_VERSION,
} from '@features/internal-storage/main';

export const OIDC_ATTESTATION_FILE = 'hosted-preheader-oidc-attestation.v1.json';
export const SHA256 = /^[0-9a-f]{64}$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SUPPORTED_PREHEADER_SQLITE_VERSIONS = [30, 31] as const;
export interface StateBinding {
  readonly deploymentId: string;
  readonly restoreGeneration: number;
}

export async function databaseDigest(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('hosted_preheader_database_invalid');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, before.size - offset),
        offset
      );
      if (bytesRead === 0) throw new Error('hosted_preheader_database_changed');
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('hosted_preheader_database_changed');
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export function supportedPreHeaderDatabase(database: {
  pragma: (source: string, options: { simple: true }) => unknown;
}): boolean {
  const version = database.pragma('user_version', { simple: true });
  return (
    INTERNAL_STORAGE_SCHEMA_VERSION === 31 &&
    database.pragma('integrity_check', { simple: true }) === 'ok' &&
    database.pragma('application_id', { simple: true }) === INTERNAL_STORAGE_APPLICATION_ID &&
    SUPPORTED_PREHEADER_SQLITE_VERSIONS.some((supported) => supported === version)
  );
}

export function validBinding(value: unknown): value is StateBinding {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.deploymentId === 'string' &&
    DEPLOYMENT_ID.test(binding.deploymentId) &&
    Number.isSafeInteger(binding.restoreGeneration) &&
    (binding.restoreGeneration as number) >= 0
  );
}

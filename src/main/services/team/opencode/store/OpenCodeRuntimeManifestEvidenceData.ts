import { readFile } from 'node:fs/promises';

import {
  createDefaultRuntimeStoreManifest,
  OPENCODE_RUNTIME_STORE_MANIFEST_SCHEMA_VERSION,
  type RuntimeStoreManifest,
  validateRuntimeStoreManifest,
} from './RuntimeStoreManifest';
import { VersionedJsonStoreError } from './VersionedJsonStore';

export async function readRuntimeStoreManifestEvidenceData(
  manifestPath: string,
  teamName: string,
  clock: () => Date
): Promise<RuntimeStoreManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createDefaultRuntimeStoreManifest(teamName, clock().toISOString());
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  const maybeRecord =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (!maybeRecord || !Object.prototype.hasOwnProperty.call(maybeRecord, 'data')) {
    return validateRuntimeStoreManifest(parsed);
  }
  const version = maybeRecord.schemaVersion;
  if (typeof version === 'number' && version > OPENCODE_RUNTIME_STORE_MANIFEST_SCHEMA_VERSION) {
    throw new VersionedJsonStoreError(
      `Future manifest envelope schema ${version}`,
      'future_schema',
      null
    );
  }
  if (
    version !== OPENCODE_RUNTIME_STORE_MANIFEST_SCHEMA_VERSION ||
    typeof maybeRecord.updatedAt !== 'string' ||
    !maybeRecord.updatedAt.trim()
  ) {
    throw new VersionedJsonStoreError('Invalid manifest envelope', 'invalid_envelope', null);
  }
  return validateRuntimeStoreManifest(maybeRecord.data);
}

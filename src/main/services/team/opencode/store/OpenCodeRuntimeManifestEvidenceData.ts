import { readFile } from 'node:fs/promises';

import {
  createDefaultRuntimeStoreManifest,
  type RuntimeStoreManifest,
  validateRuntimeStoreManifest,
} from './RuntimeStoreManifest';

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
  const manifestData =
    maybeRecord && Object.prototype.hasOwnProperty.call(maybeRecord, 'data')
      ? maybeRecord.data
      : parsed;
  return validateRuntimeStoreManifest(manifestData);
}

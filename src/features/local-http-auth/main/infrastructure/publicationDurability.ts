import path from 'node:path';

import { syncDirectoryDurably } from '../../../../main/utils/durableFileSync';

import { writeManualDiscovery } from './discoveryReference';
import { writePrivateJson } from './privateFiles';

import type { ApiDiscoveryReference } from '../../contracts';

/** Helper-only boundary: canonical JSON behavior remains unchanged for generic callers. */
export async function writeDurableAuthorityJson(
  file: string,
  value: unknown,
): Promise<void> {
  await writePrivateJson(file, value);
  await syncDirectoryDurably(path.dirname(file));
}
export async function writeDurableManualDiscovery(
  root: string,
  reference: ApiDiscoveryReference,
): Promise<void> {
  await writeManualDiscovery(root, reference);
  await syncDirectoryDurably(root);
}

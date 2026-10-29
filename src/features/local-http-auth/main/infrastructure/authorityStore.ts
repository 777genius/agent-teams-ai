import { createHash } from 'node:crypto';
import path from 'node:path';

import { type ApiAuthority, type ApiDiscoveryReference } from '../../contracts';
import { validateAuthority } from '../../core/domain/authority';

import { writeManualDiscovery } from './discoveryReference';
import { removeOwnedAuthorityFiles } from './ownedCleanup';
import {
  privateDirectory,
  readPrivateJson,
  validateProfileRoot,
  writePrivateJson,
} from './privateFiles';
import { withPublicationLock } from './publicationLock';

export function apiProfileScope(root: string): string {
  return createHash('sha256').update(root).digest('hex');
}

export function apiReferencePath(root: string, instanceId: string): string {
  return path.join(root, 'local-http-auth', `api-${instanceId}.ref.json`);
}

export async function publishApiAuthority(root: string, authority: ApiAuthority): Promise<string> {
  validateAuthority(authority, apiProfileScope(root));
  const directory = await privateDirectory(root);
  return withPublicationLock(directory, async () => {
    const descriptorPath = path.join(
      directory,
      `api-${authority.instanceId}-${authority.generation}.json`
    );
    const reference: ApiDiscoveryReference = {
      schemaVersion: 1,
      service: 'api',
      profileScope: authority.profileScope,
      instanceId: authority.instanceId,
      generation: authority.generation,
      descriptorPath,
    };
    const referencePath = apiReferencePath(root, authority.instanceId);
    try {
      // References switch atomically between immutable generations. A reader that opened
      // the previous reference can still finish opening its matching descriptor.
      let existing: unknown;
      try {
        existing = await readPrivateJson(descriptorPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (existing !== undefined) {
        const current = validateAuthority(existing, authority.profileScope);
        if (
          Object.keys(authority).some(
            (key) => current[key as keyof ApiAuthority] !== authority[key as keyof ApiAuthority]
          )
        )
          throw new Error('API generation descriptor is immutable');
      } else await writePrivateJson(descriptorPath, authority);
      // Stable instance reference lets managed clients follow restarts without using another instance.
      await writePrivateJson(referencePath, reference);
      // Only owner-controlled legacy manual metadata may migrate under this same lock.
      await writeManualDiscovery(root, reference);
      return referencePath;
    } catch (error) {
      try {
        await removeOwnedAuthorityFiles(root, authority);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `API publication failed: ${error instanceof Error ? error.message : 'invalid state'}; owned cleanup attempted`
        );
      }
      throw error;
    }
  });
}

export async function removeApiAuthority(root: string, authority: ApiAuthority): Promise<void> {
  await validateProfileRoot(root);
  const directory = await privateDirectory(root);
  await withPublicationLock(directory, () => removeOwnedAuthorityFiles(root, authority));
}

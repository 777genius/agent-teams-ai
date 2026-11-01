import { createHash } from 'node:crypto';
import path from 'node:path';

import { type ApiAuthority, type ApiDiscoveryReference } from '../../contracts';
import { validateAuthority } from '../../core/domain/authority';

import { validateDiscoveryReference, writeManualDiscovery } from './discoveryReference';
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

/** A failed optional discovery refresh left this exact committed generation intact. */
export class RetainedApiPublicationError extends Error {
  constructor(
    readonly referencePath: string,
    cause: unknown
  ) {
    super('API manual discovery refresh failed; committed authority retained', { cause });
    this.name = 'RetainedApiPublicationError';
  }
}

function authorityMatches(current: ApiAuthority, expected: ApiAuthority): boolean {
  return (
    Object.keys(current).length === Object.keys(expected).length &&
    Object.keys(expected).every(
      (key) => current[key as keyof ApiAuthority] === expected[key as keyof ApiAuthority]
    )
  );
}

async function readReference(
  root: string,
  scope: string,
  file: string
): Promise<ApiDiscoveryReference | undefined> {
  try {
    return validateDiscoveryReference(await readPrivateJson(file), root, scope);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
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
    // An immutable mismatch is not owned by this attempt and must never enter cleanup.
    let existing: unknown;
    try {
      existing = await readPrivateJson(descriptorPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing !== undefined) {
      const current = validateAuthority(existing, authority.profileScope);
      if (!authorityMatches(current, authority))
        throw new Error('API generation descriptor is immutable');
    }
    let previousReference: ApiDiscoveryReference | undefined;
    let previousAuthority: ApiAuthority | undefined;
    let committed = false;
    try {
      previousReference = await readReference(root, authority.profileScope, referencePath);
      if (previousReference && previousReference.instanceId !== authority.instanceId)
        throw new Error('API instance reference does not match its owner');
      committed = existing !== undefined && previousReference?.generation === authority.generation;
      if (previousReference && !committed) {
        previousAuthority = validateAuthority(
          await readPrivateJson(previousReference.descriptorPath),
          authority.profileScope
        );
        if (
          previousAuthority.instanceId !== previousReference.instanceId ||
          previousAuthority.generation !== previousReference.generation
        )
          throw new Error('API previous reference does not match its descriptor');
      }
      // A committed refresh need only update optional manual discovery. Keep its reference stable.
      if (!committed) {
        if (existing === undefined) await writePrivateJson(descriptorPath, authority);
        await writePrivateJson(referencePath, reference);
      }
      await writeManualDiscovery(root, reference);
      return referencePath;
    } catch (error) {
      if (committed) {
        // Recheck both private files; an unsafe or changed reference is never retention proof.
        const currentReference = await readReference(root, authority.profileScope, referencePath);
        const current = validateAuthority(
          await readPrivateJson(descriptorPath),
          authority.profileScope
        );
        if (
          currentReference?.instanceId === authority.instanceId &&
          currentReference.generation === authority.generation &&
          authorityMatches(current, authority)
        ) {
          throw new RetainedApiPublicationError(referencePath, error);
        }
      }
      const cleanupErrors: unknown[] = [];
      try {
        await removeOwnedAuthorityFiles(root, authority);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        if (
          previousReference &&
          previousAuthority &&
          previousReference.generation !== authority.generation &&
          !(await readReference(root, authority.profileScope, referencePath))
        ) {
          // Restore only a still-valid older generation, while the publication lock is held.
          const previous = validateAuthority(
            await readPrivateJson(previousReference.descriptorPath),
            authority.profileScope
          );
          if (authorityMatches(previous, previousAuthority))
            await writePrivateJson(referencePath, previousReference);
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          [error, ...cleanupErrors],
          'API publication failed; owned cleanup attempted'
        );
      throw error;
    }
  });
}

export async function removeApiAuthority(root: string, authority: ApiAuthority): Promise<void> {
  await validateProfileRoot(root);
  const directory = await privateDirectory(root);
  await withPublicationLock(directory, () => removeOwnedAuthorityFiles(root, authority));
}

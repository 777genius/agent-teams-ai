import path from 'node:path';

import { type ApiAuthority, type ApiDiscoveryReference } from '../../contracts';
import { validateAuthority } from '../../core/domain/authority';

import { RetainedApiPublicationError } from './authorityErrors';
import { apiProfileScope, apiReferencePath } from './authorityPaths';
import { validateDiscoveryReference } from './discoveryReference';
import { OwnedCleanupError, removeOwnedAuthorityFiles } from './ownedCleanup';
import { privateDirectory, readPrivateJson } from './privateFiles';
import {
  writeDurableAuthorityJson as writePrivateJson,
  writeDurableManualDiscovery as writeManualDiscovery,
} from './publicationDurability';

import type {
  PublicationOutcome,
  PublicationRequest,
} from './publicationHelperProtocol';

class ImmutableGenerationError extends Error {}

class PublicationCleanupError extends Error {
  constructor(readonly hintAction: 'keep' | 'revoke-matching') {
    super('API publication failed');
  }
}

function authorityMatches(
  current: ApiAuthority,
  expected: ApiAuthority,
): boolean {
  return (
    Object.keys(current).length === Object.keys(expected).length &&
    Object.keys(expected).every(
      (key) =>
        current[key as keyof ApiAuthority] ===
        expected[key as keyof ApiAuthority],
    )
  );
}

async function readReference(
  root: string,
  scope: string,
  file: string,
): Promise<ApiDiscoveryReference | undefined> {
  try {
    return validateDiscoveryReference(await readPrivateJson(file), root, scope);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function publishLockedAuthority(
  root: string,
  authority: ApiAuthority,
): Promise<string> {
  validateAuthority(authority, apiProfileScope(root));
  const directory = await privateDirectory(root);
  return (async () => {
    const descriptorPath = path.join(
      directory,
      `api-${authority.instanceId}-${authority.generation}.json`,
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
        throw new ImmutableGenerationError(
          'API generation descriptor is immutable',
        );
    }
    let previousReference: ApiDiscoveryReference | undefined;
    let previousAuthority: ApiAuthority | undefined;
    let committed = false;
    try {
      previousReference = await readReference(
        root,
        authority.profileScope,
        referencePath,
      );
      if (
        previousReference &&
        previousReference.instanceId !== authority.instanceId
      )
        throw new Error('API instance reference does not match its owner');
      committed =
        existing !== undefined &&
        previousReference?.generation === authority.generation;
      if (previousReference && !committed) {
        previousAuthority = validateAuthority(
          await readPrivateJson(previousReference.descriptorPath),
          authority.profileScope,
        );
        if (
          previousAuthority.instanceId !== previousReference.instanceId ||
          previousAuthority.generation !== previousReference.generation
        )
          throw new Error(
            'API previous reference does not match its descriptor',
          );
      }
      // A committed refresh need only update optional manual discovery. Keep its reference stable.
      if (!committed) {
        if (existing === undefined)
          await writePrivateJson(descriptorPath, authority);
        await writePrivateJson(referencePath, reference);
      }
      await writeManualDiscovery(root, reference);
      return referencePath;
    } catch (error) {
      if (committed) {
        // Recheck both private files; an unsafe or changed reference is never retention proof.
        const currentReference = await readReference(
          root,
          authority.profileScope,
          referencePath,
        );
        const current = validateAuthority(
          await readPrivateJson(descriptorPath),
          authority.profileScope,
        );
        if (
          currentReference?.instanceId === authority.instanceId &&
          currentReference.generation === authority.generation &&
          authorityMatches(current, authority)
        ) {
          throw new RetainedApiPublicationError(referencePath, error);
        }
      }
      let cleanupHint: 'keep' | 'revoke-matching' = 'keep';
      try {
        cleanupHint = await removeOwnedAuthorityFiles(root, authority);
      } catch (cleanupError) {
        if (cleanupError instanceof OwnedCleanupError)
          cleanupHint = cleanupError.hintAction;
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
            authority.profileScope,
          );
          if (authorityMatches(previous, previousAuthority))
            await writePrivateJson(referencePath, previousReference);
        }
      } catch {
        /* Failure remains closed; no unproven prior reference restoration. */
      }
      // Only fixed evidence crosses the helper boundary; raw causes stay private.
      throw new PublicationCleanupError(cleanupHint);
    }
  })();
}

/** Caller owns the SQLite connection for the entire operation and compensation. */
export async function performPublication(
  request: PublicationRequest,
): Promise<PublicationOutcome> {
  try {
    if (request.op === 'publish') {
      await publishLockedAuthority(request.root, request.authority);
      return { outcome: 'published', hintAction: 'keep', code: 'none' };
    }
    const hintAction = await removeOwnedAuthorityFiles(
      request.root,
      request.authority,
    );
    return { outcome: 'removed', hintAction, code: 'none' };
  } catch (error) {
    if (error instanceof RetainedApiPublicationError)
      return {
        outcome: 'retained',
        hintAction: 'keep',
        code: 'retained-discovery',
      };
    return {
      outcome: 'failed',
      code:
        error instanceof ImmutableGenerationError
          ? 'immutable-generation'
          : 'storage-failed',
      hintAction:
        error instanceof OwnedCleanupError ||
        error instanceof PublicationCleanupError
          ? error.hintAction
          : 'keep',
    };
  }
}

import { unlink } from 'node:fs/promises';
import path from 'node:path';

import { API_AUTH_REFERENCE_ENV, type ApiAuthority } from '../../contracts';
import { validateAuthority } from '../../core/domain/authority';

import { validateDiscoveryReference } from './discoveryReference';
import { readPrivateJson } from './privateFiles';

/** Must run under publication.lock. One unsafe/foreign target cannot prevent other owned cleanup. */
export async function removeOwnedAuthorityFiles(
  root: string,
  authority: ApiAuthority
): Promise<void> {
  const reference = path.join(root, 'local-http-auth', `api-${authority.instanceId}.ref.json`);
  const descriptor = path.join(
    root,
    'local-http-auth',
    `api-${authority.instanceId}-${authority.generation}.json`
  );
  const errors: unknown[] = [];
  for (const file of [path.join(root, 'team-control-api.json'), reference, descriptor]) {
    try {
      const value = await readPrivateJson(file);
      const current =
        file === descriptor
          ? validateAuthority(value, authority.profileScope)
          : validateDiscoveryReference(value, root, authority.profileScope);
      if (
        current.instanceId !== authority.instanceId ||
        current.generation !== authority.generation
      )
        continue;
      await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error);
    }
  }
  // Revoke this generation's hints even when another candidate was unsafe or the
  // owned reference was already removed. Never revoke a newer/foreign instance.
  if (process.env[API_AUTH_REFERENCE_ENV] === reference) {
    try {
      const current = validateDiscoveryReference(
        await readPrivateJson(reference),
        root,
        authority.profileScope
      );
      if (
        current.instanceId === authority.instanceId &&
        current.generation === authority.generation
      ) {
        delete process.env[API_AUTH_REFERENCE_ENV];
        delete process.env.CLAUDE_TEAM_CONTROL_URL;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        delete process.env[API_AUTH_REFERENCE_ENV];
        delete process.env.CLAUDE_TEAM_CONTROL_URL;
      }
      // Unsafe reference ownership cannot be inferred; retain its hints and the error above.
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      'Owned API cleanup finished with unsafe or inaccessible state'
    );
}

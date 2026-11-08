import { unlink } from 'node:fs/promises';
import path from 'node:path';

import { syncDirectoryDurably } from '../../../../main/utils/durableFileSync';
import { type ApiAuthority } from '../../contracts';
import { validateAuthority } from '../../core/domain/authority';

import { validateDiscoveryReference } from './discoveryReference';
import { readPrivateJson } from './privateFiles';

export class OwnedCleanupError extends Error {
  constructor(readonly hintAction: 'keep' | 'revoke-matching') {
    super('Owned API cleanup finished with unsafe or inaccessible state');
  }
}

/** Must run under publication.lock. One unsafe/foreign target cannot prevent other owned cleanup. */
export async function removeOwnedAuthorityFiles(
  root: string,
  authority: ApiAuthority,
): Promise<'keep' | 'revoke-matching'> {
  const reference = path.join(
    root,
    'local-http-auth',
    `api-${authority.instanceId}.ref.json`,
  );
  const descriptor = path.join(
    root,
    'local-http-auth',
    `api-${authority.instanceId}-${authority.generation}.json`,
  );
  const errors: unknown[] = [];
  for (const file of [
    path.join(root, 'team-control-api.json'),
    reference,
    descriptor,
  ]) {
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
      await syncDirectoryDurably(path.dirname(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        errors.push(error);
    }
  }
  // This is only filesystem evidence. The parent additionally checks its opaque hint epoch.
  let hintAction: 'keep' | 'revoke-matching' = 'keep';
  try {
    const current = validateDiscoveryReference(
      await readPrivateJson(reference),
      root,
      authority.profileScope,
    );
    if (
      current.instanceId === authority.instanceId &&
      current.generation === authority.generation
    )
      hintAction = 'revoke-matching';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      hintAction = 'revoke-matching';
  }
  if (errors.length) throw new OwnedCleanupError(hintAction);
  return hintAction;
}

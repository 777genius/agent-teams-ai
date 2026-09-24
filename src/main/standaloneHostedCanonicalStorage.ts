import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createHostedDraftPublicationComposition,
  type HostedDraftPublicationComposition,
} from './composition/hosted/hostedDraftPublicationComposition';

import type { TeamLifecycleReadBootstrap } from './composition/hosted/teamLifecycleReadBootstrapSource';
import type { InternalStorageHostedAuthFeature } from '@features/internal-storage/main';

export async function createAdmittedHostedDraftPublication(input: {
  readonly bootstrap: TeamLifecycleReadBootstrap;
  readonly drafts: InternalStorageHostedAuthFeature;
  readonly authDataDirectory: string;
  readonly pendingFirstBoot: boolean;
  readonly completeFirstBoot: () => Promise<void>;
}): Promise<HostedDraftPublicationComposition | null> {
  const canonicalRoot = input.bootstrap.runtimeInstance.appDataRoot.reference;
  if (input.pendingFirstBoot) {
    if (input.authDataDirectory !== canonicalRoot) {
      throw new Error('hosted_canonical_first_boot_root_mismatch');
    }
    await initializeFreshHostedCanonicalStorage(canonicalRoot, input.drafts);
    await input.completeFirstBoot();
  }
  try {
    return await createHostedDraftPublicationComposition({
      bootstrap: input.bootstrap,
      drafts: input.drafts,
    });
  } catch (error) {
    if (input.authDataDirectory === canonicalRoot) throw error;
    return null;
  }
}

/** Pending first boot only, after state admission and the signed bootstrap bind this exact root. */
export async function initializeFreshHostedCanonicalStorage(
  appDataRoot: string,
  backend: Pick<InternalStorageHostedAuthFeature, 'databasePath' | 'initialize'>
): Promise<void> {
  if (
    process.platform !== 'linux' ||
    backend.databasePath !== join(appDataRoot, 'storage', 'app.db') ||
    (await realpath(appDataRoot)) !== appDataRoot
  ) {
    throw new Error('canonical-database-root-invalid');
  }
  const root = await open(
    appDataRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const [named, retained] = await Promise.all([
      lstat(appDataRoot, { bigint: true }),
      root.stat({ bigint: true }),
    ]);
    if (
      !named.isDirectory() ||
      named.isSymbolicLink() ||
      named.dev !== retained.dev ||
      named.ino !== retained.ino ||
      (named.mode & 0o077n) !== 0n
    ) {
      throw new Error('canonical-database-root-invalid');
    }
    try {
      await mkdir(`/proc/self/fd/${root.fd}/storage`, { mode: 0o700 });
      await root.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const storage = await open(
      `/proc/self/fd/${root.fd}/storage`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      const [namedStorage, retainedStorage] = await Promise.all([
        lstat(join(appDataRoot, 'storage'), { bigint: true }),
        storage.stat({ bigint: true }),
      ]);
      if (
        !namedStorage.isDirectory() ||
        namedStorage.isSymbolicLink() ||
        namedStorage.dev !== retainedStorage.dev ||
        namedStorage.ino !== retainedStorage.ino ||
        (namedStorage.mode & 0o077n) !== 0n
      ) {
        throw new Error('canonical-database-storage-invalid');
      }
      const descriptorPath = `/proc/self/fd/${storage.fd}/app.db`;
      let file;
      let createdFresh = false;
      try {
        file = await open(descriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        file = await open(
          descriptorPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600
        );
        createdFresh = true;
      }
      try {
        const created = await file.stat({ bigint: true });
        const namedFile = await lstat(backend.databasePath, { bigint: true });
        if (
          !created.isFile() ||
          created.nlink !== 1n ||
          !namedFile.isFile() ||
          namedFile.dev !== created.dev ||
          namedFile.ino !== created.ino
        ) {
          throw new Error('canonical-database-file-invalid');
        }
        if (createdFresh) {
          await file.sync();
          await storage.sync();
        }
        // The worker is pinned to an existing file. It cannot use corruption recovery.
        const connectionIdentity = await backend.initialize(true);
        const after = await lstat(backend.databasePath, { bigint: true });
        if (
          connectionIdentity !== `${created.dev}:${created.ino}` ||
          after.dev !== created.dev ||
          after.ino !== created.ino
        ) {
          throw new Error('canonical-database-worker-identity-mismatch');
        }
      } finally {
        await file.close();
      }
    } finally {
      await storage.close();
    }
  } finally {
    await root.close();
  }
}

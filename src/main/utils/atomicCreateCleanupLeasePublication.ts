import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { lstatOrNull } from './atomicWriteRecovery';
import {
  getDurableFileIdentity,
  getDurablePathIdentity,
  hasTrustworthyDurablePathIdentity,
  isSameDurableFileIdentity,
  type DurableFileIdentity,
} from './durablePathIdentity';
import { readBoundedRegularText } from './atomicCreateCleanupRecoveryIo';
import { RENAME_PUBLISH_RETRY, retryOnTransientFsError } from './transientFsRetry';

const MAX_OWNER_RECORD_BYTES = 4 * 1024;

export interface AtomicCreateLeaseOwner {
  version: 1;
  fence: string;
  pid: number;
  incarnation: string | null;
  released?: true;
}

type ExactGenerationOperations = {
  unlinkExactGeneration?: (pathname: string, identity: DurableFileIdentity) => Promise<void>;
};

function exactGenerationOperations(): ExactGenerationOperations {
  return fs.promises as typeof fs.promises & ExactGenerationOperations;
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isMissing(error: unknown): boolean {
  return codeOf(error) === 'ENOENT';
}

async function syncOwnerPublication(pathname: string): Promise<void> {
  const handle = await fs.promises.open(
    pathname,
    fs.constants.O_RDONLY |
      (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0)
  );
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function syncOwnerDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(
    directory,
    fs.constants.O_RDONLY |
      (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
      (typeof fs.constants.O_DIRECTORY === 'number' ? fs.constants.O_DIRECTORY : 0)
  );
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function releasePublishedAliases(
  release: (pathname: string, identity: DurableFileIdentity) => Promise<void>,
  pathname: string,
  publishedIdentity: DurableFileIdentity | null,
  pending: string,
  pendingIdentity: DurableFileIdentity | null,
  error: unknown,
  message: string
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  if (publishedIdentity) {
    try {
      await retryOnTransientFsError(() => release(pathname, publishedIdentity), RENAME_PUBLISH_RETRY);
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) cleanupErrors.push(cleanupError);
    }
  }
  if (pendingIdentity) {
    try {
      await retryOnTransientFsError(() => release(pending, pendingIdentity), RENAME_PUBLISH_RETRY);
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) cleanupErrors.push(cleanupError);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError([error, ...cleanupErrors], message);
  }
  throw error;
}

async function writeAndPublishOwner(
  pathname: string,
  pending: string,
  owner: AtomicCreateLeaseOwner,
  syncDirectories: readonly string[],
  replaceIdentity?: DurableFileIdentity
): Promise<DurableFileIdentity | null> {
  const release = exactGenerationOperations().unlinkExactGeneration;
  if (!release) {
    throw new Error('Atomic-create cleanup owner publication requires an exact-generation primitive');
  }
  let pendingIdentity: DurableFileIdentity | null = null;
  let publishedIdentity: DurableFileIdentity | null = null;
  try {
    await fs.promises.writeFile(pending, JSON.stringify(owner), {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
    const pendingStats = await fs.promises.lstat(pending);
    if (
      !pendingStats.isFile() || pendingStats.isSymbolicLink() ||
      !hasTrustworthyDurablePathIdentity(getDurablePathIdentity(pendingStats))
    ) {
      throw new Error('Atomic-create cleanup pending owner cannot be authenticated');
    }
    pendingIdentity = getDurableFileIdentity(pendingStats);
    await syncOwnerPublication(pending);
    if (replaceIdentity) {
      await retryOnTransientFsError(() => release(pathname, replaceIdentity), RENAME_PUBLISH_RETRY);
    }
    await fs.promises.link(pending, pathname);
    const publishedStats = await fs.promises.lstat(pathname);
    if (
      !publishedStats.isFile() || publishedStats.isSymbolicLink() ||
      !isSameDurableFileIdentity(getDurableFileIdentity(publishedStats), pendingIdentity)
    ) {
      throw new Error('Atomic-create cleanup owner cannot be authenticated');
    }
    publishedIdentity = getDurableFileIdentity(publishedStats);
    await syncOwnerPublication(pathname);
    for (const directory of syncDirectories) await syncOwnerDirectory(directory);
    await retryOnTransientFsError(() => release(pending, pendingIdentity), RENAME_PUBLISH_RETRY);
    return publishedIdentity;
  } catch (error) {
    await releasePublishedAliases(
      release,
      pathname,
      publishedIdentity,
      pending,
      pendingIdentity,
      error,
      'Atomic-create owner publication failed and cleanup also failed'
    );
  }
}

export async function publishAdmissionOwner(
  directory: string,
  owner: AtomicCreateLeaseOwner,
  replaceReleasedOwner = false,
  expectedReplacedIdentity?: DurableFileIdentity
): Promise<DurableFileIdentity | null> {
  const pathname = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
  const pending = `${pathname}.pending-${owner.fence}${owner.released ? '-released' : ''}`;
  if (replaceReleasedOwner && !expectedReplacedIdentity) return null;
  try {
    return await writeAndPublishOwner(
      pathname,
      pending,
      owner,
      [directory],
      expectedReplacedIdentity
    );
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return null;
    throw error;
  }
}

export async function publishLeaseOwner(
  directory: string,
  lease: string,
  owner: AtomicCreateLeaseOwner
): Promise<DurableFileIdentity> {
  const pathname = path.join(directory, lease, 'owner.json');
  const identity = await writeAndPublishOwner(
    pathname,
    `${pathname}.pending-${owner.fence}`,
    owner,
    [path.dirname(pathname), directory]
  );
  if (!identity) throw new Error('Atomic-create cleanup lease owner publication raced');
  return identity;
}

export type StaleAdmissionRetirement = 'retired' | 'changed' | 'unavailable';

/** Authenticate a stale admission generation before exact retirement. */
export async function retireStaleAdmissionOwner(
  directory: string,
  expectedRaw: string
): Promise<StaleAdmissionRetirement> {
  const owner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
  const claimed = `${owner}.claim-${createHash('sha256').update(expectedRaw).digest('hex')}`;
  try {
    await fs.promises.link(owner, claimed);
  } catch (error) {
    if (isMissing(error)) return 'changed';
    if (codeOf(error) !== 'EEXIST') throw error;
  }
  const claimedStats = await lstatOrNull(claimed);
  if (
    !claimedStats ||
    !claimedStats.isFile() ||
    claimedStats.isSymbolicLink() ||
    !hasTrustworthyDurablePathIdentity(getDurablePathIdentity(claimedStats))
  ) {
    throw new Error('Atomic-create cleanup admission owner is not a regular file');
  }
  const raw = await readBoundedRegularText(claimed, MAX_OWNER_RECORD_BYTES);
  if (raw !== expectedRaw) return 'changed';
  const identity = getDurableFileIdentity(claimedStats);
  const release = exactGenerationOperations().unlinkExactGeneration;
  if (!release) return 'unavailable';
  try {
    await retryOnTransientFsError(() => release(owner, identity), RENAME_PUBLISH_RETRY);
  } catch (error) {
    if (isMissing(error)) return 'changed';
    throw error;
  }
  if (await lstatOrNull(owner)) return 'changed';
  try {
    await retryOnTransientFsError(() => release(claimed, identity), RENAME_PUBLISH_RETRY);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return 'retired';
}

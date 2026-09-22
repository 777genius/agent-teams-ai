import * as fs from 'fs';
import * as path from 'path';

import {
  getDurablePathIdentity,
  isSameDurablePathIdentity,
  type DurableFileIdentity,
  type DurablePathIdentity,
} from './durablePathIdentity';
import { lstatOrNull } from './atomicWriteRecovery';
import { RENAME_PUBLISH_RETRY, retryOnTransientFsError } from './transientFsRetry';

/**
 * Node exposes pathname based unlink(2)/rmdir(2), but neither syscall accepts
 * an inode, a file descriptor, or a generation token.  Consequently an
 * lstat() followed by either operation is not an identity check: another
 * writer can replace the last component in the interval and the destructive
 * syscall will act on the replacement.
 *
 * Do not paper over that gap with a fresh random retirement name.  A random
 * name is useful for durable recovery, but it is still a mutable pathname.
 * Until Node exposes an exact-generation delete primitive, retirement may
 * atomically *move* an owned entry into its durable private namespace, but
 * releasing the final name must fail closed.  The recovery record remains the
 * bounded authority charged to the caller rather than risking a successor.
 */
type ExactGenerationOperations = {
  unlinkExactGeneration?: (pathname: string, identity: DurableFileIdentity) => Promise<void>;
  rmdirExactGeneration?: (pathname: string, identity: DurablePathIdentity) => Promise<void>;
  renameExactGeneration?: (
    source: string,
    destination: string,
    identity: DurableFileIdentity
  ) => Promise<void>;
};

function exactGenerationOperations(): ExactGenerationOperations {
  return fs.promises as typeof fs.promises & ExactGenerationOperations;
}

async function unlinkExactGeneration(
  pathname: string,
  identity: DurableFileIdentity
): Promise<boolean> {
  const release = exactGenerationOperations().unlinkExactGeneration;
  if (!release) return false;
  await retryOnTransientFsError(() => release(pathname, identity), RENAME_PUBLISH_RETRY);
  return true;
}

async function rmdirExactGeneration(
  pathname: string,
  identity: DurablePathIdentity
): Promise<boolean> {
  const release = exactGenerationOperations().rmdirExactGeneration;
  if (!release) return false;
  await retryOnTransientFsError(() => release(pathname, identity), RENAME_PUBLISH_RETRY);
  return true;
}

export interface ClaimedPrivateDirectory {
  path: string;
  name: string;
}

/** A replacement-safe admission transfer requires an exact source generation. */
export function canMoveOwnedPrivateChild(): boolean {
  return Boolean(exactGenerationOperations().renameExactGeneration);
}

export async function moveOwnedPrivateChild(
  source: string,
  destination: string,
  identity: DurableFileIdentity
): Promise<boolean> {
  const move = exactGenerationOperations().renameExactGeneration;
  if (!move) return false;
  await retryOnTransientFsError(() => move(source, destination, identity), RENAME_PUBLISH_RETRY);
  return true;
}

/**
 * Claim a directory under an unguessable retirement name.  The caller writes
 * its journal before this transition; after it succeeds, recovery can find
 * the retirement name even if rmdir is interrupted.
 */
export async function claimOwnedPrivateDirectory(
  parentDirectory: string,
  childName: string,
  expectedIdentity: DurablePathIdentity
): Promise<ClaimedPrivateDirectory | null> {
  const source = path.join(parentDirectory, childName);
  const actual = await lstatOrNull(source);
  if (!actual || !actual.isDirectory() || actual.isSymbolicLink() ||
    !isSameDurablePathIdentity(getDurablePathIdentity(actual), expectedIdentity)) return null;
  return { path: source, name: childName };
}

/**
 * Atomically move a mutable child out of its public private-directory name
 * before inspecting it. A replacement can be retained, but never unlinked.
 * The retirement name is private and fresh, so only this transaction can
 * remove an authenticated generation after the transition.
 */
export async function retireOwnedPrivateChild(
  directory: string,
  childName: string,
  expectedIdentity: DurableFileIdentity,
  persistRetirement?: (retiredName: string) => Promise<string>
): Promise<boolean> {
  // A path rename after an identity check can move a replacement B. Never use
  // it as a stock-Node substitute for an exact release.
  void persistRetirement;
  try {
    return await unlinkExactGeneration(path.join(directory, childName), expectedIdentity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Remove an empty private directory only with an exact-generation primitive. */
export async function retireOwnedPrivateDirectory(
  parentDirectory: string,
  childName: string,
  expectedIdentity: DurablePathIdentity
): Promise<boolean> {
  const claimed = await claimOwnedPrivateDirectory(parentDirectory, childName, expectedIdentity);
  if (!claimed) return false;
  try {
    // rmdir has the same pathname-only contract as unlink. Retain the claim
    // when no exact-generation primitive is available; deleting a successor
    // is never an acceptable capacity optimisation.
    return await rmdirExactGeneration(claimed.path, expectedIdentity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return false;
    throw error;
  }
}

import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  constants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_DIRECTORY_ENTRY_NAME_BYTES = 255;

/**
 * Enumerate from a retained directory descriptor. `readdir` materializes the
 * whole attacker-controlled directory before the caller can apply a limit;
 * the async directory iterator lets recovery stop at the first over-budget
 * entry instead. The archive has no compressed stream, therefore there is no
 * decompression-ratio limit to enforce here.
 */
export async function readBoundedDirectoryEntries(handle, maximumEntries) {
  await assertHeldDirectory(handle);
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
    throw new Error('recovery_directory_entry_limit_invalid');
  }
  const directory = await opendir(descriptorPath(handle));
  const entries = [];
  const canonicalNames = new Set();
  try {
    for await (const entry of directory) {
      if (Buffer.byteLength(entry.name, 'utf8') > MAX_DIRECTORY_ENTRY_NAME_BYTES) {
        throw new Error('recovery_directory_entry_name_limit');
      }
      // A restore may later run on a case-insensitive volume. Do not admit an
      // archive whose distinct source names collapse under that contract.
      const canonicalName = entry.name.normalize('NFC').toLocaleLowerCase('en-US');
      if (canonicalNames.has(canonicalName)) {
        throw new Error('recovery_directory_case_collision');
      }
      canonicalNames.add(canonicalName);
      entries.push(entry.name);
      if (entries.length > maximumEntries) {
        throw new Error('recovery_directory_entry_limit');
      }
    }
    return entries;
  } finally {
    await directory.close().catch(() => {});
  }
}

/**
 * Scratch is a capability, not a path. Keep the parent and child descriptors
 * from creation through retirement so a later recursive cleanup cannot be
 * redirected by replacing the mkdtemp pathname.
 */
export async function createOwnedScratchDirectory(parentPath, prefix) {
  const parentHandle = await openDirectoryBound(parentPath);
  try {
    const createdPath = await mkdtemp(`${descriptorPath(parentHandle)}/${prefix}`);
    const name = basename(createdPath);
    const handle = await openChildDirectory(parentHandle, name);
    const identity = await handle.stat();
    const named = await lstat(descriptorChildPath(parentHandle, name));
    if (!identity.isDirectory() || !named.isDirectory() || named.isSymbolicLink() ||
      identity.dev !== named.dev || identity.ino !== named.ino) {
      await handle.close();
      throw new Error('recovery_scratch_identity_invalid');
    }
    return Object.freeze({ parentHandle, handle, name, identity });
  } catch (error) {
    await parentHandle.close().catch(() => {});
    throw error;
  }
}

export async function removeOwnedScratchDirectory(scratch) {
  return await removeRetainedDirectory(scratch);
}

/**
 * Retire a directory only through the descriptors that were used to bind its
 * exact inode. This is also used for an authenticated, dead legacy owner: the
 * caller must retain the descriptor before renaming its entry to a tombstone.
 */
export async function removeRetainedDirectory(scratch) {
  try {
    const current = await scratch.handle.stat();
    const named = await lstat(descriptorChildPath(scratch.parentHandle, scratch.name));
    if (!sameDirectoryIdentity(current, scratch.identity) || !named.isDirectory() ||
      named.isSymbolicLink() || !sameDirectoryIdentity(named, scratch.identity)) {
      throw new Error('recovery_scratch_identity_changed');
    }
    await removeOwnedDirectoryContents(scratch.handle, 0);
    await scratch.handle.sync();
    const finalNamed = await lstat(descriptorChildPath(scratch.parentHandle, scratch.name));
    if (!finalNamed.isDirectory() || finalNamed.isSymbolicLink() ||
      !sameDirectoryIdentity(finalNamed, scratch.identity)) {
      throw new Error('recovery_scratch_identity_changed');
    }
    await scratch.handle.close();
    await rmdir(descriptorChildPath(scratch.parentHandle, scratch.name));
    await scratch.parentHandle.sync();
  } finally {
    await scratch.handle.close().catch(() => {});
    await scratch.parentHandle.close().catch(() => {});
  }
}

export async function releaseOwnedScratchDirectory(scratch) {
  let failure;
  try {
    await scratch.handle.close();
  } catch (error) {
    failure = error;
  }
  try {
    await scratch.parentHandle.close();
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], 'recovery_scratch_release_failed');
    throw error;
  }
  if (failure) throw failure;
}

export async function retainDirectoryForRemoval(parentPath, name, expectedIdentity) {
  const parentHandle = await openDirectoryBound(parentPath);
  let handle;
  try {
    handle = await openChildDirectory(parentHandle, name);
    const identity = await handle.stat();
    const named = await lstat(descriptorChildPath(parentHandle, name));
    if (!sameDirectoryIdentity(identity, expectedIdentity) || !named.isDirectory() ||
      named.isSymbolicLink() || !sameDirectoryIdentity(named, expectedIdentity)) {
      throw new Error('recovery_scratch_identity_changed');
    }
    return Object.freeze({ parentHandle, handle, name, identity: expectedIdentity });
  } catch (error) {
    await handle?.close().catch(() => {});
    await parentHandle.close().catch(() => {});
    throw error;
  }
}

async function removeOwnedDirectoryContents(parentHandle, depth) {
  if (depth > 32) throw new Error('recovery_scratch_depth_limit');
  const names = await readBoundedDirectoryEntries(parentHandle, 20_000);
  for (const name of names) {
    const path = descriptorChildPath(parentHandle, name);
    let child;
    try {
      child = await openChildDirectory(parentHandle, name);
    } catch (error) {
      if (error?.code !== 'ENOTDIR') throw error;
    }
    if (!child) {
      await unlink(path);
      continue;
    }
    try {
      const identity = await child.stat();
      await removeOwnedDirectoryContents(child, depth + 1);
      await child.sync();
      const named = await lstat(path);
      if (!named.isDirectory() || named.isSymbolicLink() || !sameDirectoryIdentity(named, identity)) {
        throw new Error('recovery_scratch_identity_changed');
      }
    } finally {
      await child.close();
    }
    await rmdir(path);
  }
}

export async function assertAbsent(path) {
  try {
    // Existence checks are a recovery boundary too.  Never lstat/follow a
    // caller-controlled FIFO or symlink and then continue on a raced result.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    await handle.close();
    throw new Error('stopped_stack_archive_already_exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function assertDirectory(path) {
  const pathStat = await lstat(path);
  if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
    throw new Error('recovery_directory_invalid');
  }
}

export function randomToken(bytes) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function readDescriptorBound(path, maximumBytes, onDescriptorOpened) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 0 || before.size > maximumBytes) {
      throw new Error('recovery_file_invalid');
    }
    // Do not use readFile here.  Its unbounded read loop is inappropriate for a
    // recovery boundary: a substituted FIFO can block and a growing file can
    // consume arbitrary memory.  O_NONBLOCK + fstat before/after + positional
    // descriptor reads bind the exact byte sequence we hash or copy.
    const body = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < body.byteLength) {
      const { bytesRead } = await handle.read(body, offset, body.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error('recovery_file_truncated');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameDescriptorState(before, after) || body.byteLength !== before.size) {
      throw new Error('recovery_file_changed_during_read');
    }
    // The callback is intentionally invoked while this exact no-follow FD is
    // live, but only after its final stability check.  A pathname swap changes
    // the held inode's ctime, so invoking a test hook before that check would
    // turn the successful descriptor-bound snapshot it models into a false
    // mutation failure.
    await onDescriptorOpened?.(Object.freeze({
      fd: handle.fd,
      identity: descriptorIdentity(before),
    }));
    return { body, stat: before };
  } finally {
    await handle.close();
  }
}

export async function copyVerifiedDescriptor(
  source,
  destinationDirectory,
  name,
  expected,
  replace
) {
  const destination = descriptorChildPath(destinationDirectory, name);
  const staging = descriptorChildPath(destinationDirectory, `${name}.restore-copy`);
  await unlinkIfPresent(staging);
  const sourceHandle = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  let destinationHandle;
  try {
    const before = await sourceHandle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== expected.byteLength ||
      (before.mode & 0o777) !== expected.mode ||
      before.size > MAX_ENTRY_BYTES
    ) {
      throw new Error('stopped_stack_archive_entry_identity_mismatch');
    }
    if ((await hashDescriptor(sourceHandle, before.size)) !== expected.sha256) {
      throw new Error('stopped_stack_archive_checksum_mismatch');
    }
    destinationHandle = await open(
      staging,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      expected.mode
    );
    const copiedHash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const length = Math.min(buffer.byteLength, before.size - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, length, position);
      if (bytesRead === 0) throw new Error('stopped_stack_archive_entry_truncated');
      copiedHash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written
        );
        if (bytesWritten === 0) throw new Error('stopped_stack_archive_entry_write_truncated');
        written += bytesWritten;
      }
      position += bytesRead;
    }
    const after = await sourceHandle.stat();
    if (!sameDescriptorState(before, after) || copiedHash.digest('hex') !== expected.sha256) {
      throw new Error('stopped_stack_archive_entry_changed_during_copy');
    }
    await destinationHandle.sync();
    await destinationHandle.chmod(expected.mode);
    await destinationHandle.close();
    destinationHandle = undefined;
    if (!replace) await assertAbsent(destination);
    await rename(staging, destination);
    await destinationDirectory.sync();
  } catch (error) {
    await unlinkIfPresent(staging);
    throw error;
  } finally {
    await destinationHandle?.close();
    await sourceHandle.close();
  }
}

export async function copyVerifiedInventoryEntry(root, inventory, entry, destinationRoot, replace) {
  const sourceHandles = [];
  const destinationHandles = [];
  try {
    const rootHandle = await openDirectoryBound(root);
    sourceHandles.push(rootHandle);
    assertDescriptorIdentity(await rootHandle.stat(), inventory.directoryIdentities.get(''));
    const destinationRootHandle =
      typeof destinationRoot === 'string'
        ? await openDirectoryBound(destinationRoot)
        : destinationRoot;
    if (typeof destinationRoot === 'string') destinationHandles.push(destinationRootHandle);
    const components = entry.path.split('/');
    let relativeDirectory = '';
    for (const component of components.slice(0, -1)) {
      const directoryHandle = await openChildDirectory(sourceHandles.at(-1), component);
      sourceHandles.push(directoryHandle);
      const destinationDirectory = await openOrCreateChildDirectory(
        destinationHandles.at(-1) ?? destinationRootHandle,
        component
      );
      destinationHandles.push(destinationDirectory);
      relativeDirectory = relativeDirectory ? `${relativeDirectory}/${component}` : component;
      assertDescriptorIdentity(
        await directoryHandle.stat(),
        inventory.directoryIdentities.get(relativeDirectory)
      );
    }
    await copyVerifiedDescriptor(
      descriptorChildPath(sourceHandles.at(-1), components.at(-1)),
      destinationHandles.at(-1) ?? destinationRootHandle,
      components.at(-1),
      entry,
      replace
    );
  } finally {
    for (const handle of destinationHandles.reverse()) await handle.close();
    for (const handle of sourceHandles.reverse()) await handle.close();
  }
}

export async function readVerifiedInventoryEntry(root, inventory, relativePath, maximumBytes) {
  const handles = [];
  try {
    const rootHandle = await openDirectoryBound(root);
    handles.push(rootHandle);
    assertDescriptorIdentity(await rootHandle.stat(), inventory.directoryIdentities.get(''));
    const components = relativePath.split('/');
    let relativeDirectory = '';
    for (const component of components.slice(0, -1)) {
      const directoryHandle = await openChildDirectory(handles.at(-1), component);
      handles.push(directoryHandle);
      relativeDirectory = relativeDirectory ? `${relativeDirectory}/${component}` : component;
      assertDescriptorIdentity(
        await directoryHandle.stat(),
        inventory.directoryIdentities.get(relativeDirectory)
      );
    }
    return await readDescriptorBound(
      descriptorChildPath(handles.at(-1), components.at(-1)),
      maximumBytes
    );
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

export async function openDirectoryBound(path) {
  // Node does not expose openat(2), but Linux's descriptor namespace provides
  // the same important property here.  Open every ancestor from an already
  // held directory FD; after this point callers never traverse the original
  // pathname (which may be renamed or replaced by an attacker).
  const absolute = resolve(path);
  const inheritedDescriptor = /^\/proc\/self\/fd\/([0-9]+)(?:\/(.*))?$/u.exec(absolute);
  if (inheritedDescriptor) {
    // This spelling can only name an FD already open in this process.  It is
    // not a pathname fallback; opening it duplicates the descriptor authority.
    let handle = await open(`/proc/self/fd/${inheritedDescriptor[1]}`, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      for (const part of (inheritedDescriptor[2] ?? '').split('/').filter(Boolean)) {
        const child = await open(descriptorChildPath(handle, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await handle.close(); handle = child;
      }
      const pathStat = await handle.stat();
      if (!pathStat.isDirectory()) throw new Error('recovery_directory_invalid');
      Object.defineProperty(handle, 'recoveryIdentity', { value: descriptorIdentity(pathStat), enumerable: false });
      return handle;
    } catch (error) { await handle.close().catch(() => {}); throw error; }
  }
  const parts = absolute.split('/').filter(Boolean);
  let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of parts) {
      const child = await open(
        descriptorChildPath(handle, part),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      await handle.close();
      handle = child;
    }
    const pathStat = await handle.stat();
    if (!pathStat.isDirectory()) throw new Error('recovery_directory_invalid');
    Object.defineProperty(handle, 'recoveryIdentity', {
      value: descriptorIdentity(pathStat),
      enumerable: false,
    });
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function tryOpenChildDirectory(parentHandle, name) {
  try {
    return await openChildDirectory(parentHandle, name);
  } catch (error) {
    if (error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

export async function openChildDirectory(parentHandle, name) {
  validateComponentName(name);
  await assertHeldDirectory(parentHandle);
  return await openDirectoryBound(descriptorChildPath(parentHandle, name));
}

export async function openOrCreateChildDirectory(parentHandle, name) {
  await assertHeldDirectory(parentHandle);
  try {
    const existing = await openChildDirectory(parentHandle, name);
    try {
      // Reusing a child is an advance point just like creating one.  The
      // caller may only rely on its name after the parent entry has been
      // synchronized and still resolves to the descriptor we opened.
      await syncAndRevalidateChildDirectory(parentHandle, name, existing);
      return existing;
    } catch (error) {
      await existing.close().catch(() => {});
      throw error;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(descriptorChildPath(parentHandle, name), { mode: 0o700 });
  await parentHandle.sync();
  const created = await openChildDirectory(parentHandle, name);
  try {
    await syncAndRevalidateChildDirectory(parentHandle, name, created);
    return created;
  } catch (error) {
    await created.close().catch(() => {});
    throw error;
  }
}

export function descriptorPath(handle) {
  if (!Number.isInteger(handle?.fd) || handle.fd < 0) {
    throw new Error('recovery_directory_descriptor_invalid');
  }
  // Deliberately no pathname fallback.  Every descendant operation is rooted
  // in this open descriptor, including after the source path is renamed.
  return `/proc/self/fd/${handle.fd}`;
}

export function descriptorChildPath(handle, name) {
  validateComponentName(name);
  return join(descriptorPath(handle), name);
}

export function descriptorIdentity(pathStat) {
  return Object.freeze({ dev: pathStat.dev, ino: pathStat.ino });
}

export async function writeExclusiveDurableFile(path, body, mode) {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode
  );
  try {
    if (typeof body === 'string') await handle.writeFile(body, 'utf8');
    else await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

export async function writeExclusiveDurableFileAt(parentHandle, name, body, mode) {
  await assertHeldDirectory(parentHandle);
  const path = descriptorChildPath(parentHandle, name);
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode
  );
  try {
    if (typeof body === 'string') await handle.writeFile(body, 'utf8');
    else await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await parentHandle.sync();
}

/**
 * A recovered complete staging file is not evidence that its bytes reached
 * stable storage. Re-read and fsync the exact held inode, then fsync and
 * revalidate its containing directory entry before a caller promotes it.
 */
export async function syncAndRevalidateRegularFileAt(parentHandle, name, expectedBody) {
  await assertHeldDirectory(parentHandle);
  const parentBefore = await parentHandle.stat();
  const path = descriptorChildPath(parentHandle, name);
  const expected = Buffer.isBuffer(expectedBody) ? expectedBody : Buffer.from(expectedBody, 'utf8');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 0 || before.size > MAX_ENTRY_BYTES || before.size !== expected.byteLength) {
      throw new Error('recovery_file_invalid');
    }
    const body = await readExactDescriptor(handle, Number(before.size));
    const afterRead = await handle.stat();
    if (!sameDescriptorState(before, afterRead) || !body.equals(expected)) {
      throw new Error('recovery_file_changed_during_read');
    }
    await handle.sync();
    const afterSync = await handle.stat();
    if (!sameDescriptorState(before, afterSync)) {
      throw new Error('recovery_file_changed_during_sync');
    }
    // Persist the name after the exact inode. A file fsync alone does not make
    // a recovered staging name survive a power loss.
    await parentHandle.sync();
    await assertHeldDirectory(parentHandle);
    const parentAfterSync = await parentHandle.stat();
    if (!sameDescriptorState(parentBefore, parentAfterSync)) {
      throw new Error('recovery_directory_changed_during_sync');
    }
    // Recheck the content *after both fsyncs*, then bind the pending rename to
    // the same directory entry while both descriptors remain held. A
    // replaced/symlinked entry cannot be promoted as recovered state.
    const verified = await readExactDescriptor(handle, Number(before.size));
    const afterVerify = await handle.stat();
    const named = await lstat(path);
    if (!sameDescriptorState(before, afterVerify) || !verified.equals(expected) ||
      !named.isFile() || !sameDescriptorState(before, named)) {
      throw new Error('recovery_file_entry_changed_during_sync');
    }
  } finally {
    await handle.close();
  }
}

/**
 * Promote a recovered directory only after every expected member and both the
 * staging directory and its parent entry have been made durable again. This is
 * deliberately stricter than a directory inventory check: complete bytes in
 * page cache are not a durable secret generation.
 */
export async function syncAndRevalidateDirectoryFilesAt(parentHandle, name, expectedFiles) {
  await assertHeldDirectory(parentHandle);
  const parentBefore = await parentHandle.stat();
  const expectedNames = Object.keys(expectedFiles).sort();
  const path = descriptorChildPath(parentHandle, name);
  const directoryHandle = await openChildDirectory(parentHandle, name);
  const members = [];
  try {
    const before = await directoryHandle.stat();
    const entries = (await readBoundedDirectoryEntries(directoryHandle, expectedNames.length)).sort();
    if (entries.length !== expectedNames.length || entries.some((entry, index) => entry !== expectedNames[index])) {
      throw new Error('stopped_stack_restore_secret_staging_invalid');
    }
    for (const entry of expectedNames) {
      const expected = Buffer.isBuffer(expectedFiles[entry])
        ? expectedFiles[entry]
        : Buffer.from(expectedFiles[entry], 'utf8');
      const handle = await open(
        descriptorChildPath(directoryHandle, entry),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const identity = await handle.stat();
        if (
          !identity.isFile() ||
          identity.size < 0 ||
          identity.size > MAX_ENTRY_BYTES ||
          identity.size !== expected.byteLength
        ) {
          throw new Error('recovery_file_invalid');
        }
        const contents = await readExactDescriptor(handle, Number(identity.size));
        const afterRead = await handle.stat();
        if (!sameDescriptorState(identity, afterRead) || !contents.equals(expected)) {
          throw new Error('recovery_file_changed_during_read');
        }
        await handle.sync();
        const afterSync = await handle.stat();
        if (!sameDescriptorState(identity, afterSync)) {
          throw new Error('recovery_file_changed_during_sync');
        }
        // Keep this exact member descriptor open through the final parent
        // fsync.  Reopening by name before that sync leaves a replacement
        // window in which a different secret generation could be promoted.
        members.push({ entry, expected, handle, identity });
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
    }
    // Persist the generation directory only after all retained member inodes
    // are synchronized, then persist the staging directory entry in its
    // parent.  The retained descriptors below prove those exact contents
    // survived until after that final parent fsync.
    await directoryHandle.sync();
    const afterSync = await directoryHandle.stat();
    if (!sameDescriptorState(before, afterSync)) {
      throw new Error('recovery_directory_changed_during_sync');
    }
    await parentHandle.sync();
    await assertHeldDirectory(parentHandle);
    const parentAfterSync = await parentHandle.stat();
    const named = await lstat(path);
    if (!sameDescriptorState(parentBefore, parentAfterSync) ||
      !named.isDirectory() || named.dev !== before.dev || named.ino !== before.ino) {
      throw new Error('recovery_directory_entry_changed_during_sync');
    }
    const recheckedEntries = (await readBoundedDirectoryEntries(directoryHandle, expectedNames.length)).sort();
    if (recheckedEntries.length !== expectedNames.length ||
      recheckedEntries.some((entry, index) => entry !== expectedNames[index])) {
      throw new Error('stopped_stack_restore_secret_staging_invalid');
    }
    // This is intentionally after the final parent fsync.  Both the retained
    // descriptor and the current directory entry must still name the original
    // secret member and contain its journal-bound bytes.
    for (const member of members) {
      const contents = await readExactDescriptor(member.handle, Number(member.identity.size));
      const afterVerify = await member.handle.stat();
      const namedMember = await lstat(descriptorChildPath(directoryHandle, member.entry));
      if (
        !sameDescriptorState(member.identity, afterVerify) ||
        !contents.equals(member.expected) ||
        !namedMember.isFile() ||
        !sameDescriptorState(member.identity, namedMember)
      ) {
        throw new Error('recovery_file_entry_changed_during_sync');
      }
    }
    const directoryAfterVerify = await directoryHandle.stat();
    const namedAfterVerify = await lstat(path);
    if (
      !sameDescriptorState(before, directoryAfterVerify) ||
      !namedAfterVerify.isDirectory() ||
      !sameDescriptorState(before, namedAfterVerify)
    ) {
      throw new Error('recovery_directory_entry_changed_during_sync');
    }
  } finally {
    for (const member of members.reverse()) await member.handle.close();
    await directoryHandle.close();
  }
}

export async function unlinkDescriptorEntry(parentHandle, name) {
  await assertHeldDirectory(parentHandle);
  await unlinkIfPresent(descriptorChildPath(parentHandle, name));
}

export async function assertDirectoryContainsOnlyOptionalEmptyChild(
  rootHandle,
  ignoredName,
  optionalEmptyChild
) {
  await assertHeldDirectory(rootHandle);
  const entries = await readBoundedDirectoryEntries(rootHandle, 2);
  const unexpected = entries.filter((entry) => entry !== ignoredName);
  if (unexpected.length === 0) return;
  if (unexpected.length !== 1 || unexpected[0] !== optionalEmptyChild) {
    throw new Error('stopped_stack_restore_target_not_empty');
  }
  const childHandle = await openChildDirectory(rootHandle, optionalEmptyChild);
  try {
    if ((await readBoundedDirectoryEntries(childHandle, 1)).length > 0) {
      throw new Error('stopped_stack_restore_target_not_empty');
    }
  } finally {
    await childHandle.close();
  }
}

export async function removeDirectoryContainingOnly(parentHandle, name, allowedEntries) {
  await assertHeldDirectory(parentHandle);
  let directoryHandle;
  try {
    directoryHandle = await openChildDirectory(parentHandle, name);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  try {
    const entries = await readBoundedDirectoryEntries(directoryHandle, allowedEntries.length);
    if (entries.some((entry) => !allowedEntries.includes(entry))) {
      throw new Error('stopped_stack_restore_secret_staging_invalid');
    }
    for (const entry of entries) await unlinkDescriptorEntry(directoryHandle, entry);
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  await rmdir(descriptorChildPath(parentHandle, name));
  await parentHandle.sync();
}

export async function syncCopiedTreeDirectories(stagingRoot, entries) {
  const payloadRoot = join(stagingRoot, 'payload');
  const directories = new Set([payloadRoot]);
  for (const entry of entries) {
    let directory = dirname(join(payloadRoot, ...entry.path.split('/')));
    while (directory.startsWith(`${payloadRoot}/`)) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  const deepestFirst = [...directories].sort(
    (left, right) => right.split('/').length - left.split('/').length
  );
  for (const directory of deepestFirst) await syncDirectory(directory);
  await syncDirectory(stagingRoot);
}

export async function verifySqliteSnapshots(entries, sqliteSnapshots) {
  const sqliteEntries = entries.filter((entry) => entry.path.endsWith('.db'));
  if (sqliteEntries.length === 0) return;
  let Constructor;
  try { Constructor = (await import('better-sqlite3')).default; } catch { Constructor = undefined; }
  const { DatabaseSync } = await import('node:sqlite');
  for (const entry of sqliteEntries) {
    const snapshot = sqliteSnapshots.get(entry.path);
    if (!snapshot) throw new Error('stopped_stack_archive_sqlite_snapshot_missing');
    await chmod(snapshot, 0o400);
    let database;
    try { database = Constructor ? new Constructor(snapshot, { fileMustExist: true, readonly: true }) : undefined; }
    catch { database = undefined; }
    if (!database) {
      const native = new DatabaseSync(snapshot, { readOnly: true });
      database = {
        pragma(value, options = {}) {
          const statement = native.prepare(`PRAGMA ${value}`);
          return options.simple ? Object.values(statement.get() ?? {})[0] : statement.all();
        },
        close() { native.close(); },
      };
    }
    try {
      if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
        throw new Error('stopped_stack_archive_sqlite_integrity_failed');
      }
    } finally {
      database.close();
    }
  }
}

export async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hashDescriptor(handle, byteLength) {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < byteLength) {
    const length = Math.min(buffer.byteLength, byteLength - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) throw new Error('stopped_stack_archive_entry_truncated');
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest('hex');
}

async function readExactDescriptor(handle, byteLength) {
  const body = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < body.byteLength) {
    const { bytesRead } = await handle.read(body, offset, body.byteLength - offset, offset);
    if (bytesRead === 0) throw new Error('recovery_file_truncated');
    offset += bytesRead;
  }
  return body;
}

async function syncAndRevalidateChildDirectory(parentHandle, name, childHandle) {
  const parentBefore = await parentHandle.stat();
  const childBefore = await childHandle.stat();
  if (!childBefore.isDirectory()) throw new Error('recovery_directory_invalid');
  await parentHandle.sync();
  await assertHeldDirectory(parentHandle);
  const parentAfter = await parentHandle.stat();
  const childAfter = await childHandle.stat();
  const named = await lstat(descriptorChildPath(parentHandle, name));
  if (
    !sameDescriptorState(parentBefore, parentAfter) ||
    !sameDescriptorState(childBefore, childAfter) ||
    !named.isDirectory() ||
    !sameDescriptorState(childBefore, named)
  ) {
    throw new Error('recovery_directory_entry_changed_during_sync');
  }
}

function sameDescriptorState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertDescriptorIdentity(pathStat, expected) {
  if (!expected || pathStat.dev !== expected.dev || pathStat.ino !== expected.ino) {
    throw new Error('stopped_stack_archive_directory_identity_mismatch');
  }
}

function validateComponentName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/')
  ) {
    throw new Error('recovery_relative_path_invalid');
  }
}

async function unlinkIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertHeldDirectory(handle) {
  if (!handle?.recoveryIdentity) return;
  const current = await handle.stat();
  if (!current.isDirectory() || current.dev !== handle.recoveryIdentity.dev || current.ino !== handle.recoveryIdentity.ino) {
    throw new Error('recovery_directory_ancestor_replaced');
  }
}

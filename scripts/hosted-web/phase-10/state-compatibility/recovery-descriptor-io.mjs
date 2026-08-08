import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

export async function assertAbsent(path) {
  try {
    await lstat(path);
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

export async function readDescriptorBound(path, maximumBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) {
      throw new Error('recovery_file_invalid');
    }
    const body = await handle.readFile();
    const after = await handle.stat();
    if (!sameDescriptorState(before, after) || body.byteLength !== before.size) {
      throw new Error('recovery_file_changed_during_read');
    }
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
      await destinationHandle.write(buffer, 0, bytesRead, position);
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
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  const pathStat = await handle.stat();
  if (!pathStat.isDirectory()) {
    await handle.close();
    throw new Error('recovery_directory_invalid');
  }
  return handle;
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
  return await openDirectoryBound(descriptorChildPath(parentHandle, name));
}

export async function openOrCreateChildDirectory(parentHandle, name) {
  try {
    return await openChildDirectory(parentHandle, name);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(descriptorChildPath(parentHandle, name), { mode: 0o700 });
  await parentHandle.sync();
  return await openChildDirectory(parentHandle, name);
}

export function descriptorPath(handle) {
  return `/proc/self/fd/${handle.fd}`;
}

export function descriptorChildPath(handle, name) {
  validateComponentName(name);
  return `${descriptorPath(handle)}/${name}`;
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

export async function unlinkDescriptorEntry(parentHandle, name) {
  await unlinkIfPresent(descriptorChildPath(parentHandle, name));
}

export async function assertDirectoryContainsOnlyOptionalEmptyChild(
  rootHandle,
  ignoredName,
  optionalEmptyChild
) {
  const entries = await readdir(descriptorPath(rootHandle));
  const unexpected = entries.filter((entry) => entry !== ignoredName);
  if (unexpected.length === 0) return;
  if (unexpected.length !== 1 || unexpected[0] !== optionalEmptyChild) {
    throw new Error('stopped_stack_restore_target_not_empty');
  }
  const childHandle = await openChildDirectory(rootHandle, optionalEmptyChild);
  try {
    if ((await readdir(descriptorPath(childHandle))).length > 0) {
      throw new Error('stopped_stack_restore_target_not_empty');
    }
  } finally {
    await childHandle.close();
  }
}

export async function removeDirectoryContainingOnly(parentHandle, name, allowedEntries) {
  let directoryHandle;
  try {
    directoryHandle = await openChildDirectory(parentHandle, name);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  try {
    const entries = await readdir(descriptorPath(directoryHandle));
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
  const module = await import('better-sqlite3');
  const Constructor = module.default;
  for (const entry of sqliteEntries) {
    const snapshot = sqliteSnapshots.get(entry.path);
    if (!snapshot) throw new Error('stopped_stack_archive_sqlite_snapshot_missing');
    await chmod(snapshot, 0o400);
    const database = new Constructor(snapshot, { fileMustExist: true, readonly: true });
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

function sameDescriptorState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
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

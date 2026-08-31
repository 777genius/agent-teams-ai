#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEGACY_HOSTED_OWNER_LOCK_FILENAME,
  MAX_LOCK_BYTES,
  OWNER_LOCK_FILENAME,
  STACK_LOCK_FILENAME,
  verifyHostedLockPair,
} from './contracts.mjs';

export async function verifyHostedLocksAtRoot(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const ancestry = await snapshotDirectoryAncestry(resolvedRoot);
  const ownerPath = path.join(resolvedRoot, OWNER_LOCK_FILENAME);
  const stackPath = path.join(resolvedRoot, STACK_LOCK_FILENAME);
  const legacyPath = path.join(resolvedRoot, LEGACY_HOSTED_OWNER_LOCK_FILENAME);

  const legacyEntry = await inspectEntry(legacyPath);
  if (legacyEntry !== null) {
    throw new Error(
      `${LEGACY_HOSTED_OWNER_LOCK_FILENAME} is superseded; ` +
        `materialize ${OWNER_LOCK_FILENAME} instead`
    );
  }

  const entries = await Promise.all([inspectEntry(ownerPath), inspectEntry(stackPath)]);
  if (options.onEntriesInspected) await options.onEntriesInspected();
  if (entries.every((entry) => entry === null) && options.ifPresent === true) {
    await assertDirectoryAncestryUnchanged(ancestry);
    await assertEntriesUnchanged(
      [legacyPath, ownerPath, stackPath],
      [legacyEntry, entries[0], entries[1]]
    );
    return { status: 'absent' };
  }
  if (entries.some((entry) => entry === null)) {
    throw new Error(
      `${OWNER_LOCK_FILENAME} and ${STACK_LOCK_FILENAME} must either both exist or both be absent`
    );
  }

  if (sameIdentity(entries[0], entries[1])) {
    throw new Error(`${OWNER_LOCK_FILENAME} and ${STACK_LOCK_FILENAME} must be distinct files`);
  }

  const readResults = await Promise.allSettled([
    readStableLockFile(ownerPath, entries[0], options),
    readStableLockFile(stackPath, entries[1], options),
  ]);
  const failedRead = readResults.find((result) => result.status === 'rejected');
  if (failedRead) throw failedRead.reason;
  const [ownerBytes, stackBytes] = readResults.map((result) => result.value);
  verifyHostedLockPair(ownerBytes, stackBytes);
  await assertDirectoryAncestryUnchanged(ancestry);
  await assertEntriesUnchanged(
    [legacyPath, ownerPath, stackPath],
    [legacyEntry, entries[0], entries[1]]
  );
  return { status: 'verified' };
}

async function assertEntriesUnchanged(filePaths, expectedEntries) {
  const currentEntries = await Promise.all(filePaths.map((filePath) => inspectEntry(filePath)));
  for (let index = 0; index < filePaths.length; index += 1) {
    const expected = expectedEntries[index];
    const current = currentEntries[index];
    if (expected === null || current === null) {
      if (expected !== current) {
        throw new Error(
          `${path.basename(filePaths[index])} appeared or disappeared during verification`
        );
      }
      continue;
    }
    assertSameMetadata(expected, current, filePaths[index]);
  }
}

async function inspectEntry(filePath) {
  try {
    const entry = await lstat(filePath, { bigint: true });
    if (!entry.isFile()) {
      throw new Error(`${path.basename(filePath)} must be a regular file and not a symlink`);
    }
    if (entry.nlink !== 1n) {
      throw new Error(`${path.basename(filePath)} must not be a hard-linked file`);
    }
    if (entry.size > BigInt(MAX_LOCK_BYTES)) {
      throw new Error(`${path.basename(filePath)} exceeds the ${MAX_LOCK_BYTES}-byte limit`);
    }
    return entry;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readStableLockFile(filePath, entryBefore, options) {
  if (
    !Number.isInteger(constants.O_NOFOLLOW) ||
    constants.O_NOFOLLOW === 0 ||
    !Number.isInteger(constants.O_NONBLOCK) ||
    constants.O_NONBLOCK === 0
  ) {
    throw new Error('secure lock verification requires no-follow, non-blocking file opens');
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const descriptorBefore = await handle.stat({ bigint: true });
    assertSameMetadata(entryBefore, descriptorBefore, filePath);
    if (!descriptorBefore.isFile()) {
      throw new Error(`${path.basename(filePath)} must be a regular file`);
    }
    if (descriptorBefore.size > BigInt(MAX_LOCK_BYTES)) {
      throw new Error(`${path.basename(filePath)} exceeds the ${MAX_LOCK_BYTES}-byte limit`);
    }

    if (options.onFileOpened) await options.onFileOpened(path.basename(filePath));

    const expectedSize = Number(descriptorBefore.size);
    const bytes = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const result = await handle.read(bytes, offset, expectedSize - offset, offset);
      if (result.bytesRead === 0) {
        throw new Error(`${path.basename(filePath)} changed while it was being read`);
      }
      offset += result.bytesRead;
    }

    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, expectedSize)).bytesRead !== 0) {
      throw new Error(`${path.basename(filePath)} changed while it was being read`);
    }

    const descriptorAfter = await handle.stat({ bigint: true });
    assertSameMetadata(descriptorBefore, descriptorAfter, filePath);
    const entryAfter = await inspectEntry(filePath);
    if (entryAfter === null) {
      throw new Error(`${path.basename(filePath)} disappeared while it was being read`);
    }
    assertSameMetadata(descriptorAfter, entryAfter, filePath);
    if (options.onFileRead) await options.onFileRead(path.basename(filePath));
    return bytes;
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error(`${path.basename(filePath)} must not be a symlink`);
    }
    throw error;
  } finally {
    await handle?.close();
    if (options.onFileClosed) await options.onFileClosed(path.basename(filePath));
  }
}

async function snapshotDirectoryAncestry(root) {
  const parsed = path.parse(root);
  const paths = [parsed.root];
  let current = parsed.root;
  for (const segment of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    paths.push(current);
  }

  return Promise.all(
    paths.map(async (directoryPath) => {
      const metadata = await lstat(directoryPath, { bigint: true });
      if (!metadata.isDirectory()) {
        throw new Error(
          `${directoryPath}: lock root ancestry must contain only directories, not symlinks`
        );
      }
      return { directoryPath, metadata };
    })
  );
}

async function assertDirectoryAncestryUnchanged(ancestry) {
  for (const { directoryPath, metadata } of ancestry) {
    const current = await lstat(directoryPath, { bigint: true });
    if (!current.isDirectory()) {
      throw new Error(`${directoryPath}: lock root ancestry changed during verification`);
    }
    // Shared ancestors such as /tmp change when unrelated jobs create files.
    // Only directory identity/type/permissions bind ancestry, not content timestamps.
    if (
      metadata.dev !== current.dev ||
      metadata.ino !== current.ino ||
      metadata.mode !== current.mode
    ) {
      throw new Error(`${directoryPath}: lock root ancestry identity changed during verification`);
    }
  }
}

function assertSameMetadata(expected, actual, filePath) {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.mode !== actual.mode ||
    expected.nlink !== actual.nlink ||
    expected.size !== actual.size ||
    expected.mtimeNs !== actual.mtimeNs ||
    expected.ctimeNs !== actual.ctimeNs
  ) {
    throw new Error(`${filePath}: identity or metadata changed during verification`);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function parseArguments(argv) {
  let root = process.cwd();
  let ifPresent = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--if-present') {
      ifPresent = true;
    } else if (argument === '--root') {
      const next = argv[index + 1];
      if (!next) throw new Error('--root requires a directory');
      root = path.resolve(next);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { root, ifPresent };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await verifyHostedLocksAtRoot(options.root, options);
    process.stdout.write(
      result.status === 'absent'
        ? 'Hosted release locks are not materialized; verification skipped.\n'
        : 'Hosted release locks verified.\n'
    );
  } catch (error) {
    process.stderr.write(`Hosted release lock verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEGACY_HOSTED_OWNER_LOCK_FILENAME,
  OWNER_LOCK_FILENAME,
  STACK_LOCK_FILENAME,
  verifyHostedLockPair,
} from './contracts.mjs';

export async function verifyHostedLocksAtRoot(root, options = {}) {
  const ownerPath = path.join(root, OWNER_LOCK_FILENAME);
  const stackPath = path.join(root, STACK_LOCK_FILENAME);
  const legacyPath = path.join(root, LEGACY_HOSTED_OWNER_LOCK_FILENAME);

  if (await exists(legacyPath)) {
    throw new Error(
      `${LEGACY_HOSTED_OWNER_LOCK_FILENAME} is superseded; ` +
        `materialize ${OWNER_LOCK_FILENAME} instead`
    );
  }

  const present = await Promise.all([exists(ownerPath), exists(stackPath)]);
  if (present.every((value) => !value) && options.ifPresent === true) {
    return { status: 'absent' };
  }
  if (!present.every(Boolean)) {
    throw new Error(
      `${OWNER_LOCK_FILENAME} and ${STACK_LOCK_FILENAME} must either both exist or both be absent`
    );
  }

  const [ownerBytes, stackBytes] = await Promise.all([readFile(ownerPath), readFile(stackPath)]);
  verifyHostedLockPair(ownerBytes, stackBytes);
  return { status: 'verified' };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
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

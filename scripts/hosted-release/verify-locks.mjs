#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCommittedHostedLockPair } from './contracts.mjs';

/**
 * The release verifier intentionally has one reader: the committed-generation
 * resolver. Root-level pair files and bare transaction directories are never
 * verification inputs.
 */
export async function verifyHostedLocksAtRoot(root, options = {}) {
  const pair = await resolveCommittedHostedLockPair(path.resolve(root), {
    ifPresent: options.ifPresent,
    onMarkerRead: options.onMarkerRead,
    onGenerationOpened: options.onGenerationOpened,
  });
  return pair ? { status: 'verified' } : { status: 'absent' };
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

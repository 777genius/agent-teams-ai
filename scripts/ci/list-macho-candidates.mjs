#!/usr/bin/env node
// Lists the regular files of a bundle whose first four bytes are a Mach-O or
// universal-binary magic number. verify-macos-signing.sh asks file(1) about
// every candidate; this pre-filter only avoids running file(1) over the ~95k
// runtime files, which took up to 33 minutes per bundle on Intel runners.
// The kernel and dyld load code only from files that start with one of these
// magic numbers, so every loadable binary is a candidate. file(1) can also
// report Mach-O for data wrapped in another format (for example a zstd
// skippable frame); such a file is not loadable code and is not a candidate.
//
// Output, each value NUL-terminated: the regular-file count, the candidate
// count, then the candidate paths. Paths are built like find(1) prints them,
// as the root followed by "/name", without normalization.
import { closeSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MACH_O_MAGIC_NUMBERS = new Set([
  // Thin Mach-O, 32/64-bit, both byte orders.
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe,
  // Universal binaries, 32/64-bit, both byte orders, and GPU universal binaries.
  0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca, 0xcbfebabe,
]);

function readMagicNumber(filePath, buffer) {
  const descriptor = openSync(filePath, 'r');
  try {
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (bytesRead === 0) {
        return null;
      }
      length += bytesRead;
    }
    return buffer.readUInt32BE(0);
  } finally {
    closeSync(descriptor);
  }
}

export function listMachOCandidates(root) {
  const buffer = Buffer.alloc(4);
  const candidates = [];
  const pending = [root];
  let regularFiles = 0;

  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        regularFiles += 1;
        if (MACH_O_MAGIC_NUMBERS.has(readMagicNumber(entryPath, buffer))) {
          candidates.push(entryPath);
        }
      }
    }
  }

  return { regularFiles, candidates: candidates.sort() };
}

function main(argv) {
  if (argv.length !== 1) {
    throw new Error('Usage: list-macho-candidates.mjs BUNDLE_DIRECTORY');
  }
  const { regularFiles, candidates } = listMachOCandidates(argv[0]);
  const values = [String(regularFiles), String(candidates.length), ...candidates];
  process.stdout.write(values.map((value) => `${value}\0`).join(''));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

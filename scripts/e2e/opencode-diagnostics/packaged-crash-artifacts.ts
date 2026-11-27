import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Stats } from 'node:fs';

export const CRASH_ARTIFACT_LIMITS = Object.freeze({
  manifestBytes: 1024 * 1024,
  entries: 256,
  depth: 8,
  files: 16,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
});

type State = 'absent' | 'empty' | 'collected' | 'error' | 'over-limit';
interface Dump {
  source: string;
  artifact: string;
  sha256: string;
  bytes: number;
  mtimeMs: number;
}
export interface CrashArtifactReceipt {
  schemaVersion: 1;
  observationOnly: true;
  association: 'original-test-profile-only';
  source: 'user-data/crashes';
  state: State;
  reason?: string;
  outputDirectory?: string;
  dumps: Dump[];
}

class CollectionFailure extends Error {
  readonly state: State;
  constructor(reason: string, state: State = 'error') {
    super(reason);
    this.state = state;
  }
}

function requireFact(value: unknown, reason: string): asserts value {
  if (!value) throw new CollectionFailure(reason);
}

function directory(location: string, original?: Stats): Stats {
  const current = lstatSync(location);
  requireFact(current.isDirectory() && !current.isSymbolicLink(), 'directory-link-or-type');
  requireFact(path.relative(location, realpathSync(location)) === '', 'directory-escape');
  if (original)
    requireFact(current.dev === original.dev && current.ino === original.ino, 'directory-replaced');
  return current;
}

function sameFile(before: Stats, after: Stats): void {
  requireFact(after.isFile() && !after.isSymbolicLink(), 'file-link-or-type');
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'] as const)
    requireFact(before[field] === after[field], 'file-changed');
}

function stableBytes(
  location: string,
  maximum: number,
  assertParents: () => void,
  expected?: Stats
): Buffer {
  assertParents();
  const before = lstatSync(location);
  requireFact(
    before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
    'file-link-or-type'
  );
  if (before.size > maximum) throw new CollectionFailure('file-bytes', 'over-limit');
  if (expected) sameFile(expected, before);
  const fd = openSync(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    sameFile(before, fstatSync(fd));
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    assertParents();
    sameFile(before, fstatSync(fd));
    sameFile(before, lstatSync(location));
    requireFact(length === before.size, 'file-changed');
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

const portable = (value: string) => value.split(path.sep).join('/');

/** Filesystem observation after the existing harness has finished; no process or crash-reporter APIs. */
export function collectPackagedCrashArtifacts(requestedRoot: string): CrashArtifactReceipt {
  const receipt: CrashArtifactReceipt = {
    schemaVersion: 1,
    observationOnly: true,
    association: 'original-test-profile-only',
    source: 'user-data/crashes',
    state: 'error',
    dumps: [],
  };
  let output: string | undefined;
  let assertOutput: (() => void) | undefined;
  try {
    requireFact(
      requestedRoot.length <= 4096 && path.isAbsolute(requestedRoot),
      'invalid-qualification-root'
    );
    const root = path.resolve(requestedRoot);
    requireFact(
      path.basename(root).startsWith('opencode-diagnostics-e2e-'),
      'invalid-qualification-root'
    );
    const rootIdentity = directory(root);
    const assertRoot = () => {
      directory(root, rootIdentity);
    };
    const manifest: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        stableBytes(
          path.join(root, 'manifest.json'),
          CRASH_ARTIFACT_LIMITS.manifestBytes,
          assertRoot
        )
      )
    );
    requireFact(
      manifest && typeof manifest === 'object' && !Array.isArray(manifest),
      'invalid-manifest'
    );
    const data = manifest as Record<string, unknown>;
    const userData = path.join(root, 'user-data');
    requireFact(
      data.root === root &&
        data.userData === userData &&
        data.packaged === true &&
        data.platform === 'win32',
      'misbound-manifest'
    );
    assertRoot();
    output = mkdtempSync(path.join(root, 'crash-artifacts-'));
    const outputIdentity = directory(output);
    receipt.outputDirectory = portable(path.relative(root, output));
    assertOutput = () => {
      assertRoot();
      directory(output!, outputIdentity);
    };
    const userIdentity = directory(userData);
    const crashRoot = path.join(userData, 'crashes');
    let crashIdentity: Stats;
    try {
      crashIdentity = directory(crashRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      receipt.state = 'absent';
      return retain();
    }
    const assertSource = () => {
      assertRoot();
      directory(userData, userIdentity);
      directory(crashRoot, crashIdentity);
    };
    const pending = [{ location: crashRoot, depth: 0 }];
    const dumps: { location: string; identity: Stats }[] = [];
    let entries = 0;
    let totalBytes = 0;
    while (pending.length) {
      const selected = pending.pop()!;
      assertSource();
      directory(selected.location);
      const opened = opendirSync(selected.location, { bufferSize: 16 });
      try {
        for (let entry = opened.readSync(); entry; entry = opened.readSync()) {
          if (++entries > CRASH_ARTIFACT_LIMITS.entries)
            throw new CollectionFailure('directory-entries', 'over-limit');
          const location = path.join(selected.location, entry.name);
          const identity = lstatSync(location);
          requireFact(!identity.isSymbolicLink(), 'directory-link-or-type');
          if (identity.isDirectory()) {
            if (selected.depth >= CRASH_ARTIFACT_LIMITS.depth)
              throw new CollectionFailure('directory-depth', 'over-limit');
            directory(location);
            pending.push({ location, depth: selected.depth + 1 });
          } else if (entry.name.toLowerCase().endsWith('.dmp')) {
            requireFact(identity.isFile() && identity.nlink === 1, 'file-link-or-type');
            totalBytes += identity.size;
            if (
              identity.size > CRASH_ARTIFACT_LIMITS.fileBytes ||
              totalBytes > CRASH_ARTIFACT_LIMITS.totalBytes ||
              dumps.length >= CRASH_ARTIFACT_LIMITS.files
            )
              throw new CollectionFailure('dump-budget', 'over-limit');
            dumps.push({ location, identity });
          }
        }
      } finally {
        opened.closeSync();
      }
    }
    for (const dump of dumps) {
      const bytes = stableBytes(
        dump.location,
        CRASH_ARTIFACT_LIMITS.fileBytes,
        () => {
          assertSource();
          directory(path.dirname(dump.location));
        },
        dump.identity
      );
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const name = `${receipt.dumps.length}-${sha256}.dmp`;
      assertOutput();
      writeFileSync(path.join(output, name), bytes, { flag: 'wx', mode: 0o600 });
      receipt.dumps.push({
        source: portable(path.relative(crashRoot, dump.location)),
        artifact: portable(path.relative(root, path.join(output, name))),
        sha256,
        bytes: bytes.length,
        mtimeMs: dump.identity.mtimeMs,
      });
    }
    receipt.state = dumps.length ? 'collected' : 'empty';
  } catch (error) {
    receipt.state = error instanceof CollectionFailure ? error.state : 'error';
    receipt.reason =
      error instanceof CollectionFailure ? error.message : 'filesystem-or-manifest-read';
  }
  return retain();

  function retain(): CrashArtifactReceipt {
    if (output && assertOutput) {
      try {
        assertOutput();
        writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
          flag: 'wx',
          mode: 0o600,
        });
      } catch {
        receipt.state = 'error';
        receipt.reason = 'receipt-write-failed';
      }
    }
    return receipt;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Diagnostic status is data. The prior qualification result remains the workflow's authority.
  console.log(JSON.stringify(collectPackagedCrashArtifacts(process.argv[2] ?? '')));
}

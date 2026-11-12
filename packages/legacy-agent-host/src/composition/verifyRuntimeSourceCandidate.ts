import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { verifyOpenCodeV2EmbeddedGraph } from '../adapters/providers/OpenCodeV2EmbeddedGraph.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import type { ProviderManagementProfile } from '../management/profile.js';
import type { RuntimeSourceCandidate } from './runtimeSourceContracts.js';

/** Persisted selections retain the seed qualification, even before native bytes are opened again. */
export function assertRuntimeSourceQualification(
  seed: ProviderManagementProfile,
  candidate: RuntimeSourceCandidate
): void {
  const held = (): never => {
    throw new ManagementCommandError('held');
  };
  if (candidate.executable.sha256 !== seed.executable.sha256) held();
  const embedded = seed.provider === 'opencode' ? seed.embedded : undefined;
  if (
    candidate.embedded &&
    (!embedded ||
      candidate.embedded.version !== embedded.version ||
      candidate.embedded.manifestSha256 !== embedded.manifestSha256 ||
      candidate.embedded.platform !== embedded.platform ||
      candidate.embedded.arch !== embedded.arch)
  )
    held();
}

/** This first admission supports relocation/repair of qualified seed bytes, not unqualified upgrades. */
export async function verifyRuntimeSourceCandidate(
  seed: ProviderManagementProfile,
  candidate: RuntimeSourceCandidate
): Promise<void> {
  assertRuntimeSourceQualification(seed, candidate);
  const held = (): never => {
    throw new ManagementCommandError('held');
  };
  const embedded = seed.provider === 'opencode' ? seed.embedded : undefined;
  const path = candidate.executable.path;
  if (realpathSync(path) !== path) held();
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > 1024n * 1024n * 1024n ||
    (process.platform !== 'win32' && (before.mode & 0o111n) === 0n)
  )
    held();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino) held();
    const bytes = readFileSync(fd),
      after = lstatSync(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes.length) !== before.size ||
      createHash('sha256').update(bytes).digest('hex') !== candidate.executable.sha256
    )
      held();
  } finally {
    closeSync(fd);
  }
  if (embedded) await verifyOpenCodeV2EmbeddedGraph(candidate.embedded ?? embedded);
}

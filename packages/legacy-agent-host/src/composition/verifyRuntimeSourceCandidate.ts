import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  read,
  realpathSync,
} from 'node:fs';
import { verifyOpenCodeV2EmbeddedGraph } from '../adapters/providers/OpenCodeV2EmbeddedGraph.js';
import { captureOpenCodeConfigurationSource, OpenCodeConfigurationError } from '../adapters/providers/OpenCodeConfigurationSource.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import { assertRuntimeSourceNativePolicy } from './runtimeSourceQualification.js';
import { runtimeDigest } from '../runtime/identity.js';
import { readOpenCodeConfiguredModel, selectOpenCodeV2ProviderConfiguration } from './openCodeSelectedProviderConfiguration.js';
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
  assertRuntimeSourceNativePolicy(seed, candidate);
  if (
    candidate.executable.sha256 !== seed.executable.sha256 &&
    (!candidate.nativeCli || (seed.provider === 'opencode' && seed.nativeGeneration === 'v2'))
  )
    held();
  const embedded = seed.provider === 'opencode' ? seed.embedded : undefined;
  if (candidate.openCodePreferences && seed.provider !== 'opencode') held();
  if (candidate.openCodeConfiguration && (!embedded || seed.provider !== 'opencode' ||
      seed.nativeGeneration !== 'v2')) held();
  if (candidate.openCodeDefault && !candidate.openCodeConfiguration) held();
  if (candidate.sourceKind === 'captured' &&
      (candidate.executable.path !== seed.executable.path || candidate.executable.sha256 !== seed.executable.sha256)) held();
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

/** Qualification precedes any native allocation; the whole immutable engine delivery remains pinned. */
export async function verifyRuntimeSourceCandidate(
  seed: ProviderManagementProfile,
  candidate: RuntimeSourceCandidate,
  assertCurrent: () => void
): Promise<void> {
  assertCurrent();
  assertRuntimeSourceQualification(seed, candidate);
  const configuration = candidate.openCodeConfiguration
    ? captureOpenCodeConfigurationSource(seed, candidate.openCodeConfiguration) : undefined;
  if (configuration && seed.provider === 'opencode') {
    const config = configuration.read(), selected = readOpenCodeConfiguredModel(config);
    if (runtimeDigest(selected ?? null) !== runtimeDigest(candidate.openCodeDefault ?? null) ||
        !(selected ?? seed.nativeModel)) throw new OpenCodeConfigurationError('configuration-changed');
    const effective = readOpenCodeConfiguredModel({ model: candidate.openCodePreferences?.defaultModelId ?? undefined })
      ?? selected ?? seed.nativeModel;
    selectOpenCodeV2ProviderConfiguration(config, effective!, seed.environment);
  }
  const checks: Awaited<ReturnType<typeof verifyRuntimeSourceExecutable>>[] = [];
  try {
    checks.push(await verifyRuntimeSourceExecutable(candidate.executable, assertCurrent));
    if (candidate.nativeCli && candidate.nativeCli.executable.path !== candidate.executable.path)
      checks.push(await verifyRuntimeSourceExecutable(candidate.nativeCli.executable, assertCurrent));
    const embedded = seed.provider === 'opencode' ? seed.embedded : undefined;
    if (embedded) await verifyOpenCodeV2EmbeddedGraph(candidate.embedded ?? embedded);
    for (const check of checks) check.assertCurrent();
    if (configuration && !configuration.isCurrent())
      throw new OpenCodeConfigurationError('configuration-changed');
  } finally {
    for (const check of checks) check.close();
  }
}

/** Bounded reads retain the original descriptor until the caller's synchronous acceptance. */
export async function verifyRuntimeSourceExecutable(
  executable: { path: string; sha256: string },
  assertOwnerCurrent: () => void
): Promise<{ assertCurrent(): void; close(): void }> {
  const held = (): never => {
    throw new ManagementCommandError('held');
  };
  assertOwnerCurrent();
  const path = executable.path;
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
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      closeSync(fd);
    }
  };
  const assertCurrent = () => {
    assertOwnerCurrent();
    if (closed || realpathSync(path) !== path) held();
    for (const after of [fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })]) {
      if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== after.size || before.mode !== after.mode || before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs) held();
    }
  };
  try {
    assertCurrent();
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024), size = Number(before.size);
    let position = 0;
    while (position < size) {
      assertOwnerCurrent();
      const count = await new Promise<number>((resolve, reject) => {
        read(fd, buffer, 0, Math.min(buffer.length, size - position), position,
          (error, bytesRead) => error ? reject(error) : resolve(bytesRead));
      });
      assertOwnerCurrent();
      if (count <= 0 || count > size - position) held();
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    assertCurrent();
    if (hash.digest('hex') !== executable.sha256) held();
    return { assertCurrent, close };
  } catch (error) {
    close();
    throw error;
  }
}

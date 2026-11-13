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
  candidate: RuntimeSourceCandidate
): Promise<void> {
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
  verifyRuntimeSourceExecutable(candidate.executable);
  if (candidate.nativeCli && candidate.nativeCli.executable.path !== candidate.executable.path)
    verifyRuntimeSourceExecutable(candidate.nativeCli.executable);
  const embedded = seed.provider === 'opencode' ? seed.embedded : undefined;
  if (embedded) await verifyOpenCodeV2EmbeddedGraph(candidate.embedded ?? embedded);
  if (configuration && !configuration.isCurrent())
    throw new OpenCodeConfigurationError('configuration-changed');
}

/** Exact bytes, measured on the original descriptor before and after the read. */
export function verifyRuntimeSourceExecutable(executable: { path: string; sha256: string }): void {
  const held = (): never => {
    throw new ManagementCommandError('held');
  };
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
      createHash('sha256').update(bytes).digest('hex') !== executable.sha256
    )
      held();
  } finally {
    closeSync(fd);
  }
}

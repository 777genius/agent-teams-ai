import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';

import { runtimeSourceNativeSelectionSchema } from '@agent-teams/legacy-agent-host/runtime-sources';
import { classifyNativeVersion } from '@features/opencode-compatibility';
import { collectWindowsNativeOpenCodeBinaryCandidates } from '@main/services/infrastructure/openCodeWindowsNpmBinaryDiscovery';

import type { OpenCodeV2SupportInstaller } from '../application/OpenCodeV2SupportInstaller';
import type { RuntimeSourceSummary } from '@agent-teams/legacy-agent-host/runtime-sources';
import type { OpenCodeRuntimeStatus } from '@shared/types';

/** Static discovery only. The exact native --version and cleanup remain with the Host source owner. */
export async function captureOpenCodeNativeSelection(
  status: OpenCodeRuntimeStatus,
  original: RuntimeSourceSummary,
  support: Pick<OpenCodeV2SupportInstaller, 'captureInstalled'>
) {
  const native = classifyNativeVersion(status.version ?? '');
  if (native.kind !== 'recognized' || native.generation !== original.nativeGeneration)
    throw new Error('This OpenCode generation is not qualified for the selected runtime.');
  if (!status.binaryPath || !['app-managed', 'override', 'path'].includes(status.source))
    throw new Error('The selected OpenCode installation is unavailable.');
  const candidate = collectWindowsNativeOpenCodeBinaryCandidates(status.binaryPath)[0];
  if (!candidate || (process.platform === 'win32' && !/\.exe$/i.test(candidate)))
    throw new Error('The selected OpenCode native executable is unavailable.');
  const path = await fs.realpath(candidate);
  const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let sha256: string;
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size > 1024n ** 3n ||
      (process.platform !== 'win32' && (before.mode & 0o111n) === 0n)
    )
      throw new Error('The selected OpenCode executable cannot be verified.');
    const digest = createHash('sha256');
    for await (const bytes of file.createReadStream({ autoClose: false })) digest.update(bytes);
    const after = await fs.lstat(path, { bigint: true });
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      (await fs.realpath(candidate)) !== path ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('The selected OpenCode executable changed during verification.');
    sha256 = digest.digest('hex');
  } finally {
    await file.close();
  }
  const embedded =
    native.generation === 'v2'
      ? await support.captureInstalled(native.version, original.engineVersion ?? '')
      : undefined;
  return runtimeSourceNativeSelectionSchema.parse({
    sourceKind: status.source,
    nativeCli: {
      executable: { path, sha256 },
      version: native.version,
      generation: native.generation,
    },
    ...(embedded ? { embedded } : {}),
  });
}

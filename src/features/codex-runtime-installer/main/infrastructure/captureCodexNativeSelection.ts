import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';

import { runtimeSourceNativeSelectionSchema } from '@agent-teams/legacy-agent-host/runtime-sources';

import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';

/** Static file capture only; the Host verifies the exact native version and owns its process cleanup. */
export async function captureCodexNativeSelection(status: CodexRuntimeStatus) {
  const version =
    /^(?:codex-cli\s+)?((?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8}))$/.exec(
      status.version?.trim() ?? ''
    )?.[1];
  if (!version || !status.binaryPath || !['app-managed', 'path'].includes(status.source))
    throw new Error('The selected Codex installation is unavailable.');
  const path = await fs.realpath(status.binaryPath);
  const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let sha256: string;
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size > 1024n ** 3n ||
      (process.platform !== 'win32' && (before.mode & 0o111n) === 0n)
    )
      throw new Error('The selected Codex executable cannot be verified.');
    const digest = createHash('sha256');
    for await (const bytes of file.createReadStream({ autoClose: false })) digest.update(bytes);
    const after = await fs.lstat(path, { bigint: true });
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      (await fs.realpath(status.binaryPath)) !== path ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('The selected Codex executable changed during verification.');
    sha256 = digest.digest('hex');
  } finally {
    await file.close();
  }
  return runtimeSourceNativeSelectionSchema.parse({
    sourceKind: status.source,
    nativeCli: { executable: { path, sha256 }, version },
  });
}

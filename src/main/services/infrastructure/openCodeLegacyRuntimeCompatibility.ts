import { stat } from 'node:fs/promises';

import type { OpenCodeRuntimeStatus } from '@shared/types';

// runtime.lock v0.0.161, OpenCodeNativeIdentity.hashOpenCodeFile. A CLI version
// mapping to its engine does not waive this existing native acquisition bound.
const LEGACY_NATIVE_MAX_BYTES = 256 * 1024 * 1024;

export function legacyOpenCodeRuntimeBinarySizeError(size: number): string | null {
  return size > LEGACY_NATIVE_MAX_BYTES
    ? 'This OpenCode installation exceeds the size supported by the bundled runtime. Select a compatible OpenCode installation before using it here.'
    : null;
}

function incompatible(status: OpenCodeRuntimeStatus, error: string): OpenCodeRuntimeStatus {
  return {
    ...status,
    state: 'failed',
    latestVersion: undefined,
    updateAvailable: false,
    error,
    progress: { phase: 'failed', detail: error },
  };
}

/** Preserve the selected installation while refusing a readiness claim the legacy owner cannot meet. */
export async function projectLegacyOpenCodeRuntimeStatus(
  status: OpenCodeRuntimeStatus
): Promise<OpenCodeRuntimeStatus> {
  if (!status.installed || !status.binaryPath) return status;
  try {
    const file = await stat(status.binaryPath);
    if (!file.isFile()) throw new Error('Selected OpenCode installation is unavailable.');
    const error = legacyOpenCodeRuntimeBinarySizeError(file.size);
    return error ? incompatible(status, error) : status;
  } catch {
    return incompatible(status, 'Selected OpenCode installation is unavailable.');
  }
}

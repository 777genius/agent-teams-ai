import { CodexBinaryResolver } from '@main/services/infrastructure/codexAppServer';
import { resolveInteractiveShellEnvBestEffort } from '@main/utils/shellEnv';

const CODEX_BINARY_COLD_RETRY_TIMEOUT_MS = 12_000;

// A verified per-call override wins over the ambient (process/shell/app-managed) resolution
// that CodexBinaryResolver.resolve() derives on its own, since that resolver takes no
// parameters and cannot see a caller-specific CODEX_CLI_PATH.
export async function resolveCodexBinaryForAccountSnapshot(
  binaryPathOverride?: string
): Promise<string | null> {
  const normalizedOverride = binaryPathOverride?.trim();
  if (normalizedOverride) {
    const verifiedOverride = await CodexBinaryResolver.verifyCandidate(normalizedOverride);
    if (verifiedOverride) {
      return verifiedOverride;
    }
  }

  const binaryPath = await CodexBinaryResolver.resolve();
  if (binaryPath) {
    return binaryPath;
  }

  await resolveInteractiveShellEnvBestEffort({
    timeoutMs: CODEX_BINARY_COLD_RETRY_TIMEOUT_MS,
    fallbackEnv: process.env,
    background: true,
    source: 'codex-account-binary-discovery',
  });
  CodexBinaryResolver.clearCache();
  return CodexBinaryResolver.resolve();
}

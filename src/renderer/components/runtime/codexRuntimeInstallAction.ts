import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { CliProviderStatus } from '@shared/types';

const CODEX_NATIVE_BACKEND_ID = 'codex-native';

export function isCodexProviderRuntimeMissing(provider: CliProviderStatus): boolean {
  if (provider.providerId !== 'codex') {
    return false;
  }

  const codexNativeBackend = provider.availableBackends?.find(
    (backend) => backend.id === CODEX_NATIVE_BACKEND_ID
  );
  const runtimeMissingText = [
    provider.statusMessage,
    provider.detailMessage,
    codexNativeBackend?.statusMessage,
    codexNativeBackend?.detailMessage,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    provider.connection?.codex?.appServerState === 'runtime-missing' ||
    codexNativeBackend?.state === 'runtime-missing' ||
    (provider.verificationState === 'error' &&
      (runtimeMissingText.includes('codex cli not found') ||
        runtimeMissingText.includes('runtime missing')))
  );
}

export function shouldOfferCodexRuntimeInstall(
  codexRuntimeStatus: CodexRuntimeStatus | null | undefined
): boolean {
  if (!codexRuntimeStatus || codexRuntimeStatus.installed) {
    return false;
  }

  return (
    codexRuntimeStatus.source === 'missing' ||
    codexRuntimeStatus.state === 'failed' ||
    codexRuntimeStatus.state === 'checking' ||
    codexRuntimeStatus.state === 'downloading' ||
    codexRuntimeStatus.state === 'installing'
  );
}

export function shouldOfferCodexRuntimeUpdate(
  codexRuntimeStatus: CodexRuntimeStatus | null | undefined
): boolean {
  return (
    codexRuntimeStatus?.installed === true &&
    codexRuntimeStatus.updateAvailable === true &&
    Boolean(codexRuntimeStatus.latestVersion)
  );
}

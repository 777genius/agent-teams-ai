import { useAppTranslation } from '@features/localization/renderer';
import {
  canManagedInstallChangeOpenCodeRuntime,
  isOpenCodeProviderOAuthBridgeOutdated,
  isOpenCodeRuntimeUsable,
  isOpenCodeSupportInstallProgress,
} from '@features/runtime-provider-management/renderer';
import {
  formatRuntimeVersionTransition,
  isOpenCodeFreeTierVersionOutdated,
} from '@shared/utils/version';

import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';

export function shouldShowOpenCodeInstallAction(
  provider: CliProviderStatus,
  showSkeleton: boolean,
  status: OpenCodeRuntimeStatus | null,
  nativeLoading: boolean
): boolean {
  if (provider.providerId !== 'opencode' || !status) return false;
  if (
    ['downloading', 'installing'].includes(status.state) ||
    (status.state === 'checking' && isOpenCodeSupportInstallProgress(status))
  )
    return true;
  if (nativeLoading || status.state === 'checking' || status.v2Support === 'required') return false;
  const providerReady =
    provider.supported &&
    provider.authenticated &&
    provider.verificationState === 'verified' &&
    provider.capabilities.teamLaunch;
  return (
    !showSkeleton &&
    canManagedInstallChangeOpenCodeRuntime(status) &&
    (status.updateAvailable === true ||
      isOpenCodeFreeTierVersionOutdated(status.version) ||
      (!providerReady && !isOpenCodeRuntimeUsable(status)) ||
      isOpenCodeProviderOAuthBridgeOutdated(status))
  );
}

export function isRuntimeInstalling(
  status: OpenCodeRuntimeStatus | CodexRuntimeStatus | null,
  loading: boolean
): boolean {
  return (
    loading ||
    status?.state === 'checking' ||
    status?.state === 'downloading' ||
    status?.state === 'installing'
  );
}

export function getRuntimeInstallLabel(
  status: OpenCodeRuntimeStatus | CodexRuntimeStatus | null,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  const supportPrefix = isOpenCodeSupportInstallProgress(status)
    ? `${t('cliStatus.runtimeInstall.v2SupportFiles')}: `
    : '';
  if (status?.state === 'downloading') {
    const percent = status.progress?.percent;
    return (
      supportPrefix +
      (typeof percent === 'number'
        ? t('cliStatus.runtimeInstall.downloadingPercent', { percent })
        : t('cliStatus.runtimeInstall.downloading'))
    );
  }
  if (status?.state === 'installing')
    return supportPrefix + t('cliStatus.runtimeInstall.installing');
  if (status?.state === 'checking') return supportPrefix + t('cliStatus.runtimeInstall.checking');
  if (status?.state === 'failed') return t('cliStatus.runtimeInstall.retryInstall');
  if (status && !status.installed && 'compatibleV2Version' in status)
    return `${t('cliStatus.runtimeInstall.install')} OpenCode V1`;
  if (status?.updateAvailable && status.latestVersion) {
    return status.version
      ? `${t('cliStatus.runtimeInstall.update')} ${formatRuntimeVersionTransition(status.version, status.latestVersion)}`
      : t('cliStatus.actions.updateTo', { version: status.latestVersion });
  }
  return t(
    status?.installed ? 'cliStatus.runtimeInstall.update' : 'cliStatus.runtimeInstall.install'
  );
}

export function shouldShowOpenCodeRuntimeError(status: OpenCodeRuntimeStatus | null): boolean {
  return Boolean(
    status?.diagnostics ||
    (status?.state === 'failed' && status.error && isOpenCodeRuntimeUsable(status))
  );
}

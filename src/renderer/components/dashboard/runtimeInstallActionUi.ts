import { useAppTranslation } from '@features/localization/renderer';
import { formatRuntimeVersionTransition } from '@shared/utils/version';

import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { OpenCodeRuntimeStatus } from '@shared/types';

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
  if (status?.state === 'downloading') {
    const percent = status.progress?.percent;
    return typeof percent === 'number'
      ? t('cliStatus.runtimeInstall.downloadingPercent', { percent })
      : t('cliStatus.runtimeInstall.downloading');
  }
  if (status?.state === 'installing') return t('cliStatus.runtimeInstall.installing');
  if (status?.state === 'checking') return t('cliStatus.runtimeInstall.checking');
  if (status?.state === 'failed') return t('cliStatus.runtimeInstall.retryInstall');
  if (status?.updateAvailable && status.latestVersion) {
    return status.version
      ? `${t('cliStatus.runtimeInstall.update')} ${formatRuntimeVersionTransition(status.version, status.latestVersion)}`
      : t('cliStatus.actions.updateTo', { version: status.latestVersion });
  }
  return t(
    status?.installed ? 'cliStatus.runtimeInstall.update' : 'cliStatus.runtimeInstall.install'
  );
}

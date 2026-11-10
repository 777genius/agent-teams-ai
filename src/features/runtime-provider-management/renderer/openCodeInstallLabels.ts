import type { useAppTranslation } from '@features/localization/renderer';
import type { OpenCodeRuntimeStatus } from '@shared/types';

export function isOpenCodeSupportInstallProgress(
  status: { readonly progress?: { readonly detail?: string | null } } | null
): boolean {
  return status?.progress?.detail?.includes('OpenCode V2 support') === true;
}

export function getOpenCodeInstallLabels(
  status: OpenCodeRuntimeStatus | null,
  t: ReturnType<typeof useAppTranslation>['t']
): { checking: string; installing: string } {
  const prefix = isOpenCodeSupportInstallProgress(status)
    ? `${t('cliStatus.runtimeInstall.v2SupportFiles')}: `
    : '';
  return {
    checking: prefix
      ? prefix + t('cliStatus.runtimeInstall.checking')
      : t('cliStatus.quickConnect.checkingOpenCode'),
    installing: prefix
      ? prefix + t('cliStatus.runtimeInstall.installing')
      : t('cliStatus.quickConnect.installingOpenCode'),
  };
}

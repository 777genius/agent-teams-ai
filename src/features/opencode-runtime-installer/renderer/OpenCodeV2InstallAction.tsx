import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';

import type { OpenCodeRuntimeInstallOptions } from '../contracts';
import type { OpenCodeRuntimeStatus } from '@shared/types';

/** Separate upgrade choice keeps normal updates in the selected generation. */
export const OpenCodeV2InstallAction = ({
  status,
  busy,
  onInstall,
}: {
  status: OpenCodeRuntimeStatus | null;
  busy: boolean;
  onInstall: (options?: OpenCodeRuntimeInstallOptions) => void;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('dashboard');
  if (!status || (status.installed && status.version?.startsWith('2.'))) return null;
  if (!status.installed && status.compatibleV2Version) return null;
  if (status.source === 'override') {
    return (
      <span className="max-w-64 text-[10px] text-[var(--color-text-muted)]">
        {t('cliStatus.runtimeInstall.overrideSelection')}
      </span>
    );
  }
  if (!status.compatibleV2Version) {
    return (
      <span className="max-w-64 text-[10px] text-[var(--color-text-muted)]">
        {t('cliStatus.runtimeInstall.v2Unavailable')}
      </span>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() => onInstall({ generation: 'v2' })}
      className="h-6 px-2 text-[10px]"
    >
      {t('cliStatus.runtimeInstall.install')} V2 {status.compatibleV2Version}
    </Button>
  );
}

import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { CheckCircle2 } from 'lucide-react';

import { ProvisioningProviderStatusList } from './ProvisioningProviderStatusList';

import type { ProvisioningProviderCheck } from './ProvisioningProviderStatusList';
import type { TeamProviderId } from '@shared/types';

export const ProviderPrepareReadyNotice = ({
  checks,
  message,
  onOpenProviderSettings,
  warnings,
}: {
  checks: ProvisioningProviderCheck[];
  message: string | null;
  onOpenProviderSettings: (providerId: TeamProviderId) => void;
  warnings: string[];
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const hasNotes = checks.some((check) => check.status === 'notes') || warnings.length > 0;

  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
        <CheckCircle2 className="size-3.5 shrink-0" />
        <span>{hasNotes ? t('launch.prepare.readyWithNotes') : t('launch.prepare.ready')}</span>
      </div>
      {message ? (
        <p className="mt-0.5 pl-5 text-[11px] text-[var(--color-text-muted)]">{message}</p>
      ) : null}
      <ProvisioningProviderStatusList
        checks={checks}
        className="mt-1"
        onOpenProviderSettings={onOpenProviderSettings}
      />
      {warnings.length > 0 && checks.length === 0 ? (
        <div className="mt-0.5 space-y-0.5 pl-5">
          {warnings.map((warning, index) => (
            <p key={`${index}:${warning}`} className="text-[11px] text-sky-300">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
};

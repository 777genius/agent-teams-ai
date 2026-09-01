import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { AlertTriangle } from 'lucide-react';

import {
  getProvisioningProviderBackendSummary,
  ProvisioningProviderStatusList,
} from './ProvisioningProviderStatusList';

import type { ProviderLaunchBlocker } from './providerLaunchAuthority';
import type { TeamProviderId } from '@shared/types';

export const ProviderLaunchAuthorityNotice = ({
  action,
  blockers,
  id,
  onOpenProviderSettings,
}: {
  action: string;
  blockers: readonly ProviderLaunchBlocker[];
  id: string;
  onOpenProviderSettings: (providerId: TeamProviderId) => void;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  if (blockers.length === 0) return null;

  const checks = blockers.map((blocker) => ({
    providerId: blocker.providerId,
    status: 'failed' as const,
    backendSummary: getProvisioningProviderBackendSummary(blocker.providerStatus),
    details: [blocker.detail],
  }));

  return (
    <div id={id} role="alert" aria-live="polite" className="text-xs">
      <div className="flex items-start gap-2 text-red-300">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">{t('launch.prepare.blocked', { action })}</p>
          <p className="mt-0.5 text-red-300/80">{t('launch.prepare.someProvidersNeedAttention')}</p>
        </div>
      </div>
      <ProvisioningProviderStatusList
        checks={checks}
        className="mt-2"
        onOpenProviderSettings={onOpenProviderSettings}
      />
    </div>
  );
};

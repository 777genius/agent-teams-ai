import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';
import { isTeamProviderRuntimeStatusLoading } from '@renderer/utils/teamProviderRuntimeStatusLoading';
import { AlertTriangle, LoaderCircle } from 'lucide-react';

import {
  getProvisioningProviderBackendSummary,
  ProvisioningProviderStatusList,
} from './ProvisioningProviderStatusList';

import type { ProviderLaunchBlocker } from './providerLaunchAuthority';
import type { TeamProviderId } from '@shared/types';

function isBlockerChecking(
  { providerId, providerStatus }: ProviderLaunchBlocker,
  providerLoading: boolean
): boolean {
  // A scoped read deliberately revokes cached auth/launch evidence while it
  // runs. Its explicit pending refresh still means Checking in the UI, never
  // launch permission. Settled catalog/auth errors remain failures below.
  return (
    isTeamProviderRuntimeStatusLoading(providerId, providerStatus, providerLoading) ||
    Boolean(
      (providerId === 'anthropic' || providerId === 'codex') &&
      providerStatus?.modelCatalogRefreshState === 'loading' &&
      providerStatus.statusCheckOutcome === 'pending' &&
      providerStatus.statusCheckErrorCode === 'partial_response'
    )
  );
}

export const ProviderLaunchAuthorityNotice = ({
  action,
  blockers,
  id,
  onOpenProviderSettings,
  providerLoading,
}: {
  action: string;
  blockers: readonly ProviderLaunchBlocker[];
  providerLoading?: Readonly<Partial<Record<TeamProviderId, boolean>>>;
  id: string;
  onOpenProviderSettings: (providerId: TeamProviderId) => void;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const storedProviderLoading = useStore((state) => state.cliProviderStatusLoading);
  const activeProviderLoading = providerLoading ?? storedProviderLoading;
  if (blockers.length === 0) return null;
  const checks = blockers.map((blocker) => ({
    providerId: blocker.providerId,
    status: isBlockerChecking(blocker, activeProviderLoading[blocker.providerId] === true)
      ? ('checking' as const)
      : ('failed' as const),
    backendSummary: getProvisioningProviderBackendSummary(blocker.providerStatus),
    details: [blocker.detail],
  }));
  if (checks.every((check) => check.status === 'checking'))
    return (
      <p
        id={id}
        role="status"
        className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]"
      >
        <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
        {t('launch.prepare.checkingProviders')}
      </p>
    );

  return (
    <div id={id} role="alert" aria-live="polite" className="text-xs">
      <div className="flex items-start gap-2 text-red-700 dark:text-red-300">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">{t('launch.prepare.blocked', { action })}</p>
          <p className="mt-0.5 text-red-700/80 dark:text-red-300/80">
            {t('launch.prepare.someProvidersNeedAttention')}
          </p>
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

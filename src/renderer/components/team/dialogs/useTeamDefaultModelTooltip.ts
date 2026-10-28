import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { isAnthropicCompatibleRuntime } from '@renderer/utils/teamModelAvailability';

import { resolveRuntimeDefaultModelLabel } from './runtimeDefaultModelLabel';

import type { CliProviderStatus, TeamProviderId } from '@shared/types';

export function useTeamDefaultModelTooltip(
  providerId: TeamProviderId,
  providerStatus: CliProviderStatus | null | undefined,
  openCodeDefaultLabelModel: string | null,
  limitContext = false
): string {
  const { t } = useAppTranslation('team');

  return useMemo(() => {
    const confirmedDefault = resolveRuntimeDefaultModelLabel(
      providerId,
      providerStatus,
      limitContext
    );
    if (confirmedDefault) {
      return t('modelSelector.defaultWithResolved', { model: confirmedDefault.label });
    }
    if (providerId === 'anthropic') {
      if (isAnthropicCompatibleRuntime(providerStatus)) {
        return t('modelSelector.defaultTooltip.anthropicCompatible');
      }
      return t('modelSelector.defaultTooltip.runtime');
    }
    if (providerId === 'opencode') {
      return openCodeDefaultLabelModel
        ? t('modelSelector.defaultTooltip.openCodeWithResolved', {
            model: openCodeDefaultLabelModel,
          })
        : t('modelSelector.defaultTooltip.openCode');
    }
    return t('modelSelector.defaultTooltip.runtime');
  }, [providerId, openCodeDefaultLabelModel, providerStatus, limitContext, t]);
}

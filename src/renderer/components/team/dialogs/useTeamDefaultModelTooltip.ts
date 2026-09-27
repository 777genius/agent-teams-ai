import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { isAnthropicCompatibleRuntime } from '@renderer/utils/teamModelAvailability';
import { getRuntimeAwareProviderScopedTeamModelLabel } from '@renderer/utils/teamModelCatalog';
import { getAnthropicDefaultTeamModel } from '@shared/utils/anthropicModelDefaults';

import type { CliProviderStatus, TeamProviderId } from '@shared/types';

export function useTeamDefaultModelTooltip(
  providerId: TeamProviderId,
  providerStatus: CliProviderStatus | null | undefined,
  openCodeDefaultLabelModel: string | null
): string {
  const { t } = useAppTranslation('team');

  return useMemo(() => {
    if (providerId === 'anthropic') {
      if (isAnthropicCompatibleRuntime(providerStatus)) {
        const defaultCompatibleModel =
          providerStatus?.modelCatalog?.defaultLaunchModel?.trim() ||
          providerStatus?.modelCatalog?.defaultModelId?.trim() ||
          null;
        return defaultCompatibleModel
          ? t('modelSelector.defaultTooltip.anthropicCompatibleWithResolved', {
              model: defaultCompatibleModel,
            })
          : t('modelSelector.defaultTooltip.anthropicCompatible');
      }
      const defaultLongContextModel =
        getRuntimeAwareProviderScopedTeamModelLabel(
          'anthropic',
          getAnthropicDefaultTeamModel(false),
          providerStatus
        ) ?? 'Opus 4.8 (1M)';
      const defaultLimitedContextModel =
        getRuntimeAwareProviderScopedTeamModelLabel(
          'anthropic',
          getAnthropicDefaultTeamModel(true),
          providerStatus
        ) ?? 'Opus 4.8';
      return t('modelSelector.defaultTooltip.anthropic', {
        longContextModel: defaultLongContextModel,
        limitedContextModel: defaultLimitedContextModel,
      });
    }
    if (providerId === 'opencode') {
      return openCodeDefaultLabelModel
        ? t('modelSelector.defaultTooltip.openCodeWithResolved', {
            model: openCodeDefaultLabelModel,
          })
        : t('modelSelector.defaultTooltip.openCode');
    }
    return t('modelSelector.defaultTooltip.runtime');
  }, [providerId, openCodeDefaultLabelModel, providerStatus, t]);
}

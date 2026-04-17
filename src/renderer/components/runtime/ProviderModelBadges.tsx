import { cn } from '@renderer/lib/utils';
import {
  getTeamModelBadgeLabel,
  getVisibleTeamProviderModels,
} from '@renderer/utils/teamModelCatalog';

import type {
  CliProviderId,
  CliProviderModelAvailability,
  CliProviderModelAvailabilityStatus,
  CliProviderStatus,
} from '@shared/types';

function formatModelBadgeLabel(providerId: CliProviderId, model: string): string {
  return getTeamModelBadgeLabel(providerId, model) ?? model;
}

function getAvailabilityStatus(
  model: string,
  modelAvailability: CliProviderModelAvailability[] | undefined
): CliProviderModelAvailabilityStatus | null {
  return modelAvailability?.find((item) => item.modelId === model)?.status ?? null;
}

function getAvailabilityReason(
  model: string,
  modelAvailability: CliProviderModelAvailability[] | undefined
): string | null {
  return modelAvailability?.find((item) => item.modelId === model)?.reason ?? null;
}

function getAvailabilityChip(status: CliProviderModelAvailabilityStatus | null): string | null {
  switch (status) {
    case 'checking':
      return 'Checking';
    case 'unavailable':
      return 'Unavailable';
    case 'unknown':
      return 'Check failed';
    case 'available':
    default:
      return null;
  }
}

export const ProviderModelBadges = ({
  providerId,
  models,
  modelAvailability,
  providerStatus,
}: {
  readonly providerId: CliProviderId;
  readonly models: string[];
  readonly modelAvailability?: CliProviderModelAvailability[];
  readonly providerStatus?: Pick<CliProviderStatus, 'providerId' | 'authMethod' | 'backend'> | null;
}): React.JSX.Element => {
  const visibleModels = getVisibleTeamProviderModels(providerId, models, providerStatus);

  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleModels.map((model) => {
        const availabilityStatus = getAvailabilityStatus(model, modelAvailability);
        const availabilityReason = getAvailabilityReason(model, modelAvailability);
        const availabilityChip = getAvailabilityChip(availabilityStatus);

        return (
          <span
            key={model}
            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-px font-mono text-[10px] leading-4"
            style={{
              borderColor: 'var(--color-border-subtle)',
              backgroundColor: 'rgba(255, 255, 255, 0.03)',
              color: 'var(--color-text-secondary)',
            }}
            title={availabilityReason ?? availabilityChip ?? undefined}
          >
            <span>{formatModelBadgeLabel(providerId, model)}</span>
            {availabilityChip ? (
              <span
                className={cn(
                  'rounded px-1 py-0 text-[9px] font-medium uppercase tracking-[0.06em]',
                  availabilityStatus === 'checking'
                    ? 'bg-[rgba(59,130,246,0.12)] text-[var(--color-text-secondary)]'
                    : availabilityStatus === 'unavailable'
                      ? 'bg-[rgba(239,68,68,0.12)] text-[rgb(248,113,113)]'
                      : 'bg-[rgba(245,158,11,0.12)] text-[rgb(251,191,36)]'
                )}
              >
                {availabilityChip}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
};

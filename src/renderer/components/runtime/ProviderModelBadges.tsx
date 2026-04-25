import { useState } from 'react';

import { cn } from '@renderer/lib/utils';
import {
  getTeamModelBadgeLabel,
  getVisibleTeamProviderModels,
} from '@renderer/utils/teamModelCatalog';
import { ChevronDown, ChevronUp } from 'lucide-react';

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
  collapseAfter,
  expandedMaxHeightPx = 200,
}: {
  readonly providerId: CliProviderId;
  readonly models: string[];
  readonly modelAvailability?: CliProviderModelAvailability[];
  readonly providerStatus?: Pick<CliProviderStatus, 'providerId' | 'authMethod' | 'backend'> | null;
  readonly collapseAfter?: number;
  readonly expandedMaxHeightPx?: number;
}): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false);
  const visibleModels = getVisibleTeamProviderModels(providerId, models, providerStatus);
  const displayModelAvailability = providerId === 'opencode' ? undefined : modelAvailability;
  const shouldCollapse =
    typeof collapseAfter === 'number' && collapseAfter > 0 && visibleModels.length > collapseAfter;
  const displayedModels =
    shouldCollapse && !expanded ? visibleModels.slice(0, collapseAfter) : visibleModels;
  const hiddenCount = shouldCollapse ? visibleModels.length - collapseAfter : 0;

  const badgeClassName =
    'inline-flex items-center gap-1 rounded-md border px-1.5 py-px font-mono text-[10px] leading-4';
  const badgeStyle = {
    borderColor: 'var(--color-border-subtle)',
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    color: 'var(--color-text-secondary)',
  };
  const buttonClassName =
    'inline-flex items-center gap-1 rounded-full border border-[rgba(59,130,246,0.35)] bg-[rgba(59,130,246,0.12)] px-2 py-px text-[10px] font-medium leading-4 text-[rgb(147,197,253)] transition-colors hover:border-[rgba(59,130,246,0.55)] hover:bg-[rgba(59,130,246,0.18)] hover:text-[rgb(191,219,254)]';
  const listClassName = cn('flex flex-wrap gap-1.5', expanded && shouldCollapse ? 'pr-1' : null);
  const listStyle =
    expanded && shouldCollapse
      ? ({ maxHeight: expandedMaxHeightPx, overflowY: 'auto' } as const)
      : undefined;

  const renderModelBadge = (model: string, index: number): React.JSX.Element => {
    const availabilityStatus = getAvailabilityStatus(model, displayModelAvailability);
    const availabilityReason = getAvailabilityReason(model, displayModelAvailability);
    const availabilityChip = getAvailabilityChip(availabilityStatus);

    return (
      <span
        key={`${model}-${index}`}
        className={badgeClassName}
        style={badgeStyle}
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
  };

  if (!shouldCollapse) {
    return <div className="flex flex-wrap gap-1.5">{displayedModels.map(renderModelBadge)}</div>;
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className={listClassName} style={listStyle}>
        {displayedModels.map(renderModelBadge)}
        {shouldCollapse && !expanded ? (
          <button type="button" className={buttonClassName} onClick={() => setExpanded(true)}>
            <ChevronDown className="size-3" />
            <span>+{hiddenCount} more</span>
          </button>
        ) : null}
      </div>
      {shouldCollapse && expanded ? (
        <button type="button" className={buttonClassName} onClick={() => setExpanded(false)}>
          <ChevronUp className="size-3" />
          <span>Hide</span>
        </button>
      ) : null}
    </div>
  );
};

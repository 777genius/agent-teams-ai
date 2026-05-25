import { useLayoutEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
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

function getAvailabilityChip(
  status: CliProviderModelAvailabilityStatus | null,
  t: ReturnType<typeof useAppTranslation>['t']
): string | null {
  switch (status) {
    case 'checking':
      return t('providerModelBadges.checking');
    case 'unavailable':
      return t('providerModelBadges.unavailable');
    case 'unknown':
      return t('providerModelBadges.checkFailed');
    case 'available':
    default:
      return null;
  }
}

function getCatalogBadgeLabel(
  model: string,
  providerStatus: Pick<CliProviderStatus, 'modelCatalog'> | null | undefined
): string | null {
  const catalogItem = providerStatus?.modelCatalog?.models.find(
    (item) => item.launchModel === model || item.id === model
  );
  const badgeLabel = catalogItem?.badgeLabel?.trim();
  if (badgeLabel) {
    return badgeLabel;
  }
  return catalogItem?.metadata?.free === true ? 'Free' : null;
}

function normalizeBadgeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function shouldRenderCatalogBadge(modelLabel: string, catalogBadgeLabel: string | null): boolean {
  if (!catalogBadgeLabel) {
    return false;
  }
  return normalizeBadgeText(modelLabel) !== normalizeBadgeText(catalogBadgeLabel);
}

function hasChildAfterRowLimit(container: HTMLElement, rowLimit: number): boolean {
  const rowTops: number[] = [];
  const children = Array.from(container.children) as HTMLElement[];

  for (const child of children) {
    const top = child.offsetTop;
    let rowIndex = rowTops.findIndex((rowTop) => Math.abs(rowTop - top) <= 1);
    if (rowIndex < 0) {
      rowTops.push(top);
      rowIndex = rowTops.length - 1;
    }
    if (rowIndex >= rowLimit) {
      return true;
    }
  }

  return false;
}

export const ProviderModelBadges = ({
  providerId,
  models,
  modelAvailability,
  providerStatus,
  collapseAfter,
  maxCollapsedRows,
}: {
  readonly providerId: CliProviderId;
  readonly models: string[];
  readonly modelAvailability?: CliProviderModelAvailability[];
  readonly providerStatus?: Pick<
    CliProviderStatus,
    'providerId' | 'authMethod' | 'backend' | 'modelCatalog'
  > | null;
  readonly collapseAfter?: number;
  readonly maxCollapsedRows?: number;
}): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const [collapsedModelLimit, setCollapsedModelLimit] = useState<number | null>(null);
  const [measureTick, setMeasureTick] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const visibleModels = getVisibleTeamProviderModels(providerId, models, providerStatus);
  const displayModelAvailability = providerId === 'opencode' ? undefined : modelAvailability;
  const shouldCollapse =
    typeof collapseAfter === 'number' && collapseAfter > 0 && visibleModels.length > collapseAfter;
  const collapsedBaseLimit = shouldCollapse ? collapseAfter : visibleModels.length;
  const collapsedLimit =
    shouldCollapse && !expanded
      ? Math.max(0, Math.min(collapsedModelLimit ?? collapsedBaseLimit, collapsedBaseLimit))
      : visibleModels.length;
  const displayedModels =
    shouldCollapse && !expanded ? visibleModels.slice(0, collapsedLimit) : visibleModels;
  const hiddenCount = shouldCollapse ? visibleModels.length - displayedModels.length : 0;

  useLayoutEffect(() => {
    setCollapsedModelLimit(null);
  }, [collapseAfter, maxCollapsedRows, models, providerStatus]);

  useLayoutEffect(() => {
    if (!shouldCollapse || expanded || !maxCollapsedRows || maxCollapsedRows < 1) {
      return;
    }

    const container = listRef.current;
    if (!container) {
      return;
    }

    if (!hasChildAfterRowLimit(container, maxCollapsedRows)) {
      return;
    }

    const nextLimit = Math.max(0, collapsedLimit - 1);
    if (nextLimit !== collapsedLimit) {
      setCollapsedModelLimit(nextLimit);
    }
  }, [collapsedLimit, expanded, maxCollapsedRows, measureTick, shouldCollapse]);

  useLayoutEffect(() => {
    if (!shouldCollapse || expanded || !maxCollapsedRows || typeof ResizeObserver === 'undefined') {
      return;
    }

    const container = listRef.current;
    if (!container) {
      return;
    }

    let lastWidth = container.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? container.clientWidth);
      if (width === lastWidth) {
        return;
      }
      lastWidth = width;
      setCollapsedModelLimit(null);
      setMeasureTick((value) => value + 1);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [expanded, maxCollapsedRows, shouldCollapse]);

  const badgeClassName =
    'inline-flex items-center gap-1 rounded-md border px-1.5 py-px font-mono text-[10px] leading-4';
  const badgeStyle = {
    borderColor: 'var(--color-border-subtle)',
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    color: 'var(--color-text-secondary)',
  };
  const buttonClassName =
    'inline-flex items-center gap-1 rounded-full border border-[rgba(59,130,246,0.35)] bg-[rgba(59,130,246,0.12)] px-2 py-px text-[10px] font-medium leading-4 text-[rgb(147,197,253)] transition-colors hover:border-[rgba(59,130,246,0.55)] hover:bg-[rgba(59,130,246,0.18)] hover:text-[rgb(191,219,254)]';
  const listClassName = cn('flex flex-wrap gap-1.5');

  const renderModelBadge = (model: string, index: number): React.JSX.Element => {
    const availabilityStatus = getAvailabilityStatus(model, displayModelAvailability);
    const availabilityReason = getAvailabilityReason(model, displayModelAvailability);
    const availabilityChip = getAvailabilityChip(availabilityStatus, t);
    const modelLabel = formatModelBadgeLabel(providerId, model);
    const catalogBadgeLabel = getCatalogBadgeLabel(model, providerStatus);
    const catalogBadgeIsFree = catalogBadgeLabel === 'Free';
    const localizedCatalogBadgeLabel = catalogBadgeIsFree
      ? t('providerModelBadges.free')
      : catalogBadgeLabel;
    const showCatalogBadge = shouldRenderCatalogBadge(modelLabel, catalogBadgeLabel);
    const title = [
      availabilityReason ?? availabilityChip,
      showCatalogBadge && catalogBadgeIsFree ? t('providerModelBadges.freeTooltip') : null,
    ]
      .filter(Boolean)
      .join(' - ');

    return (
      <span
        key={`${model}-${index}`}
        className={badgeClassName}
        style={badgeStyle}
        title={title || undefined}
      >
        <span>{modelLabel}</span>
        {showCatalogBadge ? (
          <span className="rounded bg-[rgba(34,197,94,0.14)] px-1 py-0 text-[9px] font-medium uppercase tracking-[0.06em] text-[rgb(74,222,128)]">
            {localizedCatalogBadgeLabel}
          </span>
        ) : null}
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
      <div ref={listRef} className={listClassName}>
        {displayedModels.map(renderModelBadge)}
        {shouldCollapse && !expanded ? (
          <button type="button" className={buttonClassName} onClick={() => setExpanded(true)}>
            <ChevronDown className="size-3" />
            <span>{t('list.moreCount', { count: hiddenCount })}</span>
          </button>
        ) : null}
      </div>
      {shouldCollapse && expanded ? (
        <button type="button" className={buttonClassName} onClick={() => setExpanded(false)}>
          <ChevronUp className="size-3" />
          <span>{t('actions.hide')}</span>
        </button>
      ) : null}
    </div>
  );
};

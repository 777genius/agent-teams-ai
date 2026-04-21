import React from 'react';

import { Label } from '@renderer/components/ui/label';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { Brain } from 'lucide-react';

import type { CliProviderStatus, EffortLevel, TeamProviderId } from '@shared/types';

const BASE_EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;

const EFFORT_LABELS: Record<EffortLevel, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
};

const BASE_CODEX_SAFE_EFFORTS = new Set<EffortLevel>(['low', 'medium', 'high']);

export interface EffortLevelSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  id?: string;
  providerId?: TeamProviderId;
  model?: string;
}

function getCatalogModel(
  providerStatus: CliProviderStatus | null | undefined,
  model: string | undefined
): NonNullable<CliProviderStatus['modelCatalog']>['models'][number] | null {
  const catalog = providerStatus?.modelCatalog;
  if (!catalog || catalog.providerId !== 'codex') {
    return null;
  }

  const explicitModel = model?.trim();
  if (explicitModel) {
    return (
      catalog.models.find(
        (item) => item.launchModel === explicitModel || item.id === explicitModel
      ) ?? null
    );
  }

  return (
    catalog.models.find((item) => item.id === catalog.defaultModelId) ??
    catalog.models.find((item) => item.isDefault) ??
    null
  );
}

function getEffortOptions(params: {
  providerId?: TeamProviderId;
  model?: string;
  providerStatus?: CliProviderStatus | null;
}): readonly { value: string; label: string }[] {
  if (params.providerId !== 'codex') {
    return BASE_EFFORT_OPTIONS;
  }

  const runtimeCapability = params.providerStatus?.runtimeCapabilities?.reasoningEffort;
  const catalogModel = getCatalogModel(params.providerStatus, params.model);
  const catalogEfforts = catalogModel?.supportedReasoningEfforts ?? [];
  const candidateEfforts =
    catalogEfforts.length > 0 ? catalogEfforts : (runtimeCapability?.values ?? []);
  const safeEfforts =
    runtimeCapability?.configPassthrough === true
      ? candidateEfforts
      : candidateEfforts.filter((effort) => BASE_CODEX_SAFE_EFFORTS.has(effort));
  const efforts = safeEfforts.length > 0 ? safeEfforts : (['low', 'medium', 'high'] as const);
  const defaultLabel = catalogModel?.defaultReasoningEffort
    ? `Default (${EFFORT_LABELS[catalogModel.defaultReasoningEffort]})`
    : 'Default';

  return [
    { value: '', label: defaultLabel },
    ...efforts.map((effort) => ({
      value: effort,
      label: EFFORT_LABELS[effort],
    })),
  ];
}

export const EffortLevelSelector: React.FC<EffortLevelSelectorProps> = ({
  value,
  onValueChange,
  id,
  providerId,
  model,
}) => {
  const providerStatus = useStore(
    (s) => s.cliStatus?.providers.find((provider) => provider.providerId === providerId) ?? null
  );
  const effortOptions = getEffortOptions({ providerId, model, providerStatus });

  return (
    <div className="mb-3">
      <Label htmlFor={id} className="label-optional mb-1.5 block">
        Effort level (optional)
      </Label>
      <div className="flex items-center gap-2">
        <Brain size={16} className="shrink-0 text-[var(--color-text-muted)]" />
        <div className="inline-flex flex-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
          {effortOptions.map((opt) => (
            <button
              key={opt.value || '__default__'}
              type="button"
              id={opt.value === value ? id : undefined}
              className={cn(
                'rounded-[3px] px-3 py-1 text-xs font-medium transition-colors',
                value === opt.value
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              )}
              onClick={() => onValueChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
        Controls how much reasoning the selected provider invests before responding. Default uses
        the provider&apos;s standard behavior for the selected model.
      </p>
    </div>
  );
};

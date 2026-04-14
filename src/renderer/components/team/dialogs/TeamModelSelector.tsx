import React, { useEffect, useMemo } from 'react';

import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { Label } from '@renderer/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import {
  GEMINI_UI_DISABLED_BADGE_LABEL,
  GEMINI_UI_DISABLED_REASON,
  isGeminiUiFrozen,
} from '@renderer/utils/geminiUiFreeze';
import {
  doesTeamModelCarryProviderBrand,
  getProviderScopedTeamModelLabel,
  getTeamModelLabel as getCatalogTeamModelLabel,
  getTeamModelUiDisabledReason,
  getTeamProviderLabel as getCatalogTeamProviderLabel,
  getTeamProviderModelOptions,
  normalizeTeamModelForUi,
  TEAM_MODEL_UI_DISABLED_BADGE_LABEL,
} from '@renderer/utils/teamModelCatalog';
import { extractProviderScopedBaseModel } from '@renderer/utils/teamModelContext';
import { Info } from 'lucide-react';

export { getProviderScopedTeamModelLabel } from '@renderer/utils/teamModelCatalog';

// --- Provider definitions ---

interface ProviderDef {
  id: 'anthropic' | 'codex' | 'gemini' | 'opencode';
  label: string;
  comingSoon: boolean;
}

const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', label: 'Anthropic', comingSoon: false },
  { id: 'codex', label: 'Codex', comingSoon: false },
  { id: 'gemini', label: 'Gemini', comingSoon: false },
  { id: 'opencode', label: 'OpenCode', comingSoon: false },
];

const OPENCODE_UI_DISABLED_REASON = 'OpenCode in development';

export function getTeamModelLabel(model: string): string {
  return getCatalogTeamModelLabel(model) ?? model;
}

export function getTeamProviderLabel(providerId: 'anthropic' | 'codex' | 'gemini'): string {
  return getCatalogTeamProviderLabel(providerId) ?? 'Anthropic';
}

export function getTeamEffortLabel(effort: string): string {
  const trimmed = effort.trim();
  if (!trimmed) return 'Default';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function formatTeamModelSummary(
  providerId: 'anthropic' | 'codex' | 'gemini',
  model: string,
  effort?: string
): string {
  const providerLabel = getTeamProviderLabel(providerId);
  const rawModelLabel = model.trim() ? getTeamModelLabel(model.trim()) : 'Default';
  const modelLabel = model.trim()
    ? getProviderScopedTeamModelLabel(providerId, model.trim())
    : 'Default';
  const effortLabel = effort?.trim() ? getTeamEffortLabel(effort) : '';

  const modelAlreadyCarriesProviderBrand =
    doesTeamModelCarryProviderBrand(providerId, rawModelLabel) ||
    (providerId === 'codex' && model.trim().toLowerCase().startsWith('gpt-'));
  const providerActsAsBackendOnly =
    providerId !== 'anthropic' && modelLabel !== 'Default' && !modelAlreadyCarriesProviderBrand;

  const parts = modelAlreadyCarriesProviderBrand
    ? [modelLabel, effortLabel]
    : providerActsAsBackendOnly
      ? [modelLabel, `via ${providerLabel}`, effortLabel]
      : [providerLabel, modelLabel, effortLabel];

  return parts.filter(Boolean).join(' · ');
}

/**
 * Computes the effective model string for team provisioning.
 * By default adds [1m] suffix for 1M context (Opus/Sonnet).
 * When limitContext=true, returns base model without [1m] (200K context).
 * Haiku does not support 1M — always returned as-is.
 */
export function computeEffectiveTeamModel(
  selectedModel: string,
  limitContext: boolean,
  providerId: 'anthropic' | 'codex' | 'gemini' = 'anthropic'
): string | undefined {
  if (providerId !== 'anthropic') {
    return selectedModel.trim() || undefined;
  }

  const base = extractProviderScopedBaseModel(selectedModel, providerId);
  if (limitContext) return base;
  if (base === 'haiku') return base;
  return base ? `${base}[1m]` : 'opus[1m]';
}

export interface TeamModelSelectorProps {
  providerId: 'anthropic' | 'codex' | 'gemini';
  onProviderChange: (providerId: 'anthropic' | 'codex' | 'gemini') => void;
  value: string;
  onValueChange: (value: string) => void;
  id?: string;
  disableGeminiOption?: boolean;
}

export const TeamModelSelector: React.FC<TeamModelSelectorProps> = ({
  providerId,
  onProviderChange,
  value,
  onValueChange,
  id,
  disableGeminiOption = false,
}) => {
  const cliStatus = useStore((s) => s.cliStatus);
  const multimodelEnabled = useStore((s) => s.appConfig?.general?.multimodelEnabled ?? true);
  const multimodelAvailable = multimodelEnabled || cliStatus?.flavor === 'agent_teams_orchestrator';

  const effectiveProviderId =
    disableGeminiOption && isGeminiUiFrozen() && providerId === 'gemini' ? 'anthropic' : providerId;
  const defaultModelTooltip = useMemo(() => {
    if (effectiveProviderId === 'anthropic') {
      return 'Default model from Claude CLI (/model).\nUses the runtime default for the selected provider.';
    }
    return 'Uses the runtime default for the selected provider.';
  }, [effectiveProviderId]);
  const getProviderDisabledReason = (candidateProviderId: string): string | null => {
    if (candidateProviderId === 'opencode') {
      return OPENCODE_UI_DISABLED_REASON;
    }
    if (disableGeminiOption && isGeminiUiFrozen() && candidateProviderId === 'gemini') {
      return GEMINI_UI_DISABLED_REASON;
    }
    return null;
  };
  const isProviderTemporarilyDisabled = (candidateProviderId: string): boolean =>
    getProviderDisabledReason(candidateProviderId) !== null;
  const isProviderSelectable = (candidateProviderId: string): boolean =>
    !isProviderTemporarilyDisabled(candidateProviderId) &&
    (multimodelAvailable || candidateProviderId === 'anthropic');
  const activeProviderSelectable = isProviderSelectable(effectiveProviderId);
  const getProviderStatusBadge = (candidateProviderId: string): string | null => {
    if (candidateProviderId === 'opencode') {
      return 'In development';
    }

    const providerDisabledReason = getProviderDisabledReason(candidateProviderId);
    if (providerDisabledReason) {
      return GEMINI_UI_DISABLED_BADGE_LABEL;
    }

    if (!isProviderSelectable(candidateProviderId)) {
      return 'Multimodel off';
    }

    return null;
  };
  const getProviderStatusBadgeLabel = (statusBadge: string | null): string | null => {
    if (statusBadge === 'In development') {
      return 'Dev';
    }

    if (statusBadge === 'Multimodel off') {
      return 'Off';
    }

    return statusBadge;
  };
  const runtimeModels = useMemo(
    () =>
      cliStatus?.providers.find((provider) => provider.providerId === effectiveProviderId)
        ?.models ?? [],
    [cliStatus?.providers, effectiveProviderId]
  );
  const normalizedValue = normalizeTeamModelForUi(effectiveProviderId, value);

  useEffect(() => {
    if (normalizedValue !== value) {
      onValueChange(normalizedValue);
    }
  }, [normalizedValue, onValueChange, value]);

  const modelOptions = useMemo(() => {
    const fallback = getTeamProviderModelOptions(effectiveProviderId);
    if (effectiveProviderId === 'anthropic' || runtimeModels.length === 0) {
      return fallback.map((option) => ({
        ...option,
        label:
          option.value === ''
            ? option.label
            : getProviderScopedTeamModelLabel(effectiveProviderId, option.value),
      }));
    }
    const dynamicOptions = runtimeModels.map((model) => ({
      value: model,
      label: getProviderScopedTeamModelLabel(effectiveProviderId, model),
    }));
    return [{ value: '', label: 'Default' }, ...dynamicOptions];
  }, [effectiveProviderId, runtimeModels]);

  return (
    <div className="mb-5">
      <Label htmlFor={id} className="label-optional mb-1.5 block">
        Model (optional)
      </Label>
      <Tabs
        value={effectiveProviderId}
        onValueChange={(nextValue) => {
          if (
            (nextValue === 'anthropic' || nextValue === 'codex' || nextValue === 'gemini') &&
            isProviderSelectable(nextValue)
          ) {
            onProviderChange(nextValue);
          }
        }}
      >
        <div className="space-y-0">
          <div className="-mb-px border-b border-[var(--color-border-subtle)]">
            <TabsList className="h-auto w-full flex-wrap justify-start gap-1 rounded-none bg-transparent p-0">
              {PROVIDERS.map((provider) => {
                const providerDisabledReason = getProviderDisabledReason(provider.id);
                const providerSelectable = isProviderSelectable(provider.id);
                const statusBadge = getProviderStatusBadge(provider.id);
                const statusBadgeLabel = getProviderStatusBadgeLabel(statusBadge);

                return (
                  <TabsTrigger
                    key={provider.id}
                    value={provider.id}
                    disabled={provider.comingSoon || !providerSelectable}
                    title={
                      providerDisabledReason ??
                      (statusBadge === 'Multimodel off'
                        ? 'Enable Multimodel mode to use this provider.'
                        : (statusBadge ?? undefined))
                    }
                    className={cn(
                      "relative h-12 min-w-[128px] items-center justify-start gap-2 rounded-b-none border border-b-0 border-transparent px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] data-[state=active]:z-10 data-[state=active]:-mb-px data-[state=active]:border-[var(--color-border)] data-[state=active]:bg-[var(--color-surface)] data-[state=active]:text-[var(--color-text)] data-[state=active]:shadow-none data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:-bottom-px data-[state=active]:after:h-px data-[state=active]:after:bg-[var(--color-surface)] data-[state=active]:after:content-['']",
                      !providerSelectable && 'opacity-50'
                    )}
                  >
                    <ProviderBrandLogo providerId={provider.id} className="size-5 shrink-0" />
                    <span
                      className={cn(
                        'min-w-0 truncate text-sm font-medium',
                        statusBadgeLabel && 'pr-9'
                      )}
                    >
                      {provider.label}
                    </span>
                    {statusBadgeLabel ? (
                      <span
                        className="absolute right-2 top-1.5 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em]"
                        style={{
                          color: 'var(--color-text-muted)',
                          backgroundColor: 'rgba(255, 255, 255, 0.05)',
                        }}
                        aria-label={statusBadge ?? undefined}
                        title={statusBadge ?? undefined}
                      >
                        {statusBadgeLabel}
                      </span>
                    ) : null}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>

          <div className="rounded-b-md border border-t-0 border-[var(--color-border)] bg-[var(--color-surface)]">
            {!multimodelAvailable ? (
              <div className="border-b border-[var(--color-border-subtle)] px-3 py-2">
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  Codex and Gemini require Multimodel mode.
                </p>
              </div>
            ) : null}

            <div className="p-3">
              <div
                className="grid gap-1.5 rounded-md bg-[var(--color-surface)]"
                style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
              >
                {modelOptions.map((opt) =>
                  (() => {
                    const modelDisabledReason = getTeamModelUiDisabledReason(
                      effectiveProviderId,
                      opt.value
                    );
                    const modelSelectable = activeProviderSelectable && !modelDisabledReason;

                    return (
                      <button
                        key={opt.value || '__default__'}
                        type="button"
                        id={opt.value === normalizedValue ? id : undefined}
                        aria-disabled={!modelSelectable}
                        className={cn(
                          'flex min-h-[44px] items-center justify-center gap-1.5 rounded-md border bg-[var(--color-surface)] px-3 py-2 text-center text-xs font-medium transition-[background-color,border-color,color,box-shadow] duration-150',
                          normalizedValue === opt.value
                            ? 'border-[var(--color-border-emphasis)] bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                            : modelSelectable
                              ? 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)] hover:border-[var(--color-border-emphasis)] hover:bg-[color-mix(in_srgb,var(--color-surface-raised)_62%,var(--color-surface)_38%)] hover:text-[var(--color-text-secondary)] hover:shadow-sm'
                              : 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)]',
                          !modelSelectable && 'cursor-not-allowed opacity-45',
                          !modelDisabledReason && !activeProviderSelectable && 'pointer-events-none'
                        )}
                        onClick={() => {
                          if (!modelSelectable) return;
                          onValueChange(opt.value);
                        }}
                      >
                        <span className="flex flex-col items-center justify-center gap-0.5">
                          <span className="leading-tight">{opt.label}</span>
                          {opt.value === '' && (
                            <span className="flex items-center justify-center gap-1">
                              <TooltipProvider delayDuration={200}>
                                <Tooltip>
                                  <TooltipTrigger
                                    asChild
                                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                  >
                                    <Info className="size-3 shrink-0 opacity-40 transition-opacity hover:opacity-70" />
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[240px] text-xs">
                                    {defaultModelTooltip.split('\n').map((line, index) => (
                                      <React.Fragment key={line}>
                                        {index > 0 ? <br /> : null}
                                        {line}
                                      </React.Fragment>
                                    ))}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </span>
                          )}
                          {modelDisabledReason && (
                            <span
                              className="flex items-center justify-center gap-1 text-[10px] font-normal text-[var(--color-text-muted)]"
                              title={modelDisabledReason}
                            >
                              <span>{TEAM_MODEL_UI_DISABLED_BADGE_LABEL}</span>
                              <TooltipProvider delayDuration={200}>
                                <Tooltip>
                                  <TooltipTrigger
                                    asChild
                                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                  >
                                    <Info className="size-3 shrink-0 opacity-40 transition-opacity hover:opacity-70" />
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[240px] text-xs">
                                    {modelDisabledReason}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })()
                )}
              </div>
            </div>
          </div>
        </div>
      </Tabs>
    </div>
  );
};

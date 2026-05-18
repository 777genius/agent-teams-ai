import React, { useEffect, useMemo, useState } from 'react';

import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { HoverTooltip } from '@renderer/components/ui/hover-tooltip';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import {
  GEMINI_UI_DISABLED_BADGE_LABEL,
  GEMINI_UI_DISABLED_REASON,
  isGeminiUiFrozen,
} from '@renderer/utils/geminiUiFreeze';
import {
  getAvailableTeamProviderModelOptions,
  getOpenCodeOpenAiRouteAuthUnavailableReason,
  getTeamModelUiDisabledReason,
  isTeamProviderModelVerificationPending,
  normalizeTeamModelForUi,
  TEAM_MODEL_UI_DISABLED_BADGE_LABEL,
  type TeamRuntimeModelOption,
} from '@renderer/utils/teamModelAvailability';
import {
  doesTeamModelCarryProviderBrand,
  getProviderScopedTeamModelLabel,
  getRuntimeAwareProviderScopedTeamModelLabel,
  getTeamModelLabel as getCatalogTeamModelLabel,
  getTeamModelSourceBadgeLabel,
  getTeamProviderLabel as getCatalogTeamProviderLabel,
} from '@renderer/utils/teamModelCatalog';
import {
  compareTeamModelRecommendations,
  getTeamModelRecommendation,
  isTeamModelRecommended,
} from '@renderer/utils/teamModelRecommendations';
import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import { getAnthropicDefaultTeamModel } from '@shared/utils/anthropicModelDefaults';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { isTeamProviderId } from '@shared/utils/teamProvider';
import { Command as CommandPrimitive } from 'cmdk';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Filter,
  Info,
  Search,
  Star,
} from 'lucide-react';

import type { CliProviderStatus, TeamProviderId } from '@shared/types';

export { getProviderScopedTeamModelLabel } from '@renderer/utils/teamModelCatalog';

// --- Provider definitions ---

interface ProviderDef {
  id: TeamProviderId;
  label: string;
  comingSoon: boolean;
}

interface OpenCodeSourceOption {
  id: string;
  label: string;
  count: number;
}

interface OpenCodeModelGroup {
  sourceId: string;
  sourceLabel: string;
  options: TeamRuntimeModelOption[];
}

type ProviderModelCatalogItem = NonNullable<CliProviderStatus['modelCatalog']>['models'][number];

interface OpenCodeModelCostRates {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

interface OpenCodeModelPricingInfo {
  free: boolean;
  summary: string | null;
  title: string | undefined;
}

const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', label: 'Anthropic', comingSoon: false },
  { id: 'codex', label: 'Codex', comingSoon: false },
  { id: 'gemini', label: 'Gemini', comingSoon: false },
  { id: 'opencode', label: 'OpenCode', comingSoon: false },
];

function getOpenCodeSourceInfo(model: string): { id: string; label: string } | null {
  const parsed = parseOpenCodeQualifiedModelRef(model);
  if (!parsed) {
    return null;
  }

  return {
    id: parsed.sourceId,
    label: getTeamModelSourceBadgeLabel('opencode', model) ?? parsed.sourceId,
  };
}

function getRecordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }
  return undefined;
}

function getFiniteCostNumber(record: Record<string, unknown>, keys: string[]): number | null {
  const value = getRecordValue(record, keys);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractOpenCodeCostRates(cost: unknown): OpenCodeModelCostRates | null {
  if (!cost || typeof cost !== 'object' || Array.isArray(cost)) {
    return null;
  }

  const record = cost as Record<string, unknown>;
  const rates: OpenCodeModelCostRates = {
    input: getFiniteCostNumber(record, ['input']),
    output: getFiniteCostNumber(record, ['output']),
    cacheRead: getFiniteCostNumber(record, ['cache_read', 'cacheRead', 'cached_read']),
    cacheWrite: getFiniteCostNumber(record, ['cache_write', 'cacheWrite', 'cached_write']),
  };

  return Object.values(rates).some((rate) => rate !== null) ? rates : null;
}

function formatOpenCodeCostRate(rate: number): string {
  if (rate === 0) {
    return 'Free';
  }

  const formatted = rate.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: rate >= 1 ? 2 : 4,
  });
  return `$${formatted}`;
}

function formatOpenCodeCostSummary(rates: OpenCodeModelCostRates): string | null {
  const summaryParts: string[] = [];
  if (rates.input !== null) {
    summaryParts.push(`in ${formatOpenCodeCostRate(rates.input)}`);
  }
  if (rates.output !== null) {
    summaryParts.push(`out ${formatOpenCodeCostRate(rates.output)}`);
  }

  if (summaryParts.length === 0) {
    return null;
  }

  return `${summaryParts.join(' · ')} / 1M`;
}

function formatOpenCodeCostTitle(rates: OpenCodeModelCostRates): string {
  const titleParts: string[] = [];
  if (rates.input !== null) {
    titleParts.push(`Input: ${formatOpenCodeCostRate(rates.input)} per 1M tokens`);
  }
  if (rates.output !== null) {
    titleParts.push(`Output: ${formatOpenCodeCostRate(rates.output)} per 1M tokens`);
  }
  if (rates.cacheRead !== null) {
    titleParts.push(`Cache read: ${formatOpenCodeCostRate(rates.cacheRead)} per 1M tokens`);
  }
  if (rates.cacheWrite !== null) {
    titleParts.push(`Cache write: ${formatOpenCodeCostRate(rates.cacheWrite)} per 1M tokens`);
  }
  return titleParts.join('\n');
}

function getOpenCodeModelPricingInfo(
  catalogModel: ProviderModelCatalogItem | null | undefined
): OpenCodeModelPricingInfo | null {
  const metadata = catalogModel?.metadata;
  if (!metadata) {
    return null;
  }

  const rates = extractOpenCodeCostRates(metadata.cost);
  return {
    free: metadata.free === true,
    summary: rates ? formatOpenCodeCostSummary(rates) : null,
    title: rates ? formatOpenCodeCostTitle(rates) : undefined,
  };
}

const OPENCODE_UI_DISABLED_REASON = 'OpenCode team launch is not ready.';
export const OPENCODE_ONE_SHOT_DISABLED_REASON =
  'OpenCode team launch is available for normal teams, but scheduled one-shot prompts still run through claude -p. Choose Anthropic, Codex, or Gemini for one-shot schedules.';
export const OPENCODE_ONE_SHOT_DISABLED_BADGE_LABEL = 'team only';

export function getTeamModelLabel(model: string): string {
  return getCatalogTeamModelLabel(model) ?? model;
}

export function getTeamProviderLabel(providerId: TeamProviderId): string {
  return getCatalogTeamProviderLabel(providerId) ?? 'Anthropic';
}

export function getTeamEffortLabel(effort: string): string {
  const trimmed = effort.trim();
  if (!trimmed) return 'Default';
  if (trimmed === 'xhigh') return 'XHigh';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function formatTeamModelSummary(
  providerId: TeamProviderId,
  model: string,
  effort?: string
): string {
  const providerLabel = getTeamProviderLabel(providerId);
  const routeLabel =
    providerId === 'opencode'
      ? (getTeamModelSourceBadgeLabel(providerId, model.trim()) ?? providerLabel)
      : providerLabel;
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
      ? [modelLabel, `via ${routeLabel}`, effortLabel]
      : [providerLabel, modelLabel, effortLabel];

  return parts.filter(Boolean).join(' · ');
}

/**
 * Computes the effective model string for team provisioning.
 * By default adds [1m] suffix for Opus 1M context.
 * When limitContext=true, returns base model without [1m] (200K context).
 * Standard Sonnet and Haiku selections stay standard context. Explicit Sonnet 1M selections keep
 * their [1m] suffix unless the 200K limit is enabled.
 */
export function computeEffectiveTeamModel(
  selectedModel: string,
  limitContext: boolean,
  providerId: TeamProviderId = 'anthropic',
  providerStatus?: Pick<CliProviderStatus, 'providerId' | 'modelCatalog'> | null
): string | undefined {
  if (providerId !== 'anthropic') {
    return selectedModel.trim() || undefined;
  }

  const catalog =
    providerStatus?.providerId === 'anthropic' ? (providerStatus.modelCatalog ?? null) : null;

  return (
    resolveAnthropicLaunchModel({
      selectedModel,
      limitContext,
      availableLaunchModels: catalog?.models.map((model) => model.launchModel),
      defaultLaunchModel: catalog?.defaultLaunchModel ?? null,
    }) ?? getAnthropicDefaultTeamModel(limitContext)
  );
}

export interface TeamModelSelectorProps {
  providerId: TeamProviderId;
  onProviderChange: (providerId: TeamProviderId) => void;
  value: string;
  onValueChange: (value: string) => void;
  id?: string;
  disableGeminiOption?: boolean;
  providerDisabledReasonById?: Partial<Record<TeamProviderId, string | null | undefined>>;
  providerDisabledBadgeLabelById?: Partial<Record<TeamProviderId, string | null | undefined>>;
  modelIssueReasonByValue?: Partial<Record<string, string | null | undefined>>;
  modelUnavailableReasonByValue?: Partial<Record<string, string | null | undefined>>;
}

export const TeamModelSelector: React.FC<TeamModelSelectorProps> = ({
  providerId,
  onProviderChange,
  value,
  onValueChange,
  id,
  disableGeminiOption = false,
  providerDisabledReasonById,
  providerDisabledBadgeLabelById,
  modelIssueReasonByValue,
  modelUnavailableReasonByValue,
}) => {
  const multimodelEnabled = useStore((s) => s.appConfig?.general?.multimodelEnabled ?? true);
  const [recommendedOnly, setRecommendedOnly] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [openCodeSourceFilterOpen, setOpenCodeSourceFilterOpen] = useState(false);
  const [openCodeSourceQuery, setOpenCodeSourceQuery] = useState('');
  const [selectedOpenCodeSourceIds, setSelectedOpenCodeSourceIds] = useState<Set<string>>(
    () => new Set()
  );

  const effectiveProviderId =
    disableGeminiOption && isGeminiUiFrozen() && providerId === 'gemini' ? 'anthropic' : providerId;
  const { cliStatus: effectiveCliStatus, providerStatus: runtimeProviderStatus } =
    useEffectiveCliProviderStatus(effectiveProviderId);
  const multimodelAvailable =
    multimodelEnabled || effectiveCliStatus?.flavor === 'agent_teams_orchestrator';
  const runtimeProviderStatusById = useMemo(
    () =>
      new Map(
        (effectiveCliStatus?.providers ?? []).map((provider) => [provider.providerId, provider])
      ),
    [effectiveCliStatus?.providers]
  );
  const defaultModelTooltip = useMemo(() => {
    if (effectiveProviderId === 'anthropic') {
      const defaultLongContextModel =
        getRuntimeAwareProviderScopedTeamModelLabel(
          'anthropic',
          getAnthropicDefaultTeamModel(false),
          runtimeProviderStatus
        ) ?? 'Opus 4.7 (1M)';
      const defaultLimitedContextModel =
        getRuntimeAwareProviderScopedTeamModelLabel(
          'anthropic',
          getAnthropicDefaultTeamModel(true),
          runtimeProviderStatus
        ) ?? 'Opus 4.7';

      return `Uses the Claude team default model.\nResolves to ${defaultLongContextModel} with 1M context, or ${defaultLimitedContextModel} with 200K context when Limit context is enabled.`;
    }
    return 'Uses the runtime default for the selected provider.';
  }, [effectiveProviderId, runtimeProviderStatus]);
  const getProviderDisabledReason = (candidateProviderId: string): string | null => {
    if (isTeamProviderId(candidateProviderId)) {
      const overrideReason = providerDisabledReasonById?.[candidateProviderId]?.trim();
      if (overrideReason) {
        return overrideReason;
      }
    }

    if (candidateProviderId === 'opencode') {
      const providerStatus = runtimeProviderStatusById.get('opencode') ?? null;
      if (!providerStatus) {
        return 'OpenCode runtime status is still loading.';
      }
      if (!providerStatus.supported) {
        return (
          providerStatus.detailMessage ??
          providerStatus.statusMessage ??
          'OpenCode CLI is not installed.'
        );
      }
      if (!providerStatus.authenticated) {
        return (
          providerStatus.detailMessage ??
          providerStatus.statusMessage ??
          'OpenCode has no connected provider.'
        );
      }
      if (!providerStatus.capabilities.teamLaunch) {
        return (
          providerStatus.detailMessage ??
          providerStatus.statusMessage ??
          OPENCODE_UI_DISABLED_REASON
        );
      }
      return null;
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
    if (isTeamProviderId(candidateProviderId)) {
      const overrideReason = providerDisabledReasonById?.[candidateProviderId]?.trim();
      const overrideBadge = providerDisabledBadgeLabelById?.[candidateProviderId]?.trim();
      if (overrideReason && overrideBadge) {
        return overrideBadge;
      }
    }

    if (candidateProviderId === 'opencode') {
      return getProviderDisabledReason(candidateProviderId) ? 'Gated' : null;
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
    if (statusBadge === 'Gated') {
      return 'Gate';
    }

    if (statusBadge === 'Multimodel off') {
      return 'Off';
    }

    return statusBadge;
  };
  const shouldAwaitRuntimeModelList =
    effectiveProviderId !== 'anthropic' &&
    (runtimeProviderStatus == null ||
      isTeamProviderModelVerificationPending(effectiveProviderId, runtimeProviderStatus));
  const normalizedValue = normalizeTeamModelForUi(
    effectiveProviderId,
    value,
    runtimeProviderStatus
  );

  useEffect(() => {
    if (normalizedValue !== value) {
      onValueChange(normalizedValue);
    }
  }, [normalizedValue, onValueChange, value]);

  const modelOptions = useMemo(() => {
    if (shouldAwaitRuntimeModelList) {
      return [{ value: '', label: 'Default', badgeLabel: 'Default' }];
    }
    return getAvailableTeamProviderModelOptions(effectiveProviderId, runtimeProviderStatus);
  }, [effectiveProviderId, runtimeProviderStatus, shouldAwaitRuntimeModelList]);
  const openCodeCatalogModelById = useMemo(() => {
    const catalog = runtimeProviderStatus?.modelCatalog;
    const modelById = new Map<string, ProviderModelCatalogItem>();
    if (effectiveProviderId !== 'opencode' || catalog?.providerId !== 'opencode') {
      return modelById;
    }

    for (const model of catalog.models) {
      const launchModel = model.launchModel.trim();
      const id = model.id.trim();
      if (launchModel) {
        modelById.set(launchModel, model);
      }
      if (id) {
        modelById.set(id, model);
      }
    }

    return modelById;
  }, [effectiveProviderId, runtimeProviderStatus?.modelCatalog]);
  const hasRecommendedOpenCodeModels = useMemo(
    () =>
      effectiveProviderId === 'opencode' &&
      modelOptions.some((option) => isTeamModelRecommended(effectiveProviderId, option.value)),
    [effectiveProviderId, modelOptions]
  );

  useEffect(() => {
    if (effectiveProviderId !== 'opencode' || !hasRecommendedOpenCodeModels) {
      queueMicrotask(() => setRecommendedOnly(false));
    }
  }, [effectiveProviderId, hasRecommendedOpenCodeModels]);

  useEffect(() => {
    queueMicrotask(() => setModelQuery(''));
  }, [effectiveProviderId]);

  useEffect(() => {
    if (effectiveProviderId !== 'opencode') {
      queueMicrotask(() => {
        setSelectedOpenCodeSourceIds(new Set());
        setOpenCodeSourceFilterOpen(false);
      });
    }
  }, [effectiveProviderId]);

  useEffect(() => {
    if (!openCodeSourceFilterOpen) {
      queueMicrotask(() => setOpenCodeSourceQuery(''));
    }
  }, [openCodeSourceFilterOpen]);

  const openCodeSourceOptions = useMemo<OpenCodeSourceOption[]>(() => {
    if (effectiveProviderId !== 'opencode') {
      return [];
    }

    const sourceOptions = new Map<string, OpenCodeSourceOption>();
    for (const option of modelOptions) {
      if (!option.value.trim()) {
        continue;
      }
      if (recommendedOnly && !isTeamModelRecommended(effectiveProviderId, option.value)) {
        continue;
      }

      const sourceInfo = getOpenCodeSourceInfo(option.value);
      if (!sourceInfo) {
        continue;
      }

      const existing = sourceOptions.get(sourceInfo.id);
      sourceOptions.set(sourceInfo.id, {
        id: sourceInfo.id,
        label: sourceInfo.label,
        count: (existing?.count ?? 0) + 1,
      });
    }

    return Array.from(sourceOptions.values()).sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
    );
  }, [effectiveProviderId, modelOptions, recommendedOnly]);

  useEffect(() => {
    if (selectedOpenCodeSourceIds.size === 0) {
      return;
    }

    const availableSourceIds = new Set(openCodeSourceOptions.map((source) => source.id));
    const nextSelectedSourceIds = new Set(
      Array.from(selectedOpenCodeSourceIds).filter((sourceId) => availableSourceIds.has(sourceId))
    );
    if (nextSelectedSourceIds.size !== selectedOpenCodeSourceIds.size) {
      queueMicrotask(() => setSelectedOpenCodeSourceIds(nextSelectedSourceIds));
    }
  }, [openCodeSourceOptions, selectedOpenCodeSourceIds]);

  const filteredOpenCodeSourceOptions = useMemo(() => {
    const query = openCodeSourceQuery.trim().toLowerCase();
    if (!query) {
      return openCodeSourceOptions;
    }

    return openCodeSourceOptions.filter((source) =>
      [source.id, source.label].join(' ').toLowerCase().includes(query)
    );
  }, [openCodeSourceOptions, openCodeSourceQuery]);

  const selectedOpenCodeSourceLabels = useMemo(() => {
    const labelById = new Map(openCodeSourceOptions.map((source) => [source.id, source.label]));
    return Array.from(selectedOpenCodeSourceIds)
      .map((sourceId) => labelById.get(sourceId))
      .filter((label): label is string => Boolean(label));
  }, [openCodeSourceOptions, selectedOpenCodeSourceIds]);

  const openCodeSourceFilterLabel =
    selectedOpenCodeSourceLabels.length === 0
      ? 'All OpenCode providers'
      : selectedOpenCodeSourceLabels.length === 1
        ? selectedOpenCodeSourceLabels[0]
        : `${selectedOpenCodeSourceLabels.length} OpenCode providers`;

  const toggleOpenCodeSourceFilter = (sourceId: string): void => {
    setSelectedOpenCodeSourceIds((previous) => {
      const next = new Set(previous);
      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }
      return next;
    });
  };

  const visibleModelOptions = useMemo(() => {
    const normalizedModelQuery = modelQuery.trim().toLowerCase();
    const matchesModelQuery = (option: (typeof modelOptions)[number]): boolean => {
      if (!normalizedModelQuery) {
        return true;
      }
      const modelRecommendation = getTeamModelRecommendation(effectiveProviderId, option.value);
      const openCodePricingInfo = getOpenCodeModelPricingInfo(
        openCodeCatalogModelById.get(option.value)
      );
      return [
        option.value,
        option.label,
        option.badgeLabel ?? '',
        getOpenCodeSourceInfo(option.value)?.label ?? '',
        modelRecommendation?.label ?? '',
        modelRecommendation?.reason ?? '',
        openCodePricingInfo?.free ? 'free' : '',
        openCodePricingInfo?.summary ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedModelQuery);
    };

    if (effectiveProviderId !== 'opencode') {
      return modelOptions.filter(matchesModelQuery);
    }

    const concreteOptions = modelOptions
      .filter((option) => option.value.trim().length > 0)
      .map((option, index) => ({ option, index }))
      .filter(
        ({ option }) =>
          !recommendedOnly || isTeamModelRecommended(effectiveProviderId, option.value)
      )
      .filter(({ option }) => {
        if (selectedOpenCodeSourceIds.size === 0) {
          return true;
        }
        const sourceInfo = getOpenCodeSourceInfo(option.value);
        return Boolean(sourceInfo && selectedOpenCodeSourceIds.has(sourceInfo.id));
      })
      .filter(({ option }) => matchesModelQuery(option))
      .sort((left, right) => {
        const recommendationOrder = compareTeamModelRecommendations(
          effectiveProviderId,
          left.option.value,
          right.option.value
        );
        return recommendationOrder || left.index - right.index;
      })
      .map(({ option }) => option);

    if (recommendedOnly) {
      return concreteOptions;
    }

    return [
      ...modelOptions.filter((option) => option.value.trim().length === 0),
      ...concreteOptions,
    ].filter(matchesModelQuery);
  }, [
    effectiveProviderId,
    modelOptions,
    modelQuery,
    openCodeCatalogModelById,
    recommendedOnly,
    selectedOpenCodeSourceIds,
  ]);
  const visibleOpenCodeModelGroups = useMemo<OpenCodeModelGroup[]>(() => {
    if (effectiveProviderId !== 'opencode') {
      return [];
    }

    const groups = new Map<string, OpenCodeModelGroup>();
    for (const option of visibleModelOptions) {
      if (!option.value.trim()) {
        continue;
      }

      const sourceInfo = getOpenCodeSourceInfo(option.value);
      if (!sourceInfo) {
        continue;
      }

      const existingGroup = groups.get(sourceInfo.id);
      if (existingGroup) {
        existingGroup.options.push(option);
      } else {
        groups.set(sourceInfo.id, {
          sourceId: sourceInfo.id,
          sourceLabel: sourceInfo.label,
          options: [option],
        });
      }
    }

    return Array.from(groups.values());
  }, [effectiveProviderId, visibleModelOptions]);
  const visibleDefaultModelOptions = visibleModelOptions.filter((option) => !option.value.trim());
  const concreteModelOptionCount = modelOptions.filter((option) => option.value.trim()).length;
  const shouldShowModelSearch = concreteModelOptionCount > 8;
  const trimmedModelQuery = modelQuery.trim();
  const shouldConstrainModelListHeight = visibleModelOptions.length > 8;
  const renderModelOption = (opt: TeamRuntimeModelOption): React.JSX.Element => {
    const modelDisabledReason = getTeamModelUiDisabledReason(
      effectiveProviderId,
      opt.value,
      runtimeProviderStatus
    );
    const availabilityStatus =
      opt.value === '' ? 'available' : (opt.availabilityStatus ?? 'available');
    const availabilityReason = opt.value === '' ? null : (opt.availabilityReason ?? null);
    const runtimeUnavailableReason =
      opt.value !== '' && availabilityStatus === 'unavailable'
        ? (availabilityReason ?? 'Unavailable in current runtime')
        : null;
    const modelIssueReason =
      opt.value === '' ? null : (modelIssueReasonByValue?.[opt.value] ?? null);
    const modelUnavailableReason =
      opt.value === ''
        ? null
        : (modelUnavailableReasonByValue?.[opt.value] ??
          getOpenCodeOpenAiRouteAuthUnavailableReason(
            effectiveProviderId,
            opt.value,
            runtimeProviderStatus
          ) ??
          runtimeUnavailableReason);
    const hasModelIssue = Boolean(modelIssueReason || modelUnavailableReason);
    const modelSelectable =
      activeProviderSelectable &&
      !modelUnavailableReason &&
      !modelDisabledReason &&
      (opt.value === '' || availabilityStatus == null || availabilityStatus === 'available');
    const modelStatusMessage =
      modelUnavailableReason ??
      modelIssueReason ??
      modelDisabledReason ??
      availabilityReason ??
      null;
    const modelRecommendation = getTeamModelRecommendation(effectiveProviderId, opt.value);
    const openCodePricingInfo =
      effectiveProviderId === 'opencode'
        ? getOpenCodeModelPricingInfo(openCodeCatalogModelById.get(opt.value))
        : null;
    const modelButtonTitle =
      modelStatusMessage ?? (opt.value === '' ? defaultModelTooltip : undefined);

    return (
      <button
        key={opt.value || '__default__'}
        type="button"
        id={opt.value === normalizedValue ? id : undefined}
        aria-disabled={!modelSelectable}
        title={modelButtonTitle}
        className={cn(
          'flex min-h-[44px] items-center justify-center gap-1.5 rounded-md border bg-[var(--color-surface)] px-3 py-2 text-center text-xs font-medium transition-[background-color,border-color,color,box-shadow] duration-150',
          hasModelIssue && normalizedValue === opt.value
            ? 'border-red-500/60 bg-red-500/10 text-red-100 shadow-sm'
            : hasModelIssue
              ? 'border-red-500/40 bg-red-500/5 text-red-200 hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-100'
              : normalizedValue === opt.value
                ? 'border-[var(--color-border-emphasis)] bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                : modelSelectable
                  ? 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)] hover:border-[var(--color-border-emphasis)] hover:bg-[color-mix(in_srgb,var(--color-surface-raised)_62%,var(--color-surface)_38%)] hover:text-[var(--color-text-secondary)] hover:shadow-sm'
                  : 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)]',
          !modelSelectable && 'cursor-not-allowed',
          !modelDisabledReason && !activeProviderSelectable && 'pointer-events-none'
        )}
        onClick={() => {
          if (!modelSelectable) return;
          onValueChange(opt.value);
        }}
      >
        <span className="flex flex-col items-center justify-center gap-0.5">
          <span
            className={cn(
              'max-w-full break-words leading-tight',
              opt.value === 'gpt-5.5' && 'font-bold'
            )}
          >
            {opt.label}
          </span>
          {openCodePricingInfo?.summary ? (
            <span
              data-testid="team-model-selector-model-pricing"
              className="max-w-full text-balance text-[9px] font-normal leading-[1.1] text-[var(--color-text-muted)]"
              title={openCodePricingInfo.title}
            >
              {openCodePricingInfo.summary}
            </span>
          ) : null}
          {openCodePricingInfo?.free ? (
            <span
              data-testid="team-model-selector-model-free-badge"
              className="inline-flex items-center justify-center rounded-full border border-emerald-300/30 bg-emerald-300/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-emerald-200"
              title="OpenCode marks this model as free."
            >
              Free
            </span>
          ) : null}
          {modelRecommendation ? (
            <span
              className={cn(
                'inline-flex items-center justify-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                modelRecommendation.level === 'recommended'
                  ? 'border-emerald-300/35 bg-emerald-300/10 text-emerald-200'
                  : modelRecommendation.level === 'recommended-with-limits'
                    ? 'border-amber-300/35 bg-amber-300/10 text-amber-200'
                    : modelRecommendation.level === 'tested'
                      ? 'border-sky-300/35 bg-sky-300/10 text-sky-200'
                      : modelRecommendation.level === 'tested-with-limits'
                        ? 'border-cyan-300/30 bg-cyan-400/10 text-cyan-200'
                        : modelRecommendation.level === 'unavailable-in-opencode'
                          ? 'border-slate-300/30 bg-slate-400/10 text-slate-200'
                          : 'border-red-300/35 bg-red-400/10 text-red-200'
              )}
              title={modelRecommendation.reason}
            >
              {modelRecommendation.level === 'not-recommended' ||
              modelRecommendation.level === 'unavailable-in-opencode' ? (
                <AlertTriangle className="size-3 shrink-0" />
              ) : modelRecommendation.level === 'tested' ||
                modelRecommendation.level === 'tested-with-limits' ? (
                <CheckCircle2 className="size-3 shrink-0" />
              ) : (
                <Star className="size-3 shrink-0 fill-current" />
              )}
              <span>{modelRecommendation.label}</span>
            </span>
          ) : null}
          {opt.value === '' ? (
            <span className="flex items-center justify-center gap-1">
              <HoverTooltip
                content={defaultModelTooltip}
                title={defaultModelTooltip}
                stopClickPropagation
                contentClassName="max-w-[240px]"
              >
                <Info className="size-3 shrink-0 opacity-45 transition-opacity hover:opacity-75" />
              </HoverTooltip>
            </span>
          ) : null}
          {hasModelIssue && (
            <span
              className="flex items-center justify-center gap-1 text-[10px] font-normal text-red-300"
              title={modelStatusMessage ?? undefined}
            >
              <AlertTriangle className="size-3 shrink-0" />
              <span>{modelUnavailableReason ? 'Unavailable' : 'Issue'}</span>
              {modelStatusMessage ? (
                <HoverTooltip
                  content={modelStatusMessage}
                  title={modelStatusMessage}
                  stopClickPropagation
                  contentClassName="max-w-[240px]"
                >
                  <Info className="size-3 shrink-0 opacity-55 transition-opacity hover:opacity-85" />
                </HoverTooltip>
              ) : null}
            </span>
          )}
          {!hasModelIssue && modelDisabledReason && (
            <span
              className="flex items-center justify-center gap-1 text-[10px] font-normal text-[var(--color-text-muted)]"
              title={modelDisabledReason}
            >
              <span>{TEAM_MODEL_UI_DISABLED_BADGE_LABEL}</span>
              <HoverTooltip
                content={modelDisabledReason}
                title={modelDisabledReason}
                stopClickPropagation
                contentClassName="max-w-[240px]"
              >
                <Info className="size-3 shrink-0 opacity-45 transition-opacity hover:opacity-75" />
              </HoverTooltip>
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="mb-5">
      <Label htmlFor={id} className="label-optional mb-1.5 block">
        Model (optional)
      </Label>
      <Tabs
        value={effectiveProviderId}
        onValueChange={(nextValue) => {
          if (isTeamProviderId(nextValue) && isProviderSelectable(nextValue)) {
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
              {shouldAwaitRuntimeModelList ? (
                <p className="mb-2 text-[11px] text-[var(--color-text-muted)]">
                  Explicit models load from the current runtime. Default remains available while the
                  list is syncing.
                </p>
              ) : null}
              {shouldShowModelSearch ? (
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
                  <Input
                    data-testid="team-model-selector-model-search"
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                    placeholder="Search models"
                    aria-label="Search models"
                    className="h-9 pr-3 text-sm"
                    style={{ paddingLeft: 40 }}
                  />
                </div>
              ) : null}
              {(effectiveProviderId === 'opencode' && openCodeSourceOptions.length > 1) ||
              hasRecommendedOpenCodeModels ? (
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {effectiveProviderId === 'opencode' && openCodeSourceOptions.length > 1 ? (
                    <Popover
                      open={openCodeSourceFilterOpen}
                      onOpenChange={setOpenCodeSourceFilterOpen}
                    >
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          data-testid="team-model-selector-opencode-provider-filter"
                          className={cn(
                            'inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 text-xs text-[var(--color-text-secondary)] shadow-sm transition-colors hover:border-[var(--color-border-emphasis)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)]',
                            selectedOpenCodeSourceIds.size > 0 &&
                              'border-[var(--color-border-emphasis)] text-[var(--color-text)]'
                          )}
                          aria-label="Filter OpenCode providers"
                        >
                          <Filter className="size-3.5 shrink-0" />
                          <span className="min-w-0 truncate">{openCodeSourceFilterLabel}</span>
                          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-72 p-0">
                        <CommandPrimitive
                          className="flex size-full flex-col overflow-hidden rounded-md bg-[var(--color-surface)]"
                          shouldFilter={false}
                        >
                          <div className="flex items-center border-b border-[var(--color-border)]">
                            <CommandPrimitive.Input
                              value={openCodeSourceQuery}
                              onValueChange={setOpenCodeSourceQuery}
                              placeholder="Search providers"
                              className="flex h-8 w-full border-0 bg-transparent px-2 py-1 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
                            />
                          </div>
                          <CommandPrimitive.List className="max-h-72 overflow-y-auto overscroll-contain p-1">
                            <CommandPrimitive.Empty className="py-4 text-center text-xs text-[var(--color-text-muted)]">
                              No providers found.
                            </CommandPrimitive.Empty>
                            {selectedOpenCodeSourceIds.size > 0 && !openCodeSourceQuery.trim() ? (
                              <CommandPrimitive.Item
                                value="__all_opencode_providers__"
                                onSelect={() => setSelectedOpenCodeSourceIds(new Set())}
                                className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-[var(--color-text-muted)] outline-none data-[selected=true]:bg-[var(--color-surface-raised)] data-[selected=true]:text-[var(--color-text)]"
                              >
                                <Check className="size-3.5 shrink-0 opacity-70" />
                                All OpenCode providers
                              </CommandPrimitive.Item>
                            ) : null}
                            {filteredOpenCodeSourceOptions.map((source) => {
                              const selected = selectedOpenCodeSourceIds.has(source.id);
                              return (
                                <CommandPrimitive.Item
                                  key={source.id}
                                  value={`${source.label} ${source.id}`}
                                  onSelect={() => toggleOpenCodeSourceFilter(source.id)}
                                  className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none data-[selected=true]:bg-[var(--color-surface-raised)] data-[selected=true]:text-[var(--color-text)]"
                                >
                                  <Checkbox
                                    checked={selected}
                                    onCheckedChange={() => toggleOpenCodeSourceFilter(source.id)}
                                    onClick={(event) => event.stopPropagation()}
                                    className="size-3.5"
                                    aria-label={`Filter ${source.label}`}
                                  />
                                  <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">
                                    {source.label}
                                  </span>
                                  <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                                    {source.count}
                                  </span>
                                </CommandPrimitive.Item>
                              );
                            })}
                          </CommandPrimitive.List>
                        </CommandPrimitive>
                      </PopoverContent>
                    </Popover>
                  ) : null}
                  {hasRecommendedOpenCodeModels ? (
                    <div className="flex w-fit items-center gap-2">
                      <Checkbox
                        id="opencode-team-model-recommended-only"
                        checked={recommendedOnly}
                        onCheckedChange={(checked) => setRecommendedOnly(checked === true)}
                        className="size-3.5"
                      />
                      <Label
                        htmlFor="opencode-team-model-recommended-only"
                        className="cursor-pointer text-[11px] font-normal text-[var(--color-text-secondary)]"
                      >
                        Recommended only
                      </Label>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {effectiveProviderId === 'opencode' ? (
                <div
                  data-testid="team-model-selector-model-grid"
                  className={cn(
                    'space-y-3 rounded-md bg-[var(--color-surface)]',
                    shouldConstrainModelListHeight && 'overflow-y-auto pr-1'
                  )}
                  style={{
                    maxHeight: shouldConstrainModelListHeight ? 400 : undefined,
                  }}
                >
                  {visibleDefaultModelOptions.length > 0 ? (
                    <div
                      className="grid gap-1.5"
                      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
                    >
                      {visibleDefaultModelOptions.map(renderModelOption)}
                    </div>
                  ) : null}
                  {visibleOpenCodeModelGroups.map((group) => (
                    <section key={group.sourceId} data-testid="team-model-selector-opencode-group">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <h4 className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
                          {group.sourceLabel}
                        </h4>
                        <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                          {group.options.length}
                        </span>
                      </div>
                      <div
                        className="grid gap-1.5"
                        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
                      >
                        {group.options.map(renderModelOption)}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div
                  data-testid="team-model-selector-model-grid"
                  className={cn(
                    'grid gap-1.5 rounded-md bg-[var(--color-surface)]',
                    shouldConstrainModelListHeight && 'overflow-y-auto pr-1'
                  )}
                  style={{
                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                    maxHeight: shouldConstrainModelListHeight ? 400 : undefined,
                  }}
                >
                  {visibleModelOptions.map(renderModelOption)}
                </div>
              )}
              {visibleModelOptions.length === 0 ? (
                <div className="rounded-md border border-white/10 px-3 py-2 text-xs text-[var(--color-text-muted)]">
                  {trimmedModelQuery
                    ? 'No models match this search.'
                    : effectiveProviderId === 'opencode' && recommendedOnly
                      ? 'No recommended OpenCode models are available in the current runtime list.'
                      : 'No models are available in the current runtime list.'}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </Tabs>
    </div>
  );
};

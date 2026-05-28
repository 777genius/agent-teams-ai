import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { isOpenCodeCatalogHydrating } from '@renderer/components/runtime/providerConnectionUi';
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
  canUseCustomAnthropicCompatibleModel,
  getAvailableTeamProviderModelOptions,
  getOpenCodeOpenAiRouteAuthUnavailableReason,
  getTeamModelUiDisabledReason,
  isAnthropicCompatibleRuntime,
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
} from '@renderer/utils/teamModelRecommendations';
import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import { getAnthropicDefaultTeamModel } from '@shared/utils/anthropicModelDefaults';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { isTeamProviderId } from '@shared/utils/teamProvider';
import { useVirtualizer } from '@tanstack/react-virtual';
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

interface OpenCodeSourceInfo {
  id: string;
  label: string;
}

interface OpenCodeRouteGroupInfo {
  id: string;
  label: string;
  rank: number;
}

interface OpenCodeModelGroup {
  groupId: string;
  groupLabel: string;
  rank: number;
  sortLabel: string;
  firstIndex: number;
  options: TeamRuntimeModelOption[];
}

interface OpenCodeModelOptionMetadata {
  option: TeamRuntimeModelOption;
  index: number;
  sourceInfo: OpenCodeSourceInfo | null;
  routeGroup: OpenCodeRouteGroupInfo;
  routeMetadata: NonNullable<ProviderModelCatalogItem['metadata']>['opencode'] | null;
  recommendation: ReturnType<typeof getTeamModelRecommendation>;
  pricingInfo: OpenCodeModelPricingInfo | null;
  searchText: string;
  isRecommended: boolean;
  isFree: boolean;
}

interface OpenCodeVirtualHeadingRow {
  kind: 'heading';
  key: string;
  sourceLabel: string;
  count: number;
}

interface OpenCodeVirtualModelRow {
  kind: 'models';
  key: string;
  options: TeamRuntimeModelOption[];
  isLastInGroup: boolean;
}

type OpenCodeVirtualRow = OpenCodeVirtualHeadingRow | OpenCodeVirtualModelRow;
type RenderModelOption = (option: TeamRuntimeModelOption) => React.JSX.Element;

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

type TeamTranslator = ReturnType<typeof useAppTranslation>['t'];

const MODEL_GRID_MIN_CARD_WIDTH_PX = 140;
const MODEL_GRID_GAP_PX = 6;
const OPENCODE_MODEL_GRID_MAX_HEIGHT_PX = 400;
const OPENCODE_MODEL_VIRTUALIZATION_THRESHOLD = 80;
const OPENCODE_MODEL_GROUP_HEADING_ESTIMATE_PX = 28;
const OPENCODE_MODEL_ROW_ESTIMATE_PX = 92;

const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', label: 'Anthropic', comingSoon: false },
  { id: 'codex', label: 'Codex', comingSoon: false },
  { id: 'opencode', label: 'OpenCode', comingSoon: false },
  { id: 'gemini', label: 'Gemini', comingSoon: false },
];

function getOpenCodeSourceInfo(model: string): OpenCodeSourceInfo | null {
  const parsed = parseOpenCodeQualifiedModelRef(model);
  if (!parsed) {
    return null;
  }

  return {
    id: parsed.sourceId,
    label: getTeamModelSourceBadgeLabel('opencode', model) ?? parsed.sourceId,
  };
}

function getOpenCodeRouteGroup(
  catalogModel: ProviderModelCatalogItem | null | undefined,
  t: TeamTranslator
): OpenCodeRouteGroupInfo {
  const routeKind = catalogModel?.metadata?.opencode?.routeKind;
  if (routeKind === 'configured_local') {
    return { id: 'opencode-config', label: t('modelSelector.routeGroups.openCodeConfig'), rank: 0 };
  }
  if (routeKind === 'builtin_free') {
    return { id: 'builtin-free', label: t('modelSelector.routeGroups.builtinFree'), rank: 1 };
  }
  if (routeKind === 'connected_provider') {
    return {
      id: 'connected-providers',
      label: t('modelSelector.routeGroups.connectedProviders'),
      rank: 2,
    };
  }
  return { id: 'catalog-provider', label: t('modelSelector.routeGroups.otherCatalog'), rank: 3 };
}

function isRecommendedTeamModelRecommendation(
  recommendation: ReturnType<typeof getTeamModelRecommendation>
): boolean {
  return (
    recommendation?.level === 'recommended' || recommendation?.level === 'recommended-with-limits'
  );
}

function buildOpenCodeModelSearchText({
  option,
  sourceInfo,
  routeGroup,
  routeMetadata,
  recommendation,
  pricingInfo,
}: {
  option: TeamRuntimeModelOption;
  sourceInfo: OpenCodeSourceInfo | null;
  routeGroup: OpenCodeRouteGroupInfo;
  routeMetadata: NonNullable<ProviderModelCatalogItem['metadata']>['opencode'] | null;
  recommendation: ReturnType<typeof getTeamModelRecommendation>;
  pricingInfo: OpenCodeModelPricingInfo | null;
}): string {
  return [
    option.value,
    option.label,
    option.badgeLabel ?? '',
    sourceInfo?.label ?? '',
    routeGroup.label,
    routeMetadata?.proofState ?? '',
    routeMetadata?.accessKind ?? '',
    recommendation?.label ?? '',
    recommendation?.reason ?? '',
    pricingInfo?.free ? 'free' : '',
    pricingInfo?.summary ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

function isFreeOpenCodeModelOption({
  option,
  routeMetadata,
  pricingInfo,
}: {
  option: TeamRuntimeModelOption;
  routeMetadata: NonNullable<ProviderModelCatalogItem['metadata']>['opencode'] | null;
  pricingInfo: OpenCodeModelPricingInfo | null;
}): boolean {
  const badgeLabel = option.badgeLabel?.trim().toLowerCase();
  return (
    pricingInfo?.free === true ||
    routeMetadata?.routeKind === 'builtin_free' ||
    badgeLabel === 'free' ||
    isFreeOpenCodeModelRoute(option.value)
  );
}

function getOpenCodeModelGridColumnCount(width: number): number {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  if (safeWidth <= 0) {
    return 1;
  }

  return Math.max(
    1,
    Math.floor((safeWidth + MODEL_GRID_GAP_PX) / (MODEL_GRID_MIN_CARD_WIDTH_PX + MODEL_GRID_GAP_PX))
  );
}

function buildOpenCodeVirtualRows({
  defaultOptions,
  groups,
  columnCount,
}: {
  defaultOptions: TeamRuntimeModelOption[];
  groups: OpenCodeModelGroup[];
  columnCount: number;
}): OpenCodeVirtualRow[] {
  const rows: OpenCodeVirtualRow[] = [];

  if (defaultOptions.length > 0) {
    rows.push({
      kind: 'models',
      key: 'default',
      options: defaultOptions,
      isLastInGroup: true,
    });
  }

  for (const group of groups) {
    rows.push({
      kind: 'heading',
      key: `heading:${group.groupId}`,
      sourceLabel: group.groupLabel,
      count: group.options.length,
    });

    for (let start = 0; start < group.options.length; start += columnCount) {
      rows.push({
        kind: 'models',
        key: `models:${group.groupId}:${start}`,
        options: group.options.slice(start, start + columnCount),
        isLastInGroup: start + columnCount >= group.options.length,
      });
    }
  }

  return rows;
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

function formatOpenCodeCostRate(rate: number, t: TeamTranslator): string {
  if (rate === 0) {
    return t('modelSelector.pricing.free');
  }

  const formatted = rate.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: rate >= 1 ? 2 : 4,
  });
  return `$${formatted}`;
}

function formatOpenCodeCostSummary(
  rates: OpenCodeModelCostRates,
  t: TeamTranslator
): string | null {
  const summaryParts: string[] = [];
  if (rates.input !== null) {
    summaryParts.push(
      t('modelSelector.pricing.inputShort', { rate: formatOpenCodeCostRate(rates.input, t) })
    );
  }
  if (rates.output !== null) {
    summaryParts.push(
      t('modelSelector.pricing.outputShort', { rate: formatOpenCodeCostRate(rates.output, t) })
    );
  }

  if (summaryParts.length === 0) {
    return null;
  }

  return t('modelSelector.pricing.perMillionSummary', { summary: summaryParts.join(' · ') });
}

function formatOpenCodeCostTitle(rates: OpenCodeModelCostRates, t: TeamTranslator): string {
  const titleParts: string[] = [];
  if (rates.input !== null) {
    titleParts.push(
      t('modelSelector.pricing.inputTitle', { rate: formatOpenCodeCostRate(rates.input, t) })
    );
  }
  if (rates.output !== null) {
    titleParts.push(
      t('modelSelector.pricing.outputTitle', { rate: formatOpenCodeCostRate(rates.output, t) })
    );
  }
  if (rates.cacheRead !== null) {
    titleParts.push(
      t('modelSelector.pricing.cacheReadTitle', {
        rate: formatOpenCodeCostRate(rates.cacheRead, t),
      })
    );
  }
  if (rates.cacheWrite !== null) {
    titleParts.push(
      t('modelSelector.pricing.cacheWriteTitle', {
        rate: formatOpenCodeCostRate(rates.cacheWrite, t),
      })
    );
  }
  return titleParts.join('\n');
}

function getOpenCodeModelPricingInfo(
  catalogModel: ProviderModelCatalogItem | null | undefined,
  t: TeamTranslator
): OpenCodeModelPricingInfo | null {
  const metadata = catalogModel?.metadata;
  if (!metadata) {
    return null;
  }

  const rates = extractOpenCodeCostRates(metadata.cost);
  return {
    free: metadata.free === true,
    summary: rates ? formatOpenCodeCostSummary(rates, t) : null,
    title: rates ? formatOpenCodeCostTitle(rates, t) : undefined,
  };
}

function isFreeOpenCodeModelRoute(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized === 'opencode/big-pickle' ||
    normalized.includes(':free') ||
    normalized.endsWith('-free') ||
    normalized.endsWith('/free')
  );
}

function hasFreeOpenCodeModelRoute(providerStatus: CliProviderStatus | null | undefined): boolean {
  if (providerStatus?.providerId !== 'opencode') {
    return false;
  }

  if (providerStatus.models.some(isFreeOpenCodeModelRoute)) {
    return true;
  }

  return (
    providerStatus.modelCatalog?.models.some((model) => {
      const badgeLabel = model.badgeLabel?.trim().toLowerCase();
      return (
        model.metadata?.free === true ||
        badgeLabel === 'free' ||
        isFreeOpenCodeModelRoute(model.launchModel) ||
        isFreeOpenCodeModelRoute(model.id)
      );
    }) ?? false
  );
}

const OPENCODE_UI_DISABLED_REASON = 'OpenCode team launch is not ready.';
export const OPENCODE_ONE_SHOT_DISABLED_REASON =
  'OpenCode team launch is available for normal teams, but scheduled one-shot prompts still run through claude -p. Choose Anthropic or Codex for one-shot schedules.';
export const OPENCODE_ONE_SHOT_DISABLED_BADGE_LABEL = 'team only';

function getOpenCodeReadinessBadgeLabel(
  providerStatus: CliProviderStatus | null | undefined,
  t: TeamTranslator
): string {
  if (!providerStatus) {
    return t('modelSelector.openCodeStatus.badges.check');
  }
  if (!providerStatus.supported) {
    return t('modelSelector.openCodeStatus.badges.install');
  }
  if (!providerStatus.authenticated) {
    return t('modelSelector.openCodeStatus.badges.free');
  }
  return t('modelSelector.openCodeStatus.badges.setup');
}

function getOpenCodeReadinessSummary(
  providerStatus: CliProviderStatus | null | undefined,
  t: TeamTranslator
): string {
  if (!providerStatus) {
    return t('modelSelector.openCodeStatus.summary.checking');
  }

  const runtimeReady = providerStatus.supported;
  const hasFreeModelRoute = hasFreeOpenCodeModelRoute(providerStatus);
  let readinessSummary = t('modelSelector.openCodeStatus.summaryParts.teamLaunchBlocked');
  if (runtimeReady) {
    if (!providerStatus.authenticated) {
      readinessSummary = hasFreeModelRoute
        ? t('modelSelector.openCodeStatus.summaryParts.providerOptional')
        : t('modelSelector.openCodeStatus.summaryParts.providerModelsNeedSetup');
    } else if (providerStatus.capabilities.teamLaunch) {
      readinessSummary = t('modelSelector.openCodeStatus.summaryParts.teamLaunchReady');
    }
  }
  const parts = [
    runtimeReady
      ? t('modelSelector.openCodeStatus.summaryParts.runtimeDetected')
      : t('modelSelector.openCodeStatus.summaryParts.runtimeMissing'),
    runtimeReady && !providerStatus.authenticated && hasFreeModelRoute
      ? t('modelSelector.openCodeStatus.summaryParts.freeWithoutAuth')
      : providerStatus.authenticated
        ? t('modelSelector.openCodeStatus.summaryParts.providerConnected')
        : t('modelSelector.openCodeStatus.summaryParts.providerNotConnected'),
    readinessSummary,
  ];
  return t('modelSelector.openCodeStatus.summary.status', { parts: parts.join(' · ') });
}

function getOpenCodeReadinessMessage(
  providerStatus: CliProviderStatus | null | undefined,
  t: TeamTranslator
): string {
  if (!providerStatus) {
    return t('modelSelector.openCodeStatus.messages.checking');
  }
  if (!providerStatus.supported) {
    return t('modelSelector.openCodeStatus.messages.unsupported');
  }
  if (!providerStatus.authenticated) {
    if (hasFreeOpenCodeModelRoute(providerStatus)) {
      return t('modelSelector.openCodeStatus.messages.freeAvailable');
    }
    return t('modelSelector.openCodeStatus.messages.noFreeListed');
  }
  if (!providerStatus.capabilities.teamLaunch) {
    return t('modelSelector.openCodeStatus.messages.launchBlocked');
  }
  return t('modelSelector.openCodeStatus.messages.ready');
}

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

const OpenCodeVirtualizedModelGrid = ({
  defaultOptions,
  groups,
  renderModelOption,
}: Readonly<{
  defaultOptions: TeamRuntimeModelOption[];
  groups: OpenCodeModelGroup[];
  renderModelOption: RenderModelOption;
}>): React.JSX.Element => {
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);

  useEffect(() => {
    const element = scrollParentRef.current;
    if (!element) {
      return undefined;
    }

    const updateGridWidth = (): void => {
      const nextWidth = element.clientWidth;
      setGridWidth((previousWidth) => (previousWidth === nextWidth ? previousWidth : nextWidth));
    };
    updateGridWidth();

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(updateGridWidth);
      resizeObserver.observe(element);
      return () => resizeObserver.disconnect();
    }

    window.addEventListener('resize', updateGridWidth);
    return () => window.removeEventListener('resize', updateGridWidth);
  }, []);

  const columnCount = useMemo(() => getOpenCodeModelGridColumnCount(gridWidth), [gridWidth]);
  const rows = useMemo(
    () => buildOpenCodeVirtualRows({ defaultOptions, groups, columnCount }),
    [columnCount, defaultOptions, groups]
  );
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual API limitation, not fixable in user code
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: (index) =>
      rows[index]?.kind === 'heading'
        ? OPENCODE_MODEL_GROUP_HEADING_ESTIMATE_PX
        : OPENCODE_MODEL_ROW_ESTIMATE_PX,
    overscan: 6,
  });

  return (
    <div
      ref={scrollParentRef}
      data-testid="team-model-selector-model-grid"
      className="overflow-y-auto rounded-md bg-[var(--color-surface)] pr-1"
      style={{ maxHeight: OPENCODE_MODEL_GRID_MAX_HEIGHT_PX }}
    >
      <div
        className="relative w-full"
        style={{
          height: rowVirtualizer.getTotalSize(),
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) {
            return null;
          }

          return (
            <div
              key={row.key}
              ref={rowVirtualizer.measureElement}
              data-index={virtualRow.index}
              className="absolute left-0 top-0 w-full"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {row.kind === 'heading' ? (
                <div data-testid="team-model-selector-opencode-group" className="pb-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
                      {row.sourceLabel}
                    </h4>
                    <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                      {row.count}
                    </span>
                  </div>
                </div>
              ) : (
                <div
                  className={cn('grid gap-1.5', row.isLastInGroup ? 'pb-3' : 'pb-1.5')}
                  style={{
                    gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                  }}
                >
                  {row.options.map(renderModelOption)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const OpenCodeModelCatalogLoadingSkeleton = (): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div
      data-testid="team-model-selector-opencode-loading-skeleton"
      role="status"
      aria-live="polite"
      className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3"
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-blue-400" />
        <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
          {t('modelSelector.openCode.loadingModels')}
        </span>
      </div>
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
      >
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="min-h-[44px] rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2"
          >
            <div
              className="skeleton-shimmer mx-auto mb-1.5 h-3 rounded-sm"
              style={{
                width: index === 1 ? '64%' : '76%',
                backgroundColor: 'var(--skeleton-base)',
              }}
            />
            <div
              className="skeleton-shimmer mx-auto h-2 rounded-sm"
              style={{
                width: index === 2 ? '44%' : '52%',
                backgroundColor: 'var(--skeleton-base-dim)',
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export interface TeamModelSelectorProps {
  providerId: TeamProviderId;
  onProviderChange: (providerId: TeamProviderId) => void;
  value: string;
  onValueChange: (value: string) => void;
  id?: string;
  disableGeminiOption?: boolean;
  providerNoticeById?: Partial<Record<TeamProviderId, React.ReactNode>>;
  providerDisabledReasonById?: Partial<Record<TeamProviderId, string | null | undefined>>;
  providerDisabledBadgeLabelById?: Partial<Record<TeamProviderId, string | null | undefined>>;
  modelAdvisoryReasonByValue?: Partial<Record<string, string | null | undefined>>;
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
  providerNoticeById,
  providerDisabledReasonById,
  providerDisabledBadgeLabelById,
  modelAdvisoryReasonByValue,
  modelIssueReasonByValue,
  modelUnavailableReasonByValue,
}) => {
  const { t } = useAppTranslation('team');
  const multimodelEnabled = useStore((s) => s.appConfig?.general?.multimodelEnabled ?? true);
  const [recommendedOnly, setRecommendedOnly] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [openCodeSourceFilterOpen, setOpenCodeSourceFilterOpen] = useState(false);
  const [openCodeSourceQuery, setOpenCodeSourceQuery] = useState('');
  const [selectedOpenCodeSourceIds, setSelectedOpenCodeSourceIds] = useState<Set<string>>(
    () => new Set()
  );
  const selectedProviderId =
    disableGeminiOption && isGeminiUiFrozen() && providerId === 'gemini' ? 'anthropic' : providerId;
  const [inspectedProviderId, setInspectedProviderId] = useState<TeamProviderId | null>(null);
  const previousEffectiveProviderIdRef = useRef<TeamProviderId>(selectedProviderId);
  const previousSelectedProviderIdRef = useRef<TeamProviderId>(selectedProviderId);
  const effectiveProviderId = inspectedProviderId ?? selectedProviderId;
  const isInspectingInactiveProvider = inspectedProviderId !== null;
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
      if (isAnthropicCompatibleRuntime(runtimeProviderStatus)) {
        const defaultCompatibleModel =
          runtimeProviderStatus?.modelCatalog?.defaultLaunchModel?.trim() ||
          runtimeProviderStatus?.modelCatalog?.defaultModelId?.trim() ||
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
          runtimeProviderStatus
        ) ?? 'Opus 4.8 (1M)';
      const defaultLimitedContextModel =
        getRuntimeAwareProviderScopedTeamModelLabel(
          'anthropic',
          getAnthropicDefaultTeamModel(true),
          runtimeProviderStatus
        ) ?? 'Opus 4.8';

      return t('modelSelector.defaultTooltip.anthropic', {
        longContextModel: defaultLongContextModel,
        limitedContextModel: defaultLimitedContextModel,
      });
    }
    if (effectiveProviderId === 'opencode') {
      const defaultOpenCodeModel =
        runtimeProviderStatus?.modelCatalog?.defaultLaunchModel ??
        runtimeProviderStatus?.modelCatalog?.defaultModelId ??
        null;
      return defaultOpenCodeModel
        ? t('modelSelector.defaultTooltip.openCodeWithResolved', { model: defaultOpenCodeModel })
        : t('modelSelector.defaultTooltip.openCode');
    }
    return t('modelSelector.defaultTooltip.runtime');
  }, [effectiveProviderId, runtimeProviderStatus, t]);
  const getProviderOverrideDisabledReason = (candidateProviderId: string): string | null => {
    if (!isTeamProviderId(candidateProviderId)) {
      return null;
    }

    return providerDisabledReasonById?.[candidateProviderId]?.trim() || null;
  };
  const getProviderDisabledReason = (candidateProviderId: string): string | null => {
    const overrideReason = getProviderOverrideDisabledReason(candidateProviderId);
    if (overrideReason) {
      return overrideReason;
    }

    if (candidateProviderId === 'opencode') {
      const providerStatus = runtimeProviderStatusById.get('opencode') ?? null;
      if (!providerStatus) {
        return t('modelSelector.openCodeStatus.loadingRuntime');
      }
      if (!providerStatus.supported) {
        return (
          providerStatus.detailMessage ??
          providerStatus.statusMessage ??
          'OpenCode runtime is not installed.'
        );
      }
      if (providerStatus.authenticated && !providerStatus.capabilities.teamLaunch) {
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
  const isProviderInspectable = (candidateProviderId: string): boolean =>
    candidateProviderId === 'opencode' &&
    getProviderOverrideDisabledReason(candidateProviderId) === null &&
    getProviderDisabledReason(candidateProviderId) !== null &&
    multimodelAvailable;
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
      return getProviderDisabledReason(candidateProviderId)
        ? getOpenCodeReadinessBadgeLabel(runtimeProviderStatusById.get('opencode'), t)
        : null;
    }

    const providerDisabledReason = getProviderDisabledReason(candidateProviderId);
    if (providerDisabledReason) {
      return GEMINI_UI_DISABLED_BADGE_LABEL;
    }

    if (!isProviderSelectable(candidateProviderId)) {
      return t('modelSelector.multimodelOff');
    }

    return null;
  };
  const getProviderStatusBadgeLabel = (statusBadge: string | null): string | null => {
    if (statusBadge === t('modelSelector.multimodelOff')) {
      return t('modelSelector.fastMode.off');
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
    if (isInspectingInactiveProvider) {
      return;
    }
    if (normalizedValue !== value) {
      onValueChange(normalizedValue);
    }
  }, [isInspectingInactiveProvider, normalizedValue, onValueChange, value]);

  const modelOptions = useMemo(() => {
    if (shouldAwaitRuntimeModelList) {
      return [
        {
          value: '',
          label: t('modelSelector.defaultModel'),
          badgeLabel: t('modelSelector.defaultModel'),
        },
      ];
    }
    return getAvailableTeamProviderModelOptions(effectiveProviderId, runtimeProviderStatus);
  }, [effectiveProviderId, runtimeProviderStatus, shouldAwaitRuntimeModelList, t]);
  const showAnthropicCompatibleCustomModelInput =
    effectiveProviderId === 'anthropic' &&
    canUseCustomAnthropicCompatibleModel(runtimeProviderStatus);
  const selectedModelMatchesOption = modelOptions.some(
    (option) => option.value === normalizedValue
  );
  const anthropicCompatibleCustomModelValue =
    showAnthropicCompatibleCustomModelInput && normalizedValue && !selectedModelMatchesOption
      ? normalizedValue
      : '';
  const anthropicCompatibleCatalogWarning =
    showAnthropicCompatibleCustomModelInput &&
    runtimeProviderStatus?.modelCatalog?.providerId === 'anthropic'
      ? (runtimeProviderStatus.modelCatalog.diagnostics.message ??
        runtimeProviderStatus.modelCatalog.diagnostics.code ??
        null)
      : null;
  const openCodeCatalogModelById = useMemo(() => {
    const catalog = runtimeProviderStatus?.modelCatalog;
    const modelById = new Map<string, ProviderModelCatalogItem>();
    if (effectiveProviderId !== 'opencode' || catalog?.providerId !== 'opencode') {
      return modelById;
    }

    for (const model of catalog.models) {
      const launchModel = model.launchModel.trim();
      const catalogModelId = model.id.trim();
      if (launchModel) {
        modelById.set(launchModel, model);
      }
      if (catalogModelId) {
        modelById.set(catalogModelId, model);
      }
    }

    return modelById;
  }, [effectiveProviderId, runtimeProviderStatus?.modelCatalog]);
  const openCodeModelMetadata = useMemo<OpenCodeModelOptionMetadata[]>(() => {
    if (effectiveProviderId !== 'opencode') {
      return [];
    }

    return modelOptions.map((option, index) => {
      const sourceInfo = getOpenCodeSourceInfo(option.value);
      const recommendation = getTeamModelRecommendation(effectiveProviderId, option.value);
      const catalogModel = openCodeCatalogModelById.get(option.value);
      const pricingInfo = getOpenCodeModelPricingInfo(catalogModel, t);
      const routeGroup = getOpenCodeRouteGroup(catalogModel, t);
      const routeMetadata = catalogModel?.metadata?.opencode ?? null;

      return {
        option,
        index,
        sourceInfo,
        routeGroup,
        routeMetadata,
        recommendation,
        pricingInfo,
        searchText: buildOpenCodeModelSearchText({
          option,
          sourceInfo,
          routeGroup,
          routeMetadata,
          recommendation,
          pricingInfo,
        }),
        isRecommended: isRecommendedTeamModelRecommendation(recommendation),
        isFree: isFreeOpenCodeModelOption({ option, routeMetadata, pricingInfo }),
      };
    });
  }, [effectiveProviderId, modelOptions, openCodeCatalogModelById, t]);
  const openCodeModelMetadataByValue = useMemo(
    () => new Map(openCodeModelMetadata.map((metadata) => [metadata.option.value, metadata])),
    [openCodeModelMetadata]
  );
  const hasRecommendedOpenCodeModels = useMemo(
    () => openCodeModelMetadata.some((metadata) => metadata.isRecommended),
    [openCodeModelMetadata]
  );
  const hasFreeOpenCodeModels = useMemo(
    () => openCodeModelMetadata.some((metadata) => metadata.isFree),
    [openCodeModelMetadata]
  );

  useEffect(() => {
    if (previousSelectedProviderIdRef.current === selectedProviderId) {
      return;
    }
    previousSelectedProviderIdRef.current = selectedProviderId;
    setInspectedProviderId(null);
  }, [selectedProviderId]);

  useEffect(() => {
    if (recommendedOnly && (effectiveProviderId !== 'opencode' || !hasRecommendedOpenCodeModels)) {
      setRecommendedOnly(false);
    }
  }, [effectiveProviderId, hasRecommendedOpenCodeModels, recommendedOnly]);

  useEffect(() => {
    if (freeOnly && (effectiveProviderId !== 'opencode' || !hasFreeOpenCodeModels)) {
      setFreeOnly(false);
    }
  }, [effectiveProviderId, freeOnly, hasFreeOpenCodeModels]);

  useEffect(() => {
    if (previousEffectiveProviderIdRef.current === effectiveProviderId) {
      return;
    }
    previousEffectiveProviderIdRef.current = effectiveProviderId;
    setModelQuery('');
  }, [effectiveProviderId]);

  useEffect(() => {
    if (effectiveProviderId === 'opencode') {
      return;
    }
    if (selectedOpenCodeSourceIds.size === 0 && !openCodeSourceFilterOpen) {
      return;
    }
    setSelectedOpenCodeSourceIds(new Set());
    setOpenCodeSourceFilterOpen(false);
  }, [effectiveProviderId, openCodeSourceFilterOpen, selectedOpenCodeSourceIds]);

  useEffect(() => {
    if (!openCodeSourceFilterOpen && openCodeSourceQuery) {
      setOpenCodeSourceQuery('');
    }
  }, [openCodeSourceFilterOpen, openCodeSourceQuery]);

  const openCodeSourceOptions = useMemo<OpenCodeSourceOption[]>(() => {
    if (effectiveProviderId !== 'opencode') {
      return [];
    }

    const sourceOptions = new Map<string, OpenCodeSourceOption>();
    for (const metadata of openCodeModelMetadata) {
      const option = metadata.option;
      if (!option.value.trim()) {
        continue;
      }
      if (recommendedOnly && !metadata.isRecommended) {
        continue;
      }
      if (freeOnly && !metadata.isFree) {
        continue;
      }

      const sourceInfo = metadata.sourceInfo;
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
  }, [effectiveProviderId, freeOnly, openCodeModelMetadata, recommendedOnly]);

  useEffect(() => {
    if (selectedOpenCodeSourceIds.size === 0) {
      return;
    }

    const availableSourceIds = new Set(openCodeSourceOptions.map((source) => source.id));
    const nextSelectedSourceIds = new Set(
      Array.from(selectedOpenCodeSourceIds).filter((sourceId) => availableSourceIds.has(sourceId))
    );
    if (nextSelectedSourceIds.size !== selectedOpenCodeSourceIds.size) {
      setSelectedOpenCodeSourceIds(nextSelectedSourceIds);
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
      ? t('modelSelector.openCode.allSources')
      : selectedOpenCodeSourceLabels.length === 1
        ? selectedOpenCodeSourceLabels[0]
        : t('modelSelector.openCode.sourcesCount', {
            count: selectedOpenCodeSourceLabels.length,
          });

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

  const visibleOpenCodeModelMetadata = useMemo(() => {
    if (effectiveProviderId !== 'opencode') {
      return [];
    }

    const normalizedModelQuery = modelQuery.trim().toLowerCase();
    const matchesModelQuery = (metadata: OpenCodeModelOptionMetadata): boolean =>
      !normalizedModelQuery || metadata.searchText.includes(normalizedModelQuery);

    const concreteOptions = openCodeModelMetadata
      .filter((metadata) => metadata.option.value.trim().length > 0)
      .filter((metadata) => !recommendedOnly || metadata.isRecommended)
      .filter((metadata) => !freeOnly || metadata.isFree)
      .filter((metadata) => {
        if (selectedOpenCodeSourceIds.size === 0) {
          return true;
        }
        return Boolean(
          metadata.sourceInfo && selectedOpenCodeSourceIds.has(metadata.sourceInfo.id)
        );
      })
      .filter(matchesModelQuery)
      .sort((left, right) => {
        const recommendationOrder = compareTeamModelRecommendations(
          effectiveProviderId,
          left.option.value,
          right.option.value
        );
        return recommendationOrder || left.index - right.index;
      });

    if (recommendedOnly || freeOnly) {
      return concreteOptions;
    }

    return [
      ...openCodeModelMetadata
        .filter((metadata) => metadata.option.value.trim().length === 0)
        .filter(matchesModelQuery),
      ...concreteOptions,
    ];
  }, [
    effectiveProviderId,
    freeOnly,
    modelQuery,
    openCodeModelMetadata,
    recommendedOnly,
    selectedOpenCodeSourceIds,
  ]);

  const visibleModelOptions = useMemo(() => {
    const normalizedModelQuery = modelQuery.trim().toLowerCase();
    const matchesModelQuery = (option: (typeof modelOptions)[number]): boolean => {
      if (!normalizedModelQuery) {
        return true;
      }
      const modelRecommendation =
        effectiveProviderId === 'opencode'
          ? getTeamModelRecommendation(effectiveProviderId, option.value)
          : null;
      return [
        option.value,
        option.label,
        option.badgeLabel ?? '',
        modelRecommendation?.label ?? '',
        modelRecommendation?.reason ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedModelQuery);
    };

    if (effectiveProviderId !== 'opencode') {
      return modelOptions.filter(matchesModelQuery);
    }

    return visibleOpenCodeModelMetadata.map((metadata) => metadata.option);
  }, [effectiveProviderId, modelOptions, modelQuery, visibleOpenCodeModelMetadata]);
  const visibleOpenCodeModelGroups = useMemo<OpenCodeModelGroup[]>(() => {
    if (effectiveProviderId !== 'opencode') {
      return [];
    }

    const groups = new Map<string, OpenCodeModelGroup>();
    for (const metadata of visibleOpenCodeModelMetadata) {
      const option = metadata.option;
      if (!option.value.trim()) {
        continue;
      }

      const sourceGroup = metadata.sourceInfo;
      const groupId = sourceGroup ? `source:${sourceGroup.id}` : `route:${metadata.routeGroup.id}`;
      const groupLabel = sourceGroup?.label ?? metadata.routeGroup.label;
      const existingGroup = groups.get(groupId);
      if (existingGroup) {
        existingGroup.options.push(option);
        existingGroup.rank = Math.min(existingGroup.rank, metadata.routeGroup.rank);
        existingGroup.firstIndex = Math.min(existingGroup.firstIndex, metadata.index);
      } else {
        groups.set(groupId, {
          groupId,
          groupLabel,
          rank: metadata.routeGroup.rank,
          sortLabel: groupLabel.toLowerCase(),
          firstIndex: metadata.index,
          options: [option],
        });
      }
    }

    return Array.from(groups.values()).sort(
      (left, right) =>
        left.rank - right.rank ||
        left.sortLabel.localeCompare(right.sortLabel, undefined, { sensitivity: 'base' }) ||
        left.firstIndex - right.firstIndex
    );
  }, [effectiveProviderId, visibleOpenCodeModelMetadata]);
  const visibleDefaultModelOptions = visibleModelOptions.filter((option) => !option.value.trim());
  const visibleConcreteModelOptionCount =
    visibleModelOptions.length - visibleDefaultModelOptions.length;
  const concreteModelOptionCount = modelOptions.filter((option) => option.value.trim()).length;
  const shouldShowOpenCodeCatalogLoading = isOpenCodeCatalogHydrating(runtimeProviderStatus);
  const shouldShowModelSearch = !shouldShowOpenCodeCatalogLoading && concreteModelOptionCount > 8;
  const trimmedModelQuery = modelQuery.trim();
  const shouldConstrainModelListHeight = visibleModelOptions.length > 8;
  const shouldVirtualizeOpenCodeModels =
    effectiveProviderId === 'opencode' &&
    !shouldShowOpenCodeCatalogLoading &&
    visibleConcreteModelOptionCount > OPENCODE_MODEL_VIRTUALIZATION_THRESHOLD;
  const emptyModelListMessage = trimmedModelQuery
    ? t('modelSelector.empty.noSearchMatches')
    : effectiveProviderId === 'opencode' && recommendedOnly && freeOnly
      ? t('modelSelector.empty.recommendedFreeOpenCode')
      : effectiveProviderId === 'opencode' && freeOnly
        ? t('modelSelector.empty.freeOpenCode')
        : effectiveProviderId === 'opencode' && recommendedOnly
          ? t('modelSelector.empty.recommendedOpenCode')
          : t('modelSelector.empty.noModels');
  const activeProviderDisabledReason = activeProviderSelectable
    ? null
    : getProviderDisabledReason(effectiveProviderId);
  const canActivateInspectedOpenCode =
    effectiveProviderId === 'opencode' && isInspectingInactiveProvider && activeProviderSelectable;
  const activeProviderStatusPanel =
    activeProviderDisabledReason && effectiveProviderId === 'opencode'
      ? {
          tone: 'warning' as const,
          title: t('modelSelector.openCodeStatus.notReadyTitle'),
          summary: getOpenCodeReadinessSummary(runtimeProviderStatus, t),
          message: getOpenCodeReadinessMessage(runtimeProviderStatus, t),
          reason: activeProviderDisabledReason,
          actionLabel: null,
        }
      : effectiveProviderId === 'opencode' &&
          runtimeProviderStatus?.supported === true &&
          runtimeProviderStatus.authenticated === false
        ? {
            tone: 'warning' as const,
            title: hasFreeOpenCodeModelRoute(runtimeProviderStatus)
              ? t('modelSelector.openCodeStatus.freeModelsAvailableTitle')
              : t('modelSelector.openCodeStatus.providerNotConnectedTitle'),
            summary: getOpenCodeReadinessSummary(runtimeProviderStatus, t),
            message: getOpenCodeReadinessMessage(runtimeProviderStatus, t),
            reason: null,
            actionLabel: null,
          }
        : canActivateInspectedOpenCode
          ? {
              tone: 'ready' as const,
              title: t('modelSelector.openCodeStatus.readyTitle'),
              summary: getOpenCodeReadinessSummary(runtimeProviderStatus, t),
              message: t('modelSelector.openCodeStatus.readyMessage'),
              reason: null,
              actionLabel: t('modelSelector.openCodeStatus.useOpenCode'),
            }
          : null;
  const activeProviderNotice = providerNoticeById?.[effectiveProviderId] ?? null;
  const getModelAdvisoryBadgeLabel = (reason: string | null): string =>
    reason?.toLowerCase().includes('ping not confirmed')
      ? t('modelSelector.advisory.pingNotConfirmed')
      : t('modelSelector.advisory.note');
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
        ? (availabilityReason ?? t('modelSelector.unavailableInRuntime'))
        : null;
    const modelAdvisoryReason =
      opt.value === '' ? null : (modelAdvisoryReasonByValue?.[opt.value] ?? null);
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
    const hasBlockingModelIssue = Boolean(modelIssueReason || modelUnavailableReason);
    const hasModelAdvisory = Boolean(modelAdvisoryReason) && !hasBlockingModelIssue;
    const modelSelectable =
      !isInspectingInactiveProvider &&
      activeProviderSelectable &&
      !modelUnavailableReason &&
      !modelDisabledReason &&
      (opt.value === '' || availabilityStatus == null || availabilityStatus === 'available');
    const modelStatusMessage =
      modelUnavailableReason ??
      modelIssueReason ??
      modelAdvisoryReason ??
      modelDisabledReason ??
      availabilityReason ??
      null;
    const openCodeMetadata =
      effectiveProviderId === 'opencode' ? openCodeModelMetadataByValue.get(opt.value) : null;
    let modelRecommendation: ReturnType<typeof getTeamModelRecommendation> = null;
    if (effectiveProviderId === 'opencode') {
      modelRecommendation =
        openCodeMetadata?.recommendation ??
        getTeamModelRecommendation(effectiveProviderId, opt.value);
    }
    const openCodePricingInfo =
      effectiveProviderId === 'opencode' ? (openCodeMetadata?.pricingInfo ?? null) : null;
    const openCodeRouteMetadata =
      effectiveProviderId === 'opencode' ? (openCodeMetadata?.routeMetadata ?? null) : null;
    const openCodeRouteKind = openCodeRouteMetadata?.routeKind ?? null;
    const openCodeProofState = openCodeRouteMetadata?.proofState ?? null;
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
          hasBlockingModelIssue && normalizedValue === opt.value
            ? 'border-red-500/60 bg-red-500/10 text-red-100 shadow-sm'
            : hasBlockingModelIssue
              ? 'border-red-500/40 bg-red-500/5 text-red-200 hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-100'
              : hasModelAdvisory && normalizedValue === opt.value
                ? 'border-amber-300/55 bg-amber-300/10 text-amber-100 shadow-sm'
                : hasModelAdvisory
                  ? 'border-amber-300/35 bg-amber-300/5 text-amber-200 hover:border-amber-300/55 hover:bg-amber-300/10 hover:text-amber-100'
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
          {openCodePricingInfo?.free || openCodeRouteKind === 'builtin_free' ? (
            <span
              data-testid="team-model-selector-model-free-badge"
              className="inline-flex items-center justify-center rounded-full border border-emerald-300/30 bg-emerald-300/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-emerald-200"
              title={t('modelSelector.openCode.freeTooltip')}
            >
              {t('modelSelector.badges.free')}
            </span>
          ) : null}
          {openCodeRouteKind === 'configured_local' ? (
            <span className="inline-flex items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-300/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-cyan-200">
              {t('modelSelector.badges.local')}
            </span>
          ) : null}
          {openCodeRouteKind === 'configured_local' ? (
            <span className="inline-flex items-center justify-center rounded-full border border-sky-300/30 bg-sky-300/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-sky-200">
              {t('modelSelector.badges.configured')}
            </span>
          ) : null}
          {openCodeRouteKind === 'connected_provider' ? (
            <span className="inline-flex items-center justify-center rounded-full border border-emerald-300/30 bg-emerald-300/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-emerald-100">
              {t('modelSelector.badges.connected')}
            </span>
          ) : null}
          {openCodeProofState === 'verified' ? (
            <span className="inline-flex items-center justify-center rounded-full border border-emerald-300/30 bg-emerald-300/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-emerald-100">
              {t('modelSelector.badges.verified')}
            </span>
          ) : null}
          {openCodeProofState === 'needs_probe' ? (
            <span className="inline-flex items-center justify-center rounded-full border border-amber-300/30 bg-amber-300/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-amber-200">
              {t('modelSelector.badges.needsTest')}
            </span>
          ) : null}
          {openCodeProofState === 'failed' ? (
            <span className="inline-flex items-center justify-center rounded-full border border-red-300/30 bg-red-400/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-red-200">
              {t('modelSelector.badges.failed')}
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
          {hasBlockingModelIssue ? (
            <span
              className="flex items-center justify-center gap-1 text-[10px] font-normal text-red-300"
              title={modelStatusMessage ?? undefined}
            >
              <AlertTriangle className="size-3 shrink-0" />
              <span>
                {modelUnavailableReason
                  ? t('modelSelector.badges.unavailable')
                  : t('modelSelector.badges.issue')}
              </span>
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
          ) : null}
          {hasModelAdvisory ? (
            <span
              className="flex items-center justify-center gap-1 text-[10px] font-normal text-amber-200"
              title={modelStatusMessage ?? undefined}
            >
              <Info className="size-3 shrink-0" />
              <span>{getModelAdvisoryBadgeLabel(modelAdvisoryReason ?? null)}</span>
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
          ) : null}
          {!hasBlockingModelIssue && !hasModelAdvisory && modelDisabledReason && (
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
        {t('modelSelector.label')}
      </Label>
      <Tabs
        value={effectiveProviderId}
        onValueChange={(nextValue) => {
          if (!isTeamProviderId(nextValue)) {
            return;
          }
          if (isInspectingInactiveProvider && nextValue === selectedProviderId) {
            setInspectedProviderId(null);
            return;
          }
          if (isProviderSelectable(nextValue)) {
            setInspectedProviderId(null);
            onProviderChange(nextValue);
            return;
          }
          if (isProviderInspectable(nextValue)) {
            setInspectedProviderId(nextValue);
          }
        }}
      >
        <div className="space-y-0">
          <div className="-mb-px border-b border-[var(--color-border-subtle)]">
            <TabsList className="h-auto w-full flex-wrap justify-start gap-1 rounded-none bg-transparent p-0">
              {PROVIDERS.map((provider) => {
                const providerDisabledReason = getProviderDisabledReason(provider.id);
                const providerSelectable = isProviderSelectable(provider.id);
                const providerInspectable = isProviderInspectable(provider.id);
                const statusBadge = getProviderStatusBadge(provider.id);
                const statusBadgeLabel = getProviderStatusBadgeLabel(statusBadge);

                return (
                  <TabsTrigger
                    key={provider.id}
                    value={provider.id}
                    disabled={provider.comingSoon || (!providerSelectable && !providerInspectable)}
                    aria-disabled={!providerSelectable || undefined}
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
                  {t('modelSelector.multimodelRequired')}
                </p>
              </div>
            ) : null}

            <div className="p-3">
              {activeProviderNotice ? (
                <div data-testid="team-model-selector-provider-notice" className="mb-3">
                  {activeProviderNotice}
                </div>
              ) : null}
              {activeProviderStatusPanel ? (
                <div
                  data-testid="team-model-selector-provider-status"
                  className={cn(
                    'mb-3 rounded-md border px-3 py-2 text-[11px] leading-relaxed',
                    activeProviderStatusPanel.tone === 'ready'
                      ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-100'
                      : 'border-amber-300/30 bg-amber-300/10 text-amber-100'
                  )}
                >
                  <div className="flex items-start gap-2">
                    {activeProviderStatusPanel.tone === 'ready' ? (
                      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-200" />
                    ) : (
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-200" />
                    )}
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">{activeProviderStatusPanel.title}</p>
                      <p className="opacity-90">{activeProviderStatusPanel.summary}</p>
                      <p>{activeProviderStatusPanel.message}</p>
                      {activeProviderStatusPanel.reason ? (
                        <p className="opacity-90">
                          {t('modelSelector.reason', {
                            reason: activeProviderStatusPanel.reason,
                          })}
                        </p>
                      ) : null}
                      {activeProviderStatusPanel.actionLabel ? (
                        <button
                          type="button"
                          className="mt-1 inline-flex h-7 items-center rounded-md border border-emerald-300/35 bg-emerald-300/10 px-2.5 text-[11px] font-medium text-emerald-100 transition-colors hover:border-emerald-200/50 hover:bg-emerald-300/15"
                          onClick={() => {
                            setInspectedProviderId(null);
                            onProviderChange('opencode');
                          }}
                        >
                          {activeProviderStatusPanel.actionLabel}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
              {shouldAwaitRuntimeModelList ? (
                <p className="mb-2 text-[11px] text-[var(--color-text-muted)]">
                  {t('modelSelector.runtimeModelsSyncing')}
                </p>
              ) : null}
              {showAnthropicCompatibleCustomModelInput ? (
                <div className="mb-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2">
                  <Label
                    htmlFor="anthropic-compatible-custom-model"
                    className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]"
                  >
                    {t('modelSelector.customModelId')}
                  </Label>
                  <Input
                    id="anthropic-compatible-custom-model"
                    data-testid="team-model-selector-anthropic-compatible-custom-model"
                    value={anthropicCompatibleCustomModelValue}
                    onChange={(event) => onValueChange(event.currentTarget.value.trim())}
                    placeholder={t('modelSelector.placeholders.customModelId')}
                    className="h-8 text-xs"
                    disabled={isInspectingInactiveProvider || !activeProviderSelectable}
                  />
                  {anthropicCompatibleCatalogWarning ? (
                    <p className="mt-1.5 text-[10px] leading-relaxed text-amber-200">
                      {anthropicCompatibleCatalogWarning}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {shouldShowModelSearch ? (
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
                  <Input
                    data-testid="team-model-selector-model-search"
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                    placeholder={t('modelSelector.searchModels')}
                    aria-label={t('modelSelector.searchModels')}
                    className="h-9 pr-3 text-sm"
                    style={{ paddingLeft: 40 }}
                  />
                </div>
              ) : null}
              {!shouldShowOpenCodeCatalogLoading &&
              ((effectiveProviderId === 'opencode' && openCodeSourceOptions.length > 1) ||
                hasRecommendedOpenCodeModels ||
                hasFreeOpenCodeModels) ? (
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
                          aria-label={t('modelSelector.openCode.filterSources')}
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
                              placeholder={t('modelSelector.openCode.searchSources')}
                              className="flex h-8 w-full border-0 bg-transparent px-2 py-1 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
                            />
                          </div>
                          <CommandPrimitive.List className="max-h-72 overflow-y-auto overscroll-contain p-1">
                            <CommandPrimitive.Empty className="py-4 text-center text-xs text-[var(--color-text-muted)]">
                              {t('modelSelector.openCode.noSourcesFound')}
                            </CommandPrimitive.Empty>
                            {selectedOpenCodeSourceIds.size > 0 && !openCodeSourceQuery.trim() ? (
                              <CommandPrimitive.Item
                                value="__all_opencode_sources__"
                                onSelect={() => setSelectedOpenCodeSourceIds(new Set())}
                                className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-[var(--color-text-muted)] outline-none data-[selected=true]:bg-[var(--color-surface-raised)] data-[selected=true]:text-[var(--color-text)]"
                              >
                                <Check className="size-3.5 shrink-0 opacity-70" />
                                {t('modelSelector.openCode.allSources')}
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
                                    aria-label={t('modelSelector.openCode.filterSource', {
                                      source: source.label,
                                    })}
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
                        {t('modelSelector.openCode.recommendedOnly')}
                      </Label>
                    </div>
                  ) : null}
                  {hasFreeOpenCodeModels ? (
                    <div className="flex w-fit items-center gap-2">
                      <Checkbox
                        id="opencode-team-model-free-only"
                        checked={freeOnly}
                        onCheckedChange={(checked) => setFreeOnly(checked === true)}
                        className="size-3.5"
                      />
                      <Label
                        htmlFor="opencode-team-model-free-only"
                        className="cursor-pointer text-[11px] font-normal text-[var(--color-text-secondary)]"
                      >
                        {t('modelSelector.openCode.freeOnly')}
                      </Label>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {effectiveProviderId === 'opencode' ? (
                shouldShowOpenCodeCatalogLoading ? (
                  <div
                    data-testid="team-model-selector-model-grid"
                    className="space-y-3 rounded-md bg-[var(--color-surface)]"
                  >
                    {visibleDefaultModelOptions.length > 0 ? (
                      <div
                        className="grid gap-1.5"
                        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
                      >
                        {visibleDefaultModelOptions.map(renderModelOption)}
                      </div>
                    ) : null}
                    <OpenCodeModelCatalogLoadingSkeleton />
                  </div>
                ) : shouldVirtualizeOpenCodeModels ? (
                  <OpenCodeVirtualizedModelGrid
                    defaultOptions={visibleDefaultModelOptions}
                    groups={visibleOpenCodeModelGroups}
                    renderModelOption={renderModelOption}
                  />
                ) : (
                  <div
                    data-testid="team-model-selector-model-grid"
                    className={cn(
                      'space-y-3 rounded-md bg-[var(--color-surface)]',
                      shouldConstrainModelListHeight && 'overflow-y-auto pr-1'
                    )}
                    style={{
                      maxHeight: shouldConstrainModelListHeight
                        ? OPENCODE_MODEL_GRID_MAX_HEIGHT_PX
                        : undefined,
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
                      <section key={group.groupId} data-testid="team-model-selector-opencode-group">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <h4 className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
                            {group.groupLabel}
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
                )
              ) : (
                <div
                  data-testid="team-model-selector-model-grid"
                  className={cn(
                    'grid gap-1.5 rounded-md bg-[var(--color-surface)]',
                    shouldConstrainModelListHeight && 'overflow-y-auto pr-1'
                  )}
                  style={{
                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                    maxHeight: shouldConstrainModelListHeight
                      ? OPENCODE_MODEL_GRID_MAX_HEIGHT_PX
                      : undefined,
                  }}
                >
                  {visibleModelOptions.map(renderModelOption)}
                </div>
              )}
              {visibleModelOptions.length === 0 && !shouldShowOpenCodeCatalogLoading ? (
                <div className="rounded-md border border-white/10 px-3 py-2 text-xs text-[var(--color-text-muted)]">
                  {emptyModelListMessage}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </Tabs>
    </div>
  );
};

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  CodexRuntimeUpdateDialog,
  CodexRuntimeUpdateNotice,
} from '@features/codex-runtime-installer/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import {
  isPrivateNetworkRuntimeLocalProviderUrl,
  type OpenCodeLocalModelSetupTarget,
  ProviderBrandIcon,
  resolveOpenCodeCatalogSourceProviderId,
  resolveOpenCodeSelectionScopeDecision,
  useOpenCodeLocalModelSetup,
  useOpenCodeLocalProviders,
  useOpenCodeProviderModelCatalog,
  useRuntimeProviderDirectoryCacheWithGlobalFallback,
} from '@features/runtime-provider-management/renderer';
import { ProviderActivityStatusStrip } from '@renderer/components/common/ProviderActivityStatusStrip';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { isOpenCodeCatalogHydrating } from '@renderer/components/runtime/providerConnectionUi';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { shouldHydrateCodexModelCatalog } from '@renderer/utils/codexCatalogHydration';
import { isCodexModelCatalogFallbackActive } from '@renderer/utils/codexModelCatalogFallback';
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
  getRuntimeAwareProviderScopedTeamModelLabel,
  getTeamModelSourceBadgeLabel,
} from '@renderer/utils/teamModelCatalog';
import {
  compareTeamModelRecommendations,
  getTeamModelRecommendation,
} from '@renderer/utils/teamModelRecommendations';
import { getAnthropicDefaultTeamModel } from '@shared/utils/anthropicModelDefaults';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import {
  getOpenCodeModelRoutePresentationStatus,
  isOpenCodeLocalProviderId,
  isOpenCodeModelExplicitlyFree,
  type OpenCodeModelRoutePresentationStatus,
} from '@shared/utils/opencodeModelRoute';
import { isTeamProviderId } from '@shared/utils/teamProvider';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { Command as CommandPrimitive } from 'cmdk';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Filter,
  Info,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  Star,
  X,
} from 'lucide-react';

import { CodexModelCatalogFallbackNotice } from './CodexModelCatalogFallbackNotice';
import {
  buildOpenCodeLocalModelOverlay,
  resolveOpenCodeLocalModelPresentation,
} from './openCodeLocalModelOverlay';
import { OpenCodeLocalModelPrivateNetworkApprovalDialog } from './OpenCodeLocalModelPrivateNetworkApprovalDialog';
import {
  OpenCodeLocalModelsLookupError,
  OpenCodeLocalModelsTabStatus,
} from './OpenCodeLocalModelsFeedback';
import { OpenCodeLocalModelStatus } from './OpenCodeLocalModelStatus';
import {
  canUseCachedOpenCodeModelsDuringTransientCheck,
  getOpenCodeReadinessBadgeLabel,
  getOpenCodeReadinessMessage,
  getOpenCodeReadinessSummary,
  getOpenCodeRuntimeStatusUiState,
  hasFreeOpenCodeModelRoute,
  shouldShowOpenCodeRuntimeLoading,
} from './openCodeRuntimeStatusUi';
import { compareModelFreshness, isRecentlyReleasedModel } from './teamModelFreshness';
import {
  getActiveOpenCodeStickyHeadingIndex,
  getOpenCodeModelGridColumnCount,
  resolveTeamModelSelectorValue,
  shouldElevateOpenCodeVirtualRow,
  shouldShowOpenCodeNeedsTestBadge,
  shouldShowOpenCodeOverviewStatus,
} from './teamModelSelectorUi';
export {
  computeEffectiveTeamModel,
  formatTeamModelSummary,
  getTeamEffortLabel,
  getTeamModelLabel,
  getTeamProviderLabel,
} from './teamModelSummary';

import type { CliProviderStatus, TeamProviderId } from '@shared/types';

export { getProviderScopedTeamModelLabel } from '@renderer/utils/teamModelCatalog';

interface ProviderDef {
  id: TeamProviderId;
  label: string;
  comingSoon: boolean;
}
interface OpenCodeProviderTabDef {
  id: string;
  label: string;
  sourceId: string;
  connected: boolean;
  directoryModelCount?: number | null;
}
interface OpenCodeProviderLoadingRowDef {
  label: string;
  sourceId: string;
  status: 'connected' | 'checking';
}
interface OpenCodeSourceOption {
  id: string;
  label: string;
  count: number;
}
interface OpenCodeRouteTagOption {
  id: OpenCodeRouteFilterTag;
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
  sourceInfo: OpenCodeSourceInfo | null;
  status: OpenCodeModelGroupStatus;
  allModelsFree: boolean;
  rank: number;
  sortLabel: string;
  firstIndex: number;
  options: TeamRuntimeModelOption[];
}

type OpenCodeModelGroupStatus = OpenCodeModelRoutePresentationStatus;
type OpenCodeRouteFilterTag = 'connected' | 'configured' | 'local';

interface OpenCodeModelOptionMetadata {
  option: TeamRuntimeModelOption;
  index: number;
  catalogModel: ProviderModelCatalogItem | null;
  sourceInfo: OpenCodeSourceInfo | null;
  routeGroup: OpenCodeRouteGroupInfo;
  routeMetadata: NonNullable<ProviderModelCatalogItem['metadata']>['opencode'] | null;
  routeTag: OpenCodeRouteFilterTag | null;
  recommendation: ReturnType<typeof getTeamModelRecommendation>;
  pricingInfo: OpenCodeModelPricingInfo | null;
  searchText: string;
  isRecommended: boolean;
  isFree: boolean;
  isNew: boolean;
}

interface OpenCodeVirtualHeadingRow {
  kind: 'heading';
  key: string;
  group: OpenCodeModelGroup;
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

const MODEL_GRID_RESPONSIVE_HEIGHT_CLASS = 'h-[clamp(320px,calc(100vh-300px),520px)]';
const OPENCODE_MODEL_VIRTUALIZATION_THRESHOLD = 80;
const OPENCODE_MODEL_GROUP_HEADING_ESTIMATE_PX = 38;
const OPENCODE_MODEL_ROW_ESTIMATE_PX = 74;
const OPENCODE_LOCAL_MODELS_TAB_ID = 'opencode-local-models';
const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', label: 'Anthropic', comingSoon: false },
  { id: 'codex', label: 'Codex', comingSoon: false },
  { id: 'opencode', label: 'OpenCode', comingSoon: false },
];

const CURATED_OPENCODE_PROVIDER_TABS = [
  { sourceId: 'cursor-acp', label: 'Cursor' },
  { sourceId: 'github-copilot', label: 'GitHub Copilot' },
  { sourceId: 'xai', label: 'SuperGrok' },
  { sourceId: 'kiro', label: 'Kiro' },
  { sourceId: 'kimi-for-coding', label: 'Kimi' },
  { sourceId: 'zai-coding-plan', label: 'Z.AI' },
  { sourceId: 'minimax-coding-plan', label: 'MiniMax' },
] as const;
const OPENCODE_COMPANION_SOURCE_IDS = new Set(['cursor-acp', 'kiro']);

const OPEN_CODE_ROUTE_FILTER_TAG_ORDER: readonly OpenCodeRouteFilterTag[] = [
  'local',
  'configured',
  'connected',
];
const OPEN_CODE_ROUTE_FILTER_TAG_STYLES: Record<
  OpenCodeRouteFilterTag,
  { dot: string; selected: string }
> = {
  local: {
    dot: 'bg-cyan-300',
    selected: 'border-cyan-300/50 bg-cyan-300/10 text-cyan-100',
  },
  configured: {
    dot: 'bg-sky-300',
    selected: 'border-sky-300/50 bg-sky-300/10 text-sky-100',
  },
  connected: {
    dot: 'bg-emerald-300',
    selected: 'border-emerald-300/50 bg-emerald-300/10 text-emerald-100',
  },
};

function getCuratedOpenCodeProviderTab(
  sourceId: string
): { sourceId: string; label: string } | null {
  const normalizedSourceId = sourceId.trim().toLowerCase();
  const curated = CURATED_OPENCODE_PROVIDER_TABS.find((tab) => tab.sourceId === normalizedSourceId);
  if (curated) {
    return curated;
  }
  if (normalizedSourceId.startsWith('xiaomi-token-plan-')) {
    return { sourceId: normalizedSourceId, label: 'Xiaomi MiMo' };
  }
  return null;
}

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

function isAppManagedOpenCodeLocalModel(
  modelId: string,
  catalogModel: ProviderModelCatalogItem | null | undefined
): boolean {
  const route = catalogModel?.metadata?.opencode;
  const sourceId =
    route?.providerId?.trim().toLowerCase() ||
    parseOpenCodeQualifiedModelRef(modelId)?.sourceId ||
    null;
  // OpenCode currently reports Cursor ACP and Kiro as configured_authless.
  // They are companion runtimes, not local OpenAI-compatible servers managed by this app.
  if (sourceId && OPENCODE_COMPANION_SOURCE_IDS.has(sourceId)) {
    return false;
  }
  if (!route) {
    return isOpenCodeLocalProviderId(sourceId);
  }
  if (route.routeKind !== 'configured_local') {
    return false;
  }

  return route.accessKind !== 'credentialed' || modelId.startsWith('local/');
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
  routeTag,
  routeTagLabel,
  recommendation,
  pricingInfo,
}: {
  option: TeamRuntimeModelOption;
  sourceInfo: OpenCodeSourceInfo | null;
  routeGroup: OpenCodeRouteGroupInfo;
  routeMetadata: NonNullable<ProviderModelCatalogItem['metadata']>['opencode'] | null;
  routeTag: OpenCodeRouteFilterTag | null;
  routeTagLabel: string;
  recommendation: ReturnType<typeof getTeamModelRecommendation>;
  pricingInfo: OpenCodeModelPricingInfo | null;
}): string {
  return [
    option.value,
    option.label,
    option.badgeLabel ?? '',
    sourceInfo?.label ?? '',
    routeGroup.label,
    routeTag ?? '',
    routeTagLabel,
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
  return isOpenCodeModelExplicitlyFree({
    modelId: option.value,
    providerId: routeMetadata?.providerId,
    routeKind: routeMetadata?.routeKind,
    accessKind: routeMetadata?.accessKind,
    free: pricingInfo?.free,
    badgeLabel: option.badgeLabel,
  });
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
      group,
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

function getOpenCodeModelGroupStatus(
  routeMetadata: OpenCodeModelOptionMetadata['routeMetadata'],
  modelId: string,
  knownLocalSourceIds: ReadonlySet<string> = new Set()
): OpenCodeModelGroupStatus {
  const sourceId =
    routeMetadata?.providerId?.trim().toLowerCase() ??
    parseOpenCodeQualifiedModelRef(modelId)?.sourceId ??
    null;
  if (routeMetadata?.routeKind === 'configured_local' && sourceId) {
    if (
      Array.from(knownLocalSourceIds).some((knownId) => knownId.trim().toLowerCase() === sourceId)
    ) {
      return 'local';
    }
  }
  return getOpenCodeModelRoutePresentationStatus({
    modelId,
    providerId: routeMetadata?.providerId,
    routeKind: routeMetadata?.routeKind,
    accessKind: routeMetadata?.accessKind,
  });
}

function getOpenCodeRouteFilterTag(
  routeMetadata: OpenCodeModelOptionMetadata['routeMetadata'],
  modelId: string,
  knownLocalSourceIds?: ReadonlySet<string>
): OpenCodeRouteFilterTag | null {
  const status = getOpenCodeModelGroupStatus(routeMetadata, modelId, knownLocalSourceIds);
  return status === 'connected' || status === 'configured' || status === 'local' ? status : null;
}

function getOpenCodeRouteFilterTagLabel(
  routeTag: OpenCodeRouteFilterTag,
  t: TeamTranslator
): string {
  switch (routeTag) {
    case 'connected':
      return 'Connected models';
    case 'configured':
      return t('modelSelector.badges.configured');
    case 'local':
      return t('modelSelector.badges.local');
  }
}

function mergeOpenCodeModelGroupStatus(
  current: OpenCodeModelGroupStatus,
  next: OpenCodeModelGroupStatus
): OpenCodeModelGroupStatus {
  if (!current) {
    return next;
  }
  if (!next || current === next) {
    return current;
  }

  const priority: Record<Exclude<OpenCodeModelGroupStatus, null>, number> = {
    local: 4,
    configured: 3,
    connected: 2,
    free: 1,
  };
  return priority[current] >= priority[next] ? current : next;
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
  const explicitlyFree = isOpenCodeModelExplicitlyFree({
    modelId: catalogModel?.launchModel,
    catalogId: catalogModel?.id,
    providerId: metadata.opencode?.providerId,
    routeKind: metadata.opencode?.routeKind,
    accessKind: metadata.opencode?.accessKind,
    free: metadata.free,
    badgeLabel: catalogModel?.badgeLabel,
  });
  const displayRates =
    rates && !explicitlyFree
      ? {
          input: rates.input === 0 ? null : rates.input,
          output: rates.output === 0 ? null : rates.output,
          cacheRead: rates.cacheRead === 0 ? null : rates.cacheRead,
          cacheWrite: rates.cacheWrite === 0 ? null : rates.cacheWrite,
        }
      : rates;
  return {
    free: explicitlyFree,
    summary: displayRates ? formatOpenCodeCostSummary(displayRates, t) : null,
    title: displayRates ? formatOpenCodeCostTitle(displayRates, t) : undefined,
  };
}

function shouldHydrateProviderModelCatalog(
  providerId: TeamProviderId,
  providerStatus: CliProviderStatus | null | undefined
): boolean {
  if (!providerStatus) {
    return false;
  }

  if (providerId === 'anthropic') {
    const catalog = providerStatus?.modelCatalog;
    const runtimeCatalog = providerStatus?.runtimeCapabilities?.modelCatalog;
    return (
      catalog?.source === 'static-fallback' ||
      (runtimeCatalog?.dynamic === true &&
        runtimeCatalog.source !== 'anthropic-compatible-api' &&
        catalog?.source !== 'anthropic-models-api')
    );
  }

  if (providerId === 'opencode') {
    return isOpenCodeCatalogHydrating(providerStatus);
  }

  if (providerId === 'codex') {
    return shouldHydrateCodexModelCatalog(providerStatus);
  }

  return false;
}

const OPENCODE_UI_DISABLED_REASON = 'OpenCode team launch is not ready.';
export const OPENCODE_ONE_SHOT_DISABLED_REASON =
  'OpenCode team launch is available for normal teams, but scheduled one-shot prompts still run through claude -p. Choose Anthropic or Codex for one-shot schedules.';
export const OPENCODE_ONE_SHOT_DISABLED_BADGE_LABEL = 'team only';

const OpenCodeModelGroupHeader = ({
  group,
  sticky = false,
}: Readonly<{ group: OpenCodeModelGroup; sticky?: boolean }>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const status =
    group.status === 'connected'
      ? {
          label: t('modelSelector.badges.connected'),
          dotClassName: 'bg-emerald-300',
          textClassName: 'text-emerald-300',
        }
      : group.status === 'local'
        ? {
            label: t('modelSelector.badges.local'),
            dotClassName: 'bg-cyan-300',
            textClassName: 'text-cyan-200',
          }
        : group.status === 'configured'
          ? {
              label: t('modelSelector.badges.configured'),
              dotClassName: 'bg-sky-300',
              textClassName: 'text-sky-200',
            }
          : group.status === 'free'
            ? {
                label: t('modelSelector.badges.free'),
                dotClassName: 'bg-emerald-300',
                textClassName: 'text-emerald-300',
              }
            : null;

  return (
    <div
      className={cn(
        'flex min-h-9 items-center gap-2 border-y border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5',
        sticky &&
          'sticky top-0 z-20 shadow-[0_6px_14px_-10px_rgba(0,0,0,0.9)] supports-[backdrop-filter]:bg-[color-mix(in_srgb,var(--color-surface)_94%,transparent)] supports-[backdrop-filter]:backdrop-blur-md'
      )}
    >
      {group.sourceInfo ? (
        <ProviderBrandIcon
          provider={{
            providerId: group.sourceInfo.id,
            displayName: group.sourceInfo.label,
          }}
        />
      ) : null}
      <h4 className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
        {group.groupLabel}
      </h4>
      {status ? (
        <span
          data-testid="team-model-selector-opencode-group-status"
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 text-[11px]',
            status.textClassName
          )}
        >
          <span className={cn('size-1.5 rounded-full', status.dotClassName)} aria-hidden="true" />
          {status.label}
        </span>
      ) : null}
      <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
        <span aria-hidden="true">· </span>
        {group.options.length}
      </span>
    </div>
  );
};

const ModelTooltip = ({
  children,
  content,
  disabled = false,
}: Readonly<{
  children: React.ReactElement;
  content: React.ReactNode;
  disabled?: boolean;
}>): React.JSX.Element => {
  if (disabled || !content) {
    return children;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        collisionPadding={12}
        className="z-[120] max-w-72 whitespace-pre-line text-pretty break-words leading-relaxed"
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
};

const OverflowModelName = ({
  className,
  text,
}: Readonly<{ className?: string; text: string }>): React.JSX.Element => {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) {
      return undefined;
    }

    const updateOverflowState = (): void => {
      setIsOverflowing(element.scrollWidth > element.clientWidth + 1);
    };
    updateOverflowState();

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(updateOverflowState);
      resizeObserver.observe(element);
      return () => resizeObserver.disconnect();
    }

    window.addEventListener('resize', updateOverflowState);
    return () => window.removeEventListener('resize', updateOverflowState);
  }, [text]);

  const label = (
    <span ref={textRef} data-testid="team-model-selector-model-name" className={className}>
      {text}
    </span>
  );

  return (
    <ModelTooltip content={text} disabled={!isOverflowing}>
      {label}
    </ModelTooltip>
  );
};

const ModelInfoTooltip = ({
  content,
  iconClassName,
}: Readonly<{ content: string; iconClassName: string }>): React.JSX.Element => (
  <ModelTooltip content={content}>
    <span aria-label={content} className="inline-flex shrink-0">
      <Info className={iconClassName} aria-hidden="true" />
    </span>
  </ModelTooltip>
);

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
  const stickyHeadingIndexes = useMemo(
    () => rows.flatMap((row, index) => (row.kind === 'heading' ? [index] : [])),
    [rows]
  );
  const activeStickyHeadingIndexRef = useRef<number | null>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual API limitation, not fixable in user code
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollParentRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) =>
      rows[index]?.kind === 'heading'
        ? OPENCODE_MODEL_GROUP_HEADING_ESTIMATE_PX
        : OPENCODE_MODEL_ROW_ESTIMATE_PX,
    rangeExtractor: (range) => {
      activeStickyHeadingIndexRef.current = getActiveOpenCodeStickyHeadingIndex(
        stickyHeadingIndexes,
        range.startIndex
      );
      const indexes = new Set(defaultRangeExtractor(range));
      if (activeStickyHeadingIndexRef.current !== null) {
        indexes.add(activeStickyHeadingIndexRef.current);
      }
      return [...indexes].sort((left, right) => left - right);
    },
    overscan: 6,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const activeStickyHeadingRow =
    activeStickyHeadingIndexRef.current === null ? null : rows[activeStickyHeadingIndexRef.current];

  return (
    <div
      ref={scrollParentRef}
      data-testid="team-model-selector-model-grid"
      className={cn(
        '-mx-4 -mb-4 w-[calc(100%+2rem)] flex-none overflow-y-auto rounded-none bg-[var(--color-surface)]',
        MODEL_GRID_RESPONSIVE_HEIGHT_CLASS
      )}
    >
      {activeStickyHeadingRow?.kind === 'heading' ? (
        <div className="sticky top-0 z-20 h-0 overflow-visible">
          <div
            data-sticky="true"
            data-testid="team-model-selector-sticky-group-header"
            className="w-full shadow-[0_6px_14px_-10px_rgba(0,0,0,0.9)]"
          >
            <OpenCodeModelGroupHeader group={activeStickyHeadingRow.group} />
          </div>
        </div>
      ) : null}
      <div
        className="relative w-full"
        style={{
          height: rowVirtualizer.getTotalSize(),
        }}
      >
        {virtualRows.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) {
            return null;
          }

          return (
            <div
              key={row.key}
              ref={rowVirtualizer.measureElement}
              data-index={virtualRow.index}
              className={cn(
                'absolute left-0 top-0 w-full',
                shouldElevateOpenCodeVirtualRow(
                  row.kind,
                  virtualRow.index,
                  activeStickyHeadingIndexRef.current
                ) && 'z-30'
              )}
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {row.kind === 'heading' ? (
                <div data-testid="team-model-selector-opencode-group">
                  <OpenCodeModelGroupHeader group={row.group} />
                </div>
              ) : (
                <div className={cn(row.isLastInGroup && 'pb-4')}>
                  <div
                    className="grid border-l border-[var(--color-border-subtle)]"
                    style={{
                      gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                    }}
                  >
                    {row.options.map(renderModelOption)}
                  </div>
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

const OpenCodeProviderTabsLoadingSkeleton = (): React.JSX.Element => (
  <div
    data-testid="team-model-selector-opencode-source-loading-skeleton"
    role="status"
    aria-label="Checking connected OpenCode providers and loading their models"
    className="px-2 py-2"
  >
    <div className="flex items-start gap-2 rounded-md bg-white/[0.025] px-2.5 py-2.5">
      <RefreshCw
        className="mt-0.5 size-3.5 shrink-0 animate-spin text-sky-300/80"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-[var(--color-text-secondary)]">
          Checking connected providers
        </p>
        <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-muted)]">
          Models will appear automatically.
        </p>
      </div>
    </div>
    <div className="mt-2 space-y-1" aria-hidden="true">
      {[78, 64].map((labelWidth) => (
        <div key={labelWidth} className="flex h-8 items-center gap-2 px-2">
          <div
            className="skeleton-shimmer size-4 shrink-0 rounded"
            style={{ backgroundColor: 'var(--skeleton-base)' }}
          />
          <div
            className="skeleton-shimmer h-2.5 rounded-sm"
            style={{
              width: `${labelWidth}%`,
              backgroundColor: 'var(--skeleton-base)',
            }}
          />
        </div>
      ))}
    </div>
  </div>
);

const OpenCodeFilterLoadingSkeleton = (): React.JSX.Element => (
  <div
    data-testid="team-model-selector-opencode-filter-loading-skeleton"
    aria-hidden="true"
    className="flex items-center gap-2"
  >
    {[92, 116, 78].map((width) => (
      <div
        key={width}
        className="skeleton-shimmer h-7 shrink-0 rounded-full border border-[var(--color-border-subtle)]"
        style={{
          width,
          backgroundColor: 'var(--skeleton-base-dim)',
        }}
      />
    ))}
  </div>
);

export interface TeamModelSelectorProps {
  providerId: TeamProviderId;
  onProviderChange: (providerId: TeamProviderId) => void;
  value: string;
  onValueChange: (value: string) => void;
  projectPath?: string | null;
  id?: string;
  disableGeminiOption?: boolean;
  providerNoticeById?: Partial<Record<TeamProviderId, React.ReactNode>>;
  providerDisabledReasonById?: Partial<Record<TeamProviderId, string | null | undefined>>;
  providerDisabledBadgeLabelById?: Partial<Record<TeamProviderId, string | null | undefined>>;
  providerReadyById?: Partial<Record<TeamProviderId, boolean>>;
  modelAdvisoryReasonByValue?: Partial<Record<string, string | null | undefined>>;
  modelIssueReasonByValue?: Partial<Record<string, string | null | undefined>>;
  modelUnavailableReasonByValue?: Partial<Record<string, string | null | undefined>>;
}

export const TeamModelSelector: React.FC<TeamModelSelectorProps> = ({
  providerId,
  onProviderChange,
  value,
  onValueChange,
  projectPath = null,
  id,
  disableGeminiOption = false,
  providerNoticeById,
  providerDisabledReasonById,
  providerDisabledBadgeLabelById,
  providerReadyById,
  modelAdvisoryReasonByValue,
  modelIssueReasonByValue,
  modelUnavailableReasonByValue,
}) => {
  const { t } = useAppTranslation('team');
  const multimodelEnabled = useStore((s) => s.appConfig?.general?.multimodelEnabled ?? true);
  const selectedProviderId =
    disableGeminiOption && isGeminiUiFrozen() && providerId === 'gemini' ? 'anthropic' : providerId;
  const [recommendedOnly, setRecommendedOnly] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [newOnly, setNewOnly] = useState(false);
  const [selectedOpenCodeRouteTags, setSelectedOpenCodeRouteTags] = useState<
    Set<OpenCodeRouteFilterTag>
  >(() => new Set());
  const [modelQuery, setModelQuery] = useState('');
  const [openCodeSourceFilterOpen, setOpenCodeSourceFilterOpen] = useState(false);
  const [openCodeSourceQuery, setOpenCodeSourceQuery] = useState('');
  const [selectedOpenCodeSourceIds, setSelectedOpenCodeSourceIds] = useState<Set<string>>(
    () => new Set()
  );
  const [inspectedProviderId, setInspectedProviderId] = useState<TeamProviderId | null>(null);
  const previousEffectiveProviderIdRef = useRef<TeamProviderId>(selectedProviderId);
  const previousSelectedProviderIdRef = useRef<TeamProviderId>(selectedProviderId);
  const lastAutoFocusedOpenCodeModelRef = useRef<string | null>(null);
  const autoFocusedOpenCodeSourceRef = useRef<string | null>(null);
  const catalogHydrationRequestedRef = useRef<Set<TeamProviderId>>(new Set());
  const openCodeCatalogScopeKey = projectPath?.trim() || '';
  const openCodeProviderDirectoryCache = useRuntimeProviderDirectoryCacheWithGlobalFallback(
    openCodeCatalogScopeKey || null
  );
  const [pendingPrivateNetworkSetup, setPendingPrivateNetworkSetup] = useState<{
    target: OpenCodeLocalModelSetupTarget;
    projectPath: string;
  } | null>(null);
  const effectiveProviderId = inspectedProviderId ?? selectedProviderId;
  const isInspectingInactiveProvider = inspectedProviderId !== null;
  const {
    cliStatus: effectiveCliStatus,
    sourceCliStatus,
    providerStatus: passiveRuntimeProviderStatus,
    codexSnapshotPending,
  } = useEffectiveCliProviderStatus(effectiveProviderId, {
    projectPath: effectiveProviderId === 'opencode' ? openCodeCatalogScopeKey || null : null,
  });
  const cliStatusLoading = useStore((s) => s.cliStatusLoading);
  const cliProviderStatusLoading = useStore((s) => s.cliProviderStatusLoading ?? {});
  const cliProviderStatusScopeRevision = useStore((s) => s.cliProviderStatusScopeRevision);
  const fetchCliProviderStatus = useStore((s) => s.fetchCliProviderStatus);
  const openCodeRuntimeStatus = useStore((s) => s.openCodeRuntimeStatus);
  const openCodeRuntimeStatusLoading = useStore((s) => s.openCodeRuntimeStatusLoading);
  const openCodeRuntimeError = useStore((s) => s.openCodeRuntimeError);
  const fetchOpenCodeRuntimeStatus = useStore((s) => s.fetchOpenCodeRuntimeStatus);
  const codexRuntimeStatus = useStore((s) => s.codexRuntimeStatus);
  const codexRuntimeStatusLoading = useStore((s) => s.codexRuntimeStatusLoading);
  const codexRuntimeError = useStore((s) => s.codexRuntimeError);
  const fetchCodexRuntimeStatus = useStore((s) => s.fetchCodexRuntimeStatus);
  const installCodexRuntime = useStore((s) => s.installCodexRuntime);
  const [codexRuntimeDialogOpen, setCodexRuntimeDialogOpen] = useState(false);
  const multimodelAvailable =
    multimodelEnabled || effectiveCliStatus?.flavor === 'agent_teams_orchestrator';
  const openCodeLocalProvidersEnabled = multimodelAvailable;
  const {
    providers: openCodeLocalProviders,
    loading: openCodeLocalProvidersLoading,
    authoritative: openCodeLocalProviderLookupAuthoritative,
    error: openCodeLocalProviderLookupError,
    refresh: refreshOpenCodeLocalProviders,
  } = useOpenCodeLocalProviders({
    enabled: openCodeLocalProvidersEnabled,
    projectPath: openCodeCatalogScopeKey || null,
  });
  const knownOpenCodeLocalSourceIds = useMemo(
    () =>
      new Set(openCodeLocalProviders.map((provider) => provider.providerId.trim().toLowerCase())),
    [openCodeLocalProviders]
  );
  const openCodeCatalogSourceProviderId = resolveOpenCodeCatalogSourceProviderId({
    selectedSourceIds: selectedOpenCodeSourceIds,
    selectedModel: effectiveProviderId === 'opencode' ? value : null,
    localModelsSelected: selectedOpenCodeRouteTags.has('local'),
    knownLocalSourceIds: knownOpenCodeLocalSourceIds,
    localProviderLookupReady: openCodeLocalProviderLookupAuthoritative,
  });
  const openCodeSelectionScopeSourceProviderId = resolveOpenCodeCatalogSourceProviderId({
    selectedSourceIds: selectedOpenCodeSourceIds,
    selectedModel: effectiveProviderId === 'opencode' ? value : null,
    localModelsSelected: selectedOpenCodeRouteTags.has('local'),
    knownLocalSourceIds: knownOpenCodeLocalSourceIds,
    localProviderLookupReady: true,
  });
  const openCodeSelectionCatalogScopeKey = openCodeSelectionScopeSourceProviderId
    ? JSON.stringify([openCodeCatalogScopeKey || null, openCodeSelectionScopeSourceProviderId])
    : null;
  const openCodeSelectionScopeRef = useRef({
    value,
    scopeKey: openCodeSelectionCatalogScopeKey,
  });
  if (openCodeSelectionScopeRef.current.value !== value) {
    openCodeSelectionScopeRef.current = {
      value,
      scopeKey: openCodeSelectionCatalogScopeKey,
    };
  }
  const openCodeScopedCatalog = useOpenCodeProviderModelCatalog({
    enabled:
      effectiveProviderId === 'opencode' &&
      multimodelAvailable &&
      effectiveCliStatus?.flavor === 'agent_teams_orchestrator',
    sourceProviderId: openCodeCatalogSourceProviderId,
    projectPath: openCodeCatalogScopeKey || null,
    refreshRevision: cliProviderStatusScopeRevision,
    passiveProviderStatus:
      effectiveProviderId === 'opencode' ? passiveRuntimeProviderStatus : null,
  });
  const runtimeProviderStatus =
    effectiveProviderId === 'opencode'
      ? openCodeScopedCatalog.providerStatus
      : passiveRuntimeProviderStatus;
  const openCodeLocalModelOverlay = useMemo(
    () =>
      buildOpenCodeLocalModelOverlay(
        openCodeLocalProviders,
        t('modelSelector.localModels.configuredModelUnavailable')
      ),
    [openCodeLocalProviders, t]
  );
  const { actionByRoute: localModelActionByRoute, addAndTest: addAndTestLocalModel } =
    useOpenCodeLocalModelSetup({
      projectPath: openCodeCatalogScopeKey,
      addingMessage: t('modelSelector.localModels.addingHint'),
      chooseProjectMessage: t('modelSelector.localModels.chooseProject'),
      autoSelectContextKey: JSON.stringify([selectedProviderId, effectiveProviderId, value]),
      onConfigured: async (configuredProjectPath) => {
        refreshOpenCodeLocalProviders();
        await fetchCliProviderStatus('opencode', {
          silent: true,
          checkReason: 'launch_preflight',
          projectPath: configuredProjectPath,
        });
      },
      onReady: onValueChange,
    });
  const runtimeProviderStatusById = useMemo(
    () =>
      new Map(
        (effectiveCliStatus?.providers ?? []).map((provider) => [provider.providerId, provider])
      ),
    [effectiveCliStatus?.providers]
  );
  const openCodeProviderStatus = runtimeProviderStatusById.get('opencode') ?? null;
  const openCodeRuntimeStatusUiState = getOpenCodeRuntimeStatusUiState({
    providerStatus: openCodeProviderStatus,
    runtimeStatus: openCodeRuntimeStatus,
    runtimeStatusLoading: openCodeRuntimeStatusLoading,
  });
  const openCodeProviderTabs = useMemo<OpenCodeProviderTabDef[]>(() => {
    const passiveOpenCodeStatus =
      effectiveProviderId === 'opencode'
        ? passiveRuntimeProviderStatus
        : runtimeProviderStatusById.get('opencode');
    const statuses = [
      passiveOpenCodeStatus,
      effectiveProviderId === 'opencode' ? runtimeProviderStatus : null,
    ];
    const availableTabsBySourceId = new Map<string, OpenCodeProviderTabDef>();

    for (const status of statuses) {
      for (const model of status?.modelCatalog?.models ?? []) {
        const route = model.metadata?.opencode;
        if (route?.routeKind !== 'connected_provider' && route?.routeKind !== 'configured_local') {
          continue;
        }
        const parsedSourceId = parseOpenCodeQualifiedModelRef(model.launchModel)?.sourceId ?? null;
        const sourceId = route.providerId?.trim().toLowerCase() || parsedSourceId;
        if (!sourceId) {
          continue;
        }

        const curatedTab = getCuratedOpenCodeProviderTab(sourceId);
        if (route.routeKind === 'configured_local' && !curatedTab) {
          continue;
        }
        const existingTab = availableTabsBySourceId.get(sourceId);
        const connected = route.routeKind === 'connected_provider';
        if (existingTab) {
          existingTab.connected = existingTab.connected || connected;
          continue;
        }

        availableTabsBySourceId.set(sourceId, {
          id: `opencode-source:${sourceId}`,
          label:
            curatedTab?.label ??
            getTeamModelSourceBadgeLabel('opencode', model.launchModel) ??
            (route.sourceLabel?.trim() || undefined) ??
            sourceId,
          sourceId,
          connected,
        });
      }
    }

    for (const entry of openCodeProviderDirectoryCache?.entries ?? []) {
      const sourceId = entry.providerId.trim().toLowerCase();
      if (
        !sourceId ||
        sourceId === 'opencode' ||
        isOpenCodeLocalProviderId(sourceId) ||
        entry.state !== 'connected' ||
        (entry.metadata.configuredAuthless && !OPENCODE_COMPANION_SOURCE_IDS.has(sourceId))
      ) {
        continue;
      }
      const existingTab = availableTabsBySourceId.get(sourceId);
      if (existingTab) {
        existingTab.connected = true;
        existingTab.directoryModelCount = entry.modelCount;
        continue;
      }
      availableTabsBySourceId.set(sourceId, {
        id: `opencode-source:${sourceId}`,
        label:
          getCuratedOpenCodeProviderTab(sourceId)?.label ||
          getTeamModelSourceBadgeLabel('opencode', `${sourceId}/pending-model`) ||
          entry.displayName.trim() ||
          sourceId,
        sourceId,
        connected: true,
        directoryModelCount: entry.modelCount,
      });
    }
    const curatedOrderBySourceId = new Map<string, number>(
      CURATED_OPENCODE_PROVIDER_TABS.map((tab, index) => [tab.sourceId, index] as const)
    );
    return Array.from(availableTabsBySourceId.values()).sort(
      (left, right) =>
        Number(right.connected) - Number(left.connected) ||
        (curatedOrderBySourceId.get(left.sourceId) ?? Number.MAX_SAFE_INTEGER) -
          (curatedOrderBySourceId.get(right.sourceId) ?? Number.MAX_SAFE_INTEGER) ||
        left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
    );
  }, [
    effectiveProviderId,
    openCodeProviderDirectoryCache?.entries,
    passiveRuntimeProviderStatus,
    runtimeProviderStatus,
    runtimeProviderStatusById,
  ]);
  const cachedOpenCodeProviderLoadingRows = useMemo<OpenCodeProviderLoadingRowDef[]>(() => {
    const resolvedSourceIds = new Set(openCodeProviderTabs.map((tab) => tab.sourceId));
    const rows = new Map<string, OpenCodeProviderLoadingRowDef>();

    for (const entry of openCodeProviderDirectoryCache?.entries ?? []) {
      const sourceId = entry.providerId.trim().toLowerCase();
      if (
        !sourceId ||
        sourceId === 'opencode' ||
        entry.state !== 'connected' ||
        resolvedSourceIds.has(sourceId) ||
        (entry.metadata.configuredAuthless && !OPENCODE_COMPANION_SOURCE_IDS.has(sourceId))
      ) {
        continue;
      }

      rows.set(sourceId, {
        sourceId,
        label:
          getCuratedOpenCodeProviderTab(sourceId)?.label ||
          getTeamModelSourceBadgeLabel('opencode', `${sourceId}/pending-model`) ||
          entry.displayName.trim() ||
          sourceId,
        // Companion routes can be present in OpenCode config while their
        // separate Cursor/Kiro account session is signed out.
        status: OPENCODE_COMPANION_SOURCE_IDS.has(sourceId) ? 'checking' : 'connected',
      });
    }

    const curatedOrderBySourceId = new Map<string, number>(
      CURATED_OPENCODE_PROVIDER_TABS.map((tab, index) => [tab.sourceId, index] as const)
    );
    return Array.from(rows.values()).sort(
      (left, right) =>
        (curatedOrderBySourceId.get(left.sourceId) ?? Number.MAX_SAFE_INTEGER) -
          (curatedOrderBySourceId.get(right.sourceId) ?? Number.MAX_SAFE_INTEGER) ||
        left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
    );
  }, [openCodeProviderDirectoryCache?.entries, openCodeProviderTabs]);

  useEffect(() => {
    if (
      effectiveProviderId === 'opencode' &&
      !openCodeRuntimeStatus &&
      !openCodeRuntimeStatusLoading
    ) {
      void fetchOpenCodeRuntimeStatus();
    }
  }, [
    effectiveProviderId,
    fetchOpenCodeRuntimeStatus,
    openCodeRuntimeStatus,
    openCodeRuntimeStatusLoading,
  ]);

  useEffect(() => {
    if (
      effectiveProviderId !== 'codex' ||
      codexRuntimeStatus ||
      codexRuntimeStatusLoading ||
      !fetchCodexRuntimeStatus
    ) {
      return;
    }
    void fetchCodexRuntimeStatus();
  }, [codexRuntimeStatus, codexRuntimeStatusLoading, effectiveProviderId, fetchCodexRuntimeStatus]);
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
  const openCodeDefaultOptionLabel = useMemo(() => {
    if (effectiveProviderId !== 'opencode') return t('modelSelector.defaultModel');
    const resolvedModel =
      runtimeProviderStatus?.modelCatalog?.defaultLaunchModel ??
      runtimeProviderStatus?.modelCatalog?.defaultModelId ??
      null;
    if (!resolvedModel) return t('modelSelector.defaultModel');
    const resolvedLabel =
      resolvedModel === 'openrouter/openrouter/free'
        ? 'Free Models Router'
        : (getRuntimeAwareProviderScopedTeamModelLabel(
            'opencode',
            resolvedModel,
            runtimeProviderStatus
          ) ?? resolvedModel);
    return t('modelSelector.defaultWithResolved', { model: resolvedLabel });
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
      const providerStatus = openCodeProviderStatus;
      if (openCodeRuntimeStatusUiState === 'missing') {
        return (
          providerStatus?.detailMessage ??
          providerStatus?.statusMessage ??
          'OpenCode runtime is not installed.'
        );
      }
      if (
        canUseCachedOpenCodeModelsDuringTransientCheck(providerStatus, openCodeRuntimeStatusUiState)
      ) {
        return null;
      }
      if (providerReadyById?.opencode === true) return null;
      if (!providerStatus) {
        return shouldShowOpenCodeRuntimeLoading(null, openCodeRuntimeStatusUiState)
          ? t('modelSelector.openCodeStatus.loadingRuntime')
          : (openCodeRuntimeError ??
              openCodeRuntimeStatus?.error ??
              'OpenCode runtime status is unavailable.');
      }
      if (shouldShowOpenCodeRuntimeLoading(providerStatus, openCodeRuntimeStatusUiState)) {
        return t('modelSelector.openCodeStatus.loadingRuntime');
      }
      if (!providerStatus.supported) {
        return (
          (openCodeRuntimeStatusUiState === 'retry'
            ? (openCodeRuntimeError ?? openCodeRuntimeStatus?.error)
            : null) ??
          providerStatus.detailMessage ??
          providerStatus.statusMessage ??
          'OpenCode runtime is not ready.'
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
    if (
      isTeamProviderId(candidateProviderId) &&
      providerReadyById?.[candidateProviderId] === true
    ) {
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
      return openCodeRuntimeStatusUiState === 'retry' ||
        getProviderDisabledReason(candidateProviderId)
        ? getOpenCodeReadinessBadgeLabel(openCodeProviderStatus, t, openCodeRuntimeStatusUiState)
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
    openCodeLocalModelOverlay.options.length === 0 &&
    ((effectiveProviderId === 'codex' && codexSnapshotPending) ||
      runtimeProviderStatus == null ||
      isTeamProviderModelVerificationPending(effectiveProviderId, runtimeProviderStatus));
  const providerModelCatalogLoading =
    effectiveProviderId === 'opencode'
      ? openCodeScopedCatalog.status === 'loading'
      : cliProviderStatusLoading[effectiveProviderId] === true ||
        runtimeProviderStatus?.modelCatalogRefreshState === 'loading';
  const shouldHydrateRuntimeModelCatalog = shouldHydrateProviderModelCatalog(
    effectiveProviderId,
    runtimeProviderStatus
  );
  const catalogHydrationAlreadyRequested =
    catalogHydrationRequestedRef.current.has(effectiveProviderId);
  const runtimeNormalizedValue = normalizeTeamModelForUi(
    effectiveProviderId,
    value,
    runtimeProviderStatus
  );
  const openCodeSelectionScopeDecision = resolveOpenCodeSelectionScopeDecision({
    value,
    runtimeNormalizedValue,
    selectionScopeKey: openCodeSelectionScopeRef.current.scopeKey,
    catalogScopeKey: openCodeSelectionCatalogScopeKey,
    catalogStatus: openCodeScopedCatalog.status,
    catalogState: openCodeScopedCatalog.catalogState,
  });
  const shouldPreserveOpenCodeSelection =
    effectiveProviderId === 'opencode' && openCodeSelectionScopeDecision.preserve;
  const shouldDeferModelNormalization =
    (effectiveProviderId === 'codex' && codexSnapshotPending) ||
    (effectiveProviderId === 'opencode'
      ? shouldPreserveOpenCodeSelection
      : providerModelCatalogLoading) ||
    (effectiveProviderId !== 'opencode' &&
      shouldHydrateRuntimeModelCatalog &&
      !catalogHydrationAlreadyRequested);
  const scopeAwareRuntimeNormalizedValue =
    effectiveProviderId === 'opencode'
      ? openCodeSelectionScopeDecision.normalizedValue
      : runtimeNormalizedValue;
  const selectedRuntimeCatalogModel = runtimeProviderStatus?.modelCatalog?.models.find(
    (model) => model.launchModel === value || model.id === value
  );
  const selectedAppManagedLocalModel =
    effectiveProviderId === 'opencode' &&
    isAppManagedOpenCodeLocalModel(value, selectedRuntimeCatalogModel);
  const normalizedValue = resolveTeamModelSelectorValue({
    providerId: effectiveProviderId,
    value,
    runtimeNormalizedValue: scopeAwareRuntimeNormalizedValue,
    isAppManagedLocalModel: selectedAppManagedLocalModel,
    isInLocalOverlay: openCodeLocalModelOverlay.modelIds.has(value),
    isLocalLookupAuthoritative: openCodeLocalProviderLookupAuthoritative,
  });
  const selectedUnverifiedLocalModel =
    effectiveProviderId === 'opencode' &&
    normalizedValue === value &&
    scopeAwareRuntimeNormalizedValue !== value;
  const selectedLocalModelFallbackOption = useMemo<TeamRuntimeModelOption | null>(() => {
    const selectedModel = value.trim();
    if (!selectedUnverifiedLocalModel || !selectedModel) {
      return null;
    }
    const parsed = parseOpenCodeQualifiedModelRef(selectedModel);
    const availabilityReason = openCodeLocalProvidersLoading
      ? 'Checking the selected local model...'
      : openCodeLocalProviderLookupError?.trim() ||
        'This explicitly selected local model is not currently served in this project scope.';
    return {
      value: selectedModel,
      label: parsed?.modelId ?? selectedModel,
      badgeLabel:
        getTeamModelSourceBadgeLabel('opencode', selectedModel) ?? parsed?.sourceId ?? 'Local',
      availabilityStatus: 'unavailable',
      availabilityReason,
    };
  }, [
    openCodeLocalProviderLookupError,
    openCodeLocalProvidersLoading,
    selectedUnverifiedLocalModel,
    value,
  ]);


  useEffect(() => {
    if (
      effectiveProviderId === 'opencode' ||
      !multimodelAvailable ||
      effectiveCliStatus?.flavor !== 'agent_teams_orchestrator' ||
      providerModelCatalogLoading ||
      !shouldHydrateRuntimeModelCatalog ||
      catalogHydrationAlreadyRequested
    ) {
      return;
    }

    catalogHydrationRequestedRef.current.add(effectiveProviderId);
    void fetchCliProviderStatus(effectiveProviderId, {
      silent: false,
      checkReason: 'launch_preflight',
    });
  }, [
    effectiveCliStatus?.flavor,
    catalogHydrationAlreadyRequested,
    effectiveProviderId,
    fetchCliProviderStatus,
    multimodelAvailable,
    providerModelCatalogLoading,
    shouldHydrateRuntimeModelCatalog,
  ]);

  useEffect(() => {
    if (isInspectingInactiveProvider) {
      return;
    }
    if (shouldDeferModelNormalization) {
      return;
    }
    if (normalizedValue !== value) {
      onValueChange(normalizedValue);
    }
  }, [
    isInspectingInactiveProvider,
    normalizedValue,
    onValueChange,
    shouldDeferModelNormalization,
    value,
  ]);

  const modelOptions = useMemo(() => {
    if (shouldAwaitRuntimeModelList) {
      const pendingOptions: TeamRuntimeModelOption[] = [
        {
          value: '',
          label: openCodeDefaultOptionLabel,
          badgeLabel: t('modelSelector.defaultModel'),
        },
      ];
      if (selectedLocalModelFallbackOption) {
        pendingOptions.push(selectedLocalModelFallbackOption);
      }
      return pendingOptions;
    }
    const unscopedRuntimeOptions = getAvailableTeamProviderModelOptions(
      effectiveProviderId,
      runtimeProviderStatus
    );
    const catalogModelById = new Map<string, ProviderModelCatalogItem>();
    for (const model of runtimeProviderStatus?.modelCatalog?.models ?? []) {
      catalogModelById.set(model.launchModel, model);
      catalogModelById.set(model.id, model);
    }
    const runtimeOptions =
      effectiveProviderId === 'opencode' && openCodeLocalProviderLookupAuthoritative
        ? unscopedRuntimeOptions.filter(
            (option) =>
              !option.value.trim() ||
              !isAppManagedOpenCodeLocalModel(option.value, catalogModelById.get(option.value)) ||
              openCodeLocalModelOverlay.modelIds.has(option.value)
          )
        : unscopedRuntimeOptions;
    const presentedRuntimeOptions =
      effectiveProviderId === 'opencode'
        ? runtimeOptions.map((option) =>
            option.value.trim() ? option : { ...option, label: openCodeDefaultOptionLabel }
          )
        : runtimeOptions;
    if (
      effectiveProviderId !== 'opencode' ||
      (openCodeLocalModelOverlay.options.length === 0 && !selectedLocalModelFallbackOption)
    ) {
      return presentedRuntimeOptions;
    }

    const optionByValue = new Map(presentedRuntimeOptions.map((option) => [option.value, option]));
    if (
      selectedLocalModelFallbackOption &&
      !optionByValue.has(selectedLocalModelFallbackOption.value)
    ) {
      optionByValue.set(selectedLocalModelFallbackOption.value, selectedLocalModelFallbackOption);
    }
    for (const option of openCodeLocalModelOverlay.options) {
      optionByValue.set(option.value, option);
    }
    return Array.from(optionByValue.values());
  }, [
    effectiveProviderId,
    openCodeLocalProviderLookupAuthoritative,
    openCodeDefaultOptionLabel,
    openCodeLocalModelOverlay.modelIds,
    openCodeLocalModelOverlay.options,
    runtimeProviderStatus,
    selectedLocalModelFallbackOption,
    shouldAwaitRuntimeModelList,
    t,
  ]);
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
  const runtimeCatalogModelById = useMemo(() => {
    const catalog = runtimeProviderStatus?.modelCatalog;
    const modelById = new Map<string, ProviderModelCatalogItem>();
    if (catalog?.providerId === effectiveProviderId) {
      for (const model of catalog.models) {
        const launchModel = model.launchModel.trim();
        const catalogModelId = model.id.trim();
        if (
          effectiveProviderId === 'opencode' &&
          openCodeLocalProviderLookupAuthoritative &&
          isAppManagedOpenCodeLocalModel(launchModel || catalogModelId, model) &&
          !openCodeLocalModelOverlay.modelIds.has(launchModel) &&
          !openCodeLocalModelOverlay.modelIds.has(catalogModelId)
        ) {
          continue;
        }
        if (launchModel) {
          modelById.set(launchModel, model);
        }
        if (catalogModelId) {
          modelById.set(catalogModelId, model);
        }
      }
    }

    if (effectiveProviderId === 'opencode') {
      for (const model of openCodeLocalModelOverlay.catalogModels) {
        const runtimeModel = modelById.get(model.launchModel) ?? modelById.get(model.id);
        const scopedModel =
          runtimeModel?.metadata?.opencode?.proofState === 'verified' ? runtimeModel : model;
        modelById.set(model.launchModel, scopedModel);
        modelById.set(model.id, scopedModel);
      }
    }

    return modelById;
  }, [
    effectiveProviderId,
    openCodeLocalProviderLookupAuthoritative,
    openCodeLocalModelOverlay.catalogModels,
    openCodeLocalModelOverlay.modelIds,
    runtimeProviderStatus?.modelCatalog,
  ]);
  const openCodeModelMetadata = useMemo<OpenCodeModelOptionMetadata[]>(() => {
    if (effectiveProviderId !== 'opencode') {
      return [];
    }

    return modelOptions.map((option, index) => {
      const recommendation = getTeamModelRecommendation(effectiveProviderId, option.value);
      const catalogModel = runtimeCatalogModelById.get(option.value) ?? null;
      const pricingInfo = getOpenCodeModelPricingInfo(catalogModel, t);
      const routeGroup = getOpenCodeRouteGroup(catalogModel, t);
      const routeMetadata = catalogModel?.metadata?.opencode ?? null;
      const parsedSourceInfo = getOpenCodeSourceInfo(option.value);
      const curatedSourceInfo = parsedSourceInfo
        ? getCuratedOpenCodeProviderTab(parsedSourceInfo.id)
        : null;
      const sourceInfo = parsedSourceInfo
        ? {
            ...parsedSourceInfo,
            label:
              (routeMetadata?.routeKind === 'configured_local'
                ? (curatedSourceInfo?.label ?? routeMetadata.sourceLabel?.trim())
                : null) || parsedSourceInfo.label,
          }
        : null;
      const routeTag = getOpenCodeRouteFilterTag(
        routeMetadata,
        option.value,
        knownOpenCodeLocalSourceIds
      );

      return {
        option,
        index,
        catalogModel,
        sourceInfo,
        routeGroup,
        routeMetadata,
        routeTag,
        recommendation,
        pricingInfo,
        searchText: buildOpenCodeModelSearchText({
          option,
          sourceInfo,
          routeGroup,
          routeMetadata,
          routeTag,
          routeTagLabel: routeTag ? getOpenCodeRouteFilterTagLabel(routeTag, t) : '',
          recommendation,
          pricingInfo,
        }),
        isRecommended: isRecommendedTeamModelRecommendation(recommendation),
        isFree: isFreeOpenCodeModelOption({ option, routeMetadata, pricingInfo }),
        isNew: isRecentlyReleasedModel(catalogModel),
      };
    });
  }, [effectiveProviderId, knownOpenCodeLocalSourceIds, modelOptions, runtimeCatalogModelById, t]);
  const openCodeModelMetadataByValue = useMemo(
    () => new Map(openCodeModelMetadata.map((metadata) => [metadata.option.value, metadata])),
    [openCodeModelMetadata]
  );
  const availableOpenCodeSourceIds = useMemo(
    () =>
      new Set(
        openCodeModelMetadata
          .map((metadata) => metadata.sourceInfo?.id ?? null)
          .filter((sourceId): sourceId is string => Boolean(sourceId))
      ),
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
  const recommendedOpenCodeModelCount = useMemo(
    () =>
      openCodeModelMetadata.filter((metadata) => metadata.option.value && metadata.isRecommended)
        .length,
    [openCodeModelMetadata]
  );
  const freeOpenCodeModelCount = useMemo(
    () =>
      openCodeModelMetadata.filter((metadata) => metadata.option.value && metadata.isFree).length,
    [openCodeModelMetadata]
  );
  const newOpenCodeModelCount = useMemo(
    () =>
      openCodeModelMetadata.filter((metadata) => metadata.option.value && metadata.isNew).length,
    [openCodeModelMetadata]
  );
  const hasNewOpenCodeModels = newOpenCodeModelCount > 0;
  const openCodeRouteTagOptions = useMemo<OpenCodeRouteTagOption[]>(() => {
    const counts = new Map<OpenCodeRouteFilterTag, number>();
    for (const metadata of openCodeModelMetadata) {
      if (!metadata.option.value.trim() || !metadata.routeTag) {
        continue;
      }
      counts.set(metadata.routeTag, (counts.get(metadata.routeTag) ?? 0) + 1);
    }

    return OPEN_CODE_ROUTE_FILTER_TAG_ORDER.flatMap((routeTag) => {
      const count = counts.get(routeTag) ?? 0;
      return count > 0
        ? [
            {
              id: routeTag,
              label: getOpenCodeRouteFilterTagLabel(routeTag, t),
              count,
            },
          ]
        : [];
    });
  }, [openCodeModelMetadata, t]);
  const availableOpenCodeRouteTags = useMemo(
    () => new Set(openCodeRouteTagOptions.map((option) => option.id)),
    [openCodeRouteTagOptions]
  );


  useEffect(() => {
    if (effectiveProviderId !== 'opencode') {
      lastAutoFocusedOpenCodeModelRef.current = null;
      autoFocusedOpenCodeSourceRef.current = null;
      return;
    }

    const selectedModel = normalizedValue.trim();
    if (!selectedModel) {
      if (autoFocusedOpenCodeSourceRef.current) {
        setSelectedOpenCodeSourceIds(new Set());
        setSelectedOpenCodeRouteTags(new Set());
      }
      lastAutoFocusedOpenCodeModelRef.current = null;
      autoFocusedOpenCodeSourceRef.current = null;
      return;
    }
    if (lastAutoFocusedOpenCodeModelRef.current === selectedModel) {
      return;
    }

    const selectedMetadata = openCodeModelMetadataByValue.get(selectedModel);
    if (!selectedMetadata) {
      return;
    }

    if (selectedMetadata.routeTag === 'local') {
      lastAutoFocusedOpenCodeModelRef.current = selectedModel;
      autoFocusedOpenCodeSourceRef.current = OPENCODE_LOCAL_MODELS_TAB_ID;
      setSelectedOpenCodeSourceIds(new Set());
      setSelectedOpenCodeRouteTags(new Set(['local']));
      return;
    }

    const selectedSourceId = selectedMetadata.sourceInfo?.id ?? null;
    if (
      !selectedSourceId ||
      !openCodeProviderTabs.some((tab) => tab.sourceId === selectedSourceId)
    ) {
      return;
    }

    lastAutoFocusedOpenCodeModelRef.current = selectedModel;
    autoFocusedOpenCodeSourceRef.current = selectedSourceId;
    setSelectedOpenCodeSourceIds(new Set([selectedSourceId]));
    setSelectedOpenCodeRouteTags(new Set());
  }, [effectiveProviderId, normalizedValue, openCodeModelMetadataByValue, openCodeProviderTabs]);

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
    if (newOnly && (effectiveProviderId !== 'opencode' || !hasNewOpenCodeModels)) {
      setNewOnly(false);
    }
  }, [effectiveProviderId, hasNewOpenCodeModels, newOnly]);

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
    if (
      selectedOpenCodeSourceIds.size === 0 &&
      selectedOpenCodeRouteTags.size === 0 &&
      !openCodeSourceFilterOpen
    ) {
      return;
    }
    setSelectedOpenCodeSourceIds(new Set());
    setSelectedOpenCodeRouteTags(new Set());
    setOpenCodeSourceFilterOpen(false);
  }, [
    effectiveProviderId,
    openCodeSourceFilterOpen,
    selectedOpenCodeRouteTags,
    selectedOpenCodeSourceIds,
  ]);

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
      if (newOnly && !metadata.isNew) {
        continue;
      }
      if (
        selectedOpenCodeRouteTags.size > 0 &&
        (!metadata.routeTag || !selectedOpenCodeRouteTags.has(metadata.routeTag))
      ) {
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
  }, [
    effectiveProviderId,
    freeOnly,
    newOnly,
    openCodeModelMetadata,
    recommendedOnly,
    selectedOpenCodeRouteTags,
  ]);

  useEffect(() => {
    if (
      selectedOpenCodeSourceIds.size === 0 ||
      effectiveProviderId !== 'opencode' ||
      providerModelCatalogLoading ||
      shouldAwaitRuntimeModelList ||
      isOpenCodeCatalogHydrating(runtimeProviderStatus)
    ) {
      return;
    }

    const nextSelectedSourceIds = new Set(
      Array.from(selectedOpenCodeSourceIds).filter((sourceId) =>
        sourceId === 'opencode' ||
        availableOpenCodeSourceIds.has(sourceId) ||
        openCodeProviderTabs.some((provider) => provider.sourceId === sourceId)
      )
    );
    if (nextSelectedSourceIds.size !== selectedOpenCodeSourceIds.size) {
      setSelectedOpenCodeSourceIds(nextSelectedSourceIds);
    }
  }, [
    availableOpenCodeSourceIds,
    openCodeProviderTabs,
    effectiveProviderId,
    providerModelCatalogLoading,
    runtimeProviderStatus,
    selectedOpenCodeSourceIds,
    shouldAwaitRuntimeModelList,
  ]);

  useEffect(() => {
    if (
      selectedOpenCodeRouteTags.size === 0 ||
      effectiveProviderId !== 'opencode' ||
      providerModelCatalogLoading ||
      shouldAwaitRuntimeModelList ||
      isOpenCodeCatalogHydrating(runtimeProviderStatus)
    ) {
      return;
    }

    const nextSelectedRouteTags = new Set(
      Array.from(selectedOpenCodeRouteTags).filter((routeTag) =>
        availableOpenCodeRouteTags.has(routeTag)
      )
    );
    if (nextSelectedRouteTags.size !== selectedOpenCodeRouteTags.size) {
      setSelectedOpenCodeRouteTags(nextSelectedRouteTags);
    }
  }, [
    availableOpenCodeRouteTags,
    effectiveProviderId,
    providerModelCatalogLoading,
    runtimeProviderStatus,
    selectedOpenCodeRouteTags,
    shouldAwaitRuntimeModelList,
  ]);

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

  const toggleOpenCodeRouteTag = (routeTag: OpenCodeRouteFilterTag): void => {
    setSelectedOpenCodeRouteTags((previous) => {
      const next = new Set(previous);
      if (next.has(routeTag)) {
        next.delete(routeTag);
      } else {
        next.add(routeTag);
      }
      return next;
    });
  };

  const hasActiveOpenCodeFilters =
    recommendedOnly ||
    freeOnly ||
    newOnly ||
    selectedOpenCodeRouteTags.size > 0 ||
    selectedOpenCodeSourceIds.size > 0;

  const clearOpenCodeFilters = (): void => {
    setRecommendedOnly(false);
    setFreeOnly(false);
    setNewOnly(false);
    setSelectedOpenCodeRouteTags(new Set());
    setSelectedOpenCodeSourceIds(new Set());
    setOpenCodeSourceFilterOpen(false);
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
      .filter((metadata) => !newOnly || metadata.isNew)
      .filter(
        (metadata) =>
          selectedOpenCodeRouteTags.size === 0 ||
          Boolean(metadata.routeTag && selectedOpenCodeRouteTags.has(metadata.routeTag))
      )
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
        if (recommendationOrder !== 0) {
          return recommendationOrder;
        }
        if (left.isFree !== right.isFree) {
          return left.isFree ? -1 : 1;
        }
        const freshnessOrder = compareModelFreshness(left, right);
        if (freshnessOrder !== 0) {
          return freshnessOrder;
        }
        return left.index - right.index;
      });

    if (
      recommendedOnly ||
      freeOnly ||
      newOnly ||
      selectedOpenCodeRouteTags.size > 0 ||
      selectedOpenCodeSourceIds.size > 0
    ) {
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
    newOnly,
    openCodeModelMetadata,
    recommendedOnly,
    selectedOpenCodeRouteTags,
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
      const matchingOptions = modelOptions.filter(matchesModelQuery);
      const defaultOptions = matchingOptions.filter((option) => !option.value.trim());
      const concreteOptions = matchingOptions
        .filter((option) => option.value.trim())
        .map((option, index) => ({
          option,
          index,
          catalogModel: runtimeCatalogModelById.get(option.value) ?? null,
        }))
        .sort((left, right) => compareModelFreshness(left, right) || left.index - right.index)
        .map(({ option }) => option);
      return [...defaultOptions, ...concreteOptions];
    }

    return visibleOpenCodeModelMetadata.map((metadata) => metadata.option);
  }, [
    effectiveProviderId,
    modelOptions,
    modelQuery,
    runtimeCatalogModelById,
    visibleOpenCodeModelMetadata,
  ]);
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
      const groupStatus =
        metadata.routeTag ?? getOpenCodeModelGroupStatus(metadata.routeMetadata, option.value);
      const existingGroup = groups.get(groupId);
      if (existingGroup) {
        existingGroup.options.push(option);
        existingGroup.status = mergeOpenCodeModelGroupStatus(existingGroup.status, groupStatus);
        existingGroup.allModelsFree = existingGroup.allModelsFree && metadata.isFree;
        existingGroup.rank = Math.min(existingGroup.rank, metadata.routeGroup.rank);
        existingGroup.firstIndex = Math.min(existingGroup.firstIndex, metadata.index);
      } else {
        groups.set(groupId, {
          groupId,
          groupLabel,
          sourceInfo: sourceGroup,
          status: groupStatus,
          allModelsFree: metadata.isFree,
          rank: metadata.routeGroup.rank,
          sortLabel: groupLabel.toLowerCase(),
          firstIndex: metadata.index,
          options: [option],
        });
      }
    }

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        status: group.status ?? (group.allModelsFree ? 'free' : null),
      }))
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          left.sortLabel.localeCompare(right.sortLabel, undefined, { sensitivity: 'base' }) ||
          left.firstIndex - right.firstIndex
      );
  }, [effectiveProviderId, visibleOpenCodeModelMetadata]);
  const visibleDefaultModelOptions = visibleModelOptions.filter((option) => !option.value.trim());
  const visibleConcreteModelOptionCount =
    visibleModelOptions.length - visibleDefaultModelOptions.length;
  const openCodeCatalogHydrating = isOpenCodeCatalogHydrating(runtimeProviderStatus);
  const concreteModelOptionCount = modelOptions.filter((option) => {
    const model = option.value.trim();
    if (!model) {
      return false;
    }

    return !(
      effectiveProviderId === 'opencode' &&
      openCodeCatalogHydrating &&
      model.toLowerCase() === 'opencode/big-pickle'
    );
  }).length;
  const selectedOpenCodeSourceTab =
    selectedOpenCodeSourceIds.size === 1
      ? (openCodeProviderTabs.find((tab) => selectedOpenCodeSourceIds.has(tab.sourceId)) ?? null)
      : null;
  const isLocalModelsTabActive =
    effectiveProviderId === 'opencode' &&
    selectedOpenCodeSourceIds.size === 0 &&
    selectedOpenCodeRouteTags.size === 1 &&
    selectedOpenCodeRouteTags.has('local');
  const openCodeSourceModelCountById = useMemo(() => {
    const modelIdsBySource = new Map<string, Set<string>>();
    const addModel = (sourceId: string, modelId: string): void => {
      const modelIds = modelIdsBySource.get(sourceId) ?? new Set<string>();
      modelIds.add(modelId);
      modelIdsBySource.set(sourceId, modelIds);
    };
    if (effectiveProviderId === 'opencode') {
      for (const metadata of openCodeModelMetadata) {
        if (!metadata.option.value.trim() || !metadata.sourceInfo) {
          continue;
        }
        addModel(metadata.sourceInfo.id, metadata.option.value);
      }
    }

    const openCodeStatus =
      effectiveProviderId === 'opencode'
        ? passiveRuntimeProviderStatus
        : runtimeProviderStatusById.get('opencode') ?? null;
    const catalogModelById = new Map(
      (openCodeStatus?.modelCatalog?.models ?? []).flatMap((model) => [
        [model.id, model] as const,
        [model.launchModel, model] as const,
      ])
    );
    for (const option of getAvailableTeamProviderModelOptions('opencode', openCodeStatus)) {
      if (!option.value.trim()) {
        continue;
      }
      const catalogModel = catalogModelById.get(option.value);
      const sourceId =
        catalogModel?.metadata?.opencode?.providerId?.trim().toLowerCase() ||
        getOpenCodeSourceInfo(option.value)?.id ||
        null;
      if (sourceId) {
        addModel(sourceId, option.value);
      }
    }
    const modelCountBySource = new Map(
      Array.from(modelIdsBySource, ([sourceId, modelIds]) => [sourceId, modelIds.size] as const)
    );
    if (
      openCodeScopedCatalog.sourceProviderId !== 'opencode' &&
      openCodeScopedCatalog.sourceProviderId &&
      openCodeScopedCatalog.freshModelCount !== null
    ) {
      modelCountBySource.set(
        openCodeScopedCatalog.sourceProviderId,
        openCodeScopedCatalog.freshModelCount
      );
    }
    return modelCountBySource;
  }, [
    effectiveProviderId,
    openCodeModelMetadata,
    openCodeScopedCatalog.freshModelCount,
    openCodeScopedCatalog.sourceProviderId,
    passiveRuntimeProviderStatus,
    runtimeProviderStatusById,
  ]);
  const isOpenCodeSourceTabLoadable = (provider: OpenCodeProviderTabDef): boolean => {
    const visibleModelCount = openCodeSourceModelCountById.get(provider.sourceId) ?? 0;
    const freshScopedModelCount =
      openCodeScopedCatalog.sourceProviderId === provider.sourceId
        ? openCodeScopedCatalog.freshModelCount
        : null;
    const hasFreshScopedAuthority =
      provider.sourceId !== 'opencode' && freshScopedModelCount !== null;
    if (hasFreshScopedAuthority) {
      return freshScopedModelCount > 0;
    }
    const scopedLoadPending =
      openCodeScopedCatalog.sourceProviderId === provider.sourceId &&
      openCodeScopedCatalog.status === 'loading';
    const directoryExpectsModels =
      provider.directoryModelCount === null ||
      (provider.directoryModelCount !== undefined && provider.directoryModelCount > 0);
    return visibleModelCount > 0 || directoryExpectsModels || scopedLoadPending;
  };
  // Local inventory stays independent from the currently inspected runtime.
  const localDetectedModelCount = openCodeLocalModelOverlay.detectedCount;
  const localConfiguredModelCount = openCodeLocalModelOverlay.configuredCount;
  const openCodeCatalogLoading =
    effectiveProviderId === 'opencode' &&
    openCodeScopedCatalog.status === 'loading';
  const openCodeCatalogRefreshFailed =
    effectiveProviderId === 'opencode' && openCodeScopedCatalog.status === 'error';
  const retryOpenCodeCatalogRefresh = openCodeScopedCatalog.refresh;
  const retryOpenCodeRuntimeStatus = (): void => {
    void fetchOpenCodeRuntimeStatus();
    void fetchCliProviderStatus('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath: openCodeCatalogScopeKey || null,
    });
    retryOpenCodeCatalogRefresh();
  };
  const shouldShowOpenCodeCatalogLoading =
    openCodeCatalogLoading &&
    openCodeLocalModelOverlay.options.length === 0 &&
    concreteModelOptionCount === 0;
  const shouldShowOpenCodeSourceSkeleton =
    openCodeCatalogLoading &&
    openCodeProviderTabs.length === 0 &&
    cachedOpenCodeProviderLoadingRows.length === 0;
  const shouldShowCachedOpenCodeProviderRows =
    (openCodeCatalogLoading || openCodeCatalogRefreshFailed) &&
    openCodeProviderTabs.length === 0 &&
    cachedOpenCodeProviderLoadingRows.length > 0;
  const shouldShowOpenCodeFilterSkeleton =
    openCodeCatalogLoading && !shouldShowOpenCodeCatalogLoading;
  const shouldShowModelSearch =
    !shouldShowOpenCodeCatalogLoading &&
    (effectiveProviderId === 'opencode' || concreteModelOptionCount > 8);
  const shouldShowOpenCodeFilters =
    !shouldShowOpenCodeCatalogLoading &&
    ((effectiveProviderId === 'opencode' &&
      openCodeSourceOptions.length > 1 &&
      !selectedOpenCodeSourceTab) ||
      openCodeRouteTagOptions.length > 0 ||
      hasRecommendedOpenCodeModels ||
      hasFreeOpenCodeModels ||
      hasNewOpenCodeModels ||
      shouldShowOpenCodeFilterSkeleton);
  const trimmedModelQuery = modelQuery.trim();
  const shouldConstrainModelListHeight = visibleModelOptions.length > 8;
  const shouldVirtualizeOpenCodeModels =
    effectiveProviderId === 'opencode' &&
    !shouldShowOpenCodeCatalogLoading &&
    visibleConcreteModelOptionCount > OPENCODE_MODEL_VIRTUALIZATION_THRESHOLD;
  const emptyModelListMessage = trimmedModelQuery
    ? t('modelSelector.empty.noSearchMatches')
    : effectiveProviderId === 'opencode' && (selectedOpenCodeRouteTags.size > 0 || newOnly)
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
  const openCodeHasFreeModelRoute = hasFreeOpenCodeModelRoute(runtimeProviderStatus);
  const showOpenCodeOverviewStatus = shouldShowOpenCodeOverviewStatus(
    effectiveProviderId,
    selectedOpenCodeSourceIds.size,
    selectedOpenCodeRouteTags.size
  ) ||
    (effectiveProviderId === 'opencode' &&
      selectedOpenCodeSourceIds.size === 1 &&
      selectedOpenCodeSourceIds.has('opencode') &&
      selectedOpenCodeRouteTags.size === 0);
  const activeProviderStatusPanel =
    effectiveProviderId === 'opencode' && openCodeRuntimeStatusUiState === 'retry'
      ? {
          tone: 'warning' as const,
          title: t('modelSelector.openCodeStatus.notReadyTitle'),
          summary: getOpenCodeReadinessSummary(
            openCodeProviderStatus,
            t,
            openCodeRuntimeStatusUiState
          ),
          message: getOpenCodeReadinessMessage(
            openCodeProviderStatus,
            t,
            openCodeRuntimeStatusUiState
          ),
          reason: openCodeRuntimeError ?? openCodeRuntimeStatus?.error ?? null,
          actionLabel: t('modelSelector.openCodeStatus.badges.retry'),
        }
      : activeProviderDisabledReason && effectiveProviderId === 'opencode'
        ? {
            tone: 'warning' as const,
            title: t('modelSelector.openCodeStatus.notReadyTitle'),
            summary: getOpenCodeReadinessSummary(
              openCodeProviderStatus,
              t,
              openCodeRuntimeStatusUiState
            ),
            message: getOpenCodeReadinessMessage(
              openCodeProviderStatus,
              t,
              openCodeRuntimeStatusUiState
            ),
            reason: activeProviderDisabledReason,
            actionLabel: null,
          }
        : showOpenCodeOverviewStatus &&
            runtimeProviderStatus?.supported === true &&
            runtimeProviderStatus.authenticated === false &&
            openCodeHasFreeModelRoute
          ? {
              tone: 'info' as const,
              title: t('modelSelector.openCodeStatus.freeModelsAvailableTitle'),
              summary: null,
              message: getOpenCodeReadinessMessage(
                openCodeProviderStatus,
                t,
                openCodeRuntimeStatusUiState
              ),
              reason: null,
              actionLabel: null,
            }
          : showOpenCodeOverviewStatus &&
              runtimeProviderStatus?.supported === true &&
              runtimeProviderStatus.authenticated === false
            ? {
                tone: 'warning' as const,
                title: t('modelSelector.openCodeStatus.providerNotConnectedTitle'),
                summary: getOpenCodeReadinessSummary(
                  openCodeProviderStatus,
                  t,
                  openCodeRuntimeStatusUiState
                ),
                message: getOpenCodeReadinessMessage(
                  openCodeProviderStatus,
                  t,
                  openCodeRuntimeStatusUiState
                ),
                reason: null,
                actionLabel: null,
              }
            : showOpenCodeOverviewStatus && canActivateInspectedOpenCode
              ? {
                  tone: 'ready' as const,
                  title: t('modelSelector.openCodeStatus.readyTitle'),
                  summary: getOpenCodeReadinessSummary(
                    openCodeProviderStatus,
                    t,
                    openCodeRuntimeStatusUiState
                  ),
                  message: t('modelSelector.openCodeStatus.readyMessage'),
                  reason: null,
                  actionLabel: t('modelSelector.openCodeStatus.useOpenCode'),
                }
              : null;
  const activeProviderNotice = providerNoticeById?.[effectiveProviderId] ?? null;
  const codexModelCatalogFallbackActive = isCodexModelCatalogFallbackActive(
    runtimeProviderStatus?.modelCatalog
  );
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
    const explicitModelUnavailableReason =
      opt.value === '' ? null : (modelUnavailableReasonByValue?.[opt.value] ?? null);
    const modelUnavailableReason =
      opt.value === ''
        ? null
        : (explicitModelUnavailableReason ??
          getOpenCodeOpenAiRouteAuthUnavailableReason(
            effectiveProviderId,
            opt.value,
            runtimeProviderStatus
          ) ??
          runtimeUnavailableReason);
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
    const openCodeRouteStatus = getOpenCodeModelGroupStatus(openCodeRouteMetadata, opt.value);
    const openCodeProofState = openCodeRouteMetadata?.proofState ?? null;
    const localModelDescriptor = openCodeLocalModelOverlay.descriptorByRoute.get(opt.value) ?? null;
    const localModelActionState = localModelActionByRoute[opt.value] ?? null;
    const localModelBlockingReason =
      modelIssueReason ??
      explicitModelUnavailableReason ??
      (localModelDescriptor?.baseStatus === 'not_configured' ? null : modelUnavailableReason);
    const resolvedLocalModelPresentation = localModelDescriptor
      ? resolveOpenCodeLocalModelPresentation({
          descriptor: localModelDescriptor,
          actionState: localModelActionState,
          providerLookupAuthoritative: openCodeLocalProviderLookupAuthoritative,
          proofState: openCodeProofState,
          advisoryReason: modelAdvisoryReason,
          blockingReason: localModelBlockingReason,
        })
      : null;
    const localModelPresentation =
      resolvedLocalModelPresentation?.status === 'not_configured' && !openCodeCatalogScopeKey
        ? {
            ...resolvedLocalModelPresentation,
            reason: t('modelSelector.localModels.chooseProject'),
          }
        : resolvedLocalModelPresentation;
    const localModelCanAdd =
      localModelPresentation?.status === 'not_configured' &&
      Boolean(openCodeCatalogScopeKey) &&
      !isInspectingInactiveProvider &&
      activeProviderSelectable &&
      !modelDisabledReason;
    const localModelCanSelect =
      localModelPresentation === null ||
      localModelPresentation.status === 'ready' ||
      localModelPresentation.status === 'needs_verification' ||
      localModelPresentation.status === 'experimental';
    const hasBlockingModelIssue =
      localModelPresentation?.status === 'incompatible' ||
      (!localModelPresentation && Boolean(modelIssueReason || modelUnavailableReason));
    const hasModelAdvisory =
      localModelPresentation?.status === 'experimental' ||
      (!hasBlockingModelIssue && Boolean(modelAdvisoryReason));
    const modelSelectable =
      !isInspectingInactiveProvider &&
      activeProviderSelectable &&
      !modelDisabledReason &&
      localModelCanSelect &&
      (localModelDescriptor
        ? true
        : !modelUnavailableReason &&
          (opt.value === '' || availabilityStatus == null || availabilityStatus === 'available'));
    const modelInteractable = modelSelectable || localModelCanAdd;
    const localModelStatusHint =
      localModelPresentation?.status === 'needs_verification'
        ? t('modelSelector.localModels.needsVerificationHint')
        : localModelPresentation?.status === 'adding'
          ? t('modelSelector.localModels.addingHint')
          : null;
    const modelStatusMessage =
      localModelPresentation?.reason ??
      localModelStatusHint ??
      modelUnavailableReason ??
      modelIssueReason ??
      modelAdvisoryReason ??
      modelDisabledReason ??
      availabilityReason ??
      null;
    const modelButtonDescription =
      modelStatusMessage ?? (opt.value === '' ? defaultModelTooltip : undefined);
    const showNewRibbon = isRecentlyReleasedModel(runtimeCatalogModelById.get(opt.value));
    const showFreeRibbon =
      openCodePricingInfo?.free === true || openCodeRouteKind === 'builtin_free';
    const isSelectedModel = normalizedValue === opt.value;
    const optionDisplayLabel =
      effectiveProviderId === 'opencode' && isSelectedModel && opt.value.trim()
        ? t('modelSelector.explicitChoice', { model: opt.label })
        : opt.label;
    const isFlatOpenCodeCell = effectiveProviderId === 'opencode';
    const flatCellBackgroundClass =
      'bg-[color-mix(in_srgb,var(--color-surface-raised)_58%,var(--color-surface)_42%)]';

    return (
      <button
        key={opt.value || '__default__'}
        type="button"
        id={opt.value === normalizedValue ? id : undefined}
        data-testid="team-model-selector-model-option"
        aria-pressed={localModelCanAdd ? undefined : isSelectedModel}
        aria-disabled={!modelInteractable}
        aria-label={
          modelButtonDescription
            ? `${optionDisplayLabel}. ${modelButtonDescription}`
            : optionDisplayLabel
        }
        className={cn(
          isFlatOpenCodeCell
            ? 'relative flex min-h-[58px] items-center justify-start gap-1.5 overflow-hidden border-0 border-b border-r border-[var(--color-border-subtle)] px-3 py-2 text-left text-xs font-medium transition-[background-color,color] duration-150'
            : 'relative flex min-h-[44px] items-center justify-center gap-1.5 overflow-hidden rounded-md border bg-[var(--color-surface)] px-3 py-2 text-center text-xs font-medium transition-[background-color,border-color,color,box-shadow] duration-150',
          isFlatOpenCodeCell
            ? hasBlockingModelIssue
              ? 'bg-red-500/[0.07] text-red-200 hover:bg-red-500/10 hover:text-red-100'
              : hasModelAdvisory
                ? 'bg-amber-300/5 text-amber-200 hover:bg-amber-300/10 hover:text-amber-100'
                : isSelectedModel
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                  : modelInteractable
                    ? cn(
                        flatCellBackgroundClass,
                        'text-[var(--color-text-muted)] hover:bg-[color-mix(in_srgb,var(--color-surface-raised)_82%,var(--color-surface)_18%)] hover:text-[var(--color-text-secondary)]'
                      )
                    : cn(flatCellBackgroundClass, 'text-[var(--color-text-muted)]')
            : hasBlockingModelIssue && isSelectedModel
              ? 'border-red-500/60 bg-red-500/10 text-red-100 shadow-sm'
              : hasBlockingModelIssue
                ? 'border-red-500/40 bg-red-500/5 text-red-200 hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-100'
                : hasModelAdvisory && isSelectedModel
                  ? 'border-amber-300/55 bg-amber-300/10 text-amber-100 shadow-sm'
                  : hasModelAdvisory
                    ? 'border-amber-300/35 bg-amber-300/5 text-amber-200 hover:border-amber-300/55 hover:bg-amber-300/10 hover:text-amber-100'
                    : isSelectedModel
                      ? 'border-[var(--color-border-emphasis)] bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                      : modelInteractable
                        ? 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)] hover:border-[var(--color-border-emphasis)] hover:bg-[color-mix(in_srgb,var(--color-surface-raised)_62%,var(--color-surface)_38%)] hover:text-[var(--color-text-secondary)] hover:shadow-sm'
                        : 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)]',
          isFlatOpenCodeCell && isSelectedModel && 'z-[1] ring-1 ring-inset ring-emerald-300',
          !modelInteractable && 'cursor-not-allowed',
          !modelDisabledReason && !activeProviderSelectable && 'pointer-events-none'
        )}
        onClick={() => {
          if (localModelCanAdd && localModelDescriptor) {
            const target: OpenCodeLocalModelSetupTarget = {
              providerId: localModelDescriptor.providerId,
              modelId: localModelDescriptor.modelId,
              modelRoute: localModelDescriptor.route,
              presetId: localModelDescriptor.presetId,
              baseUrl: localModelDescriptor.baseUrl,
              privateNetworkApproved: localModelDescriptor.privateNetworkApproved,
              configuredModelIds: localModelDescriptor.configuredModelIds,
            };
            if (
              isPrivateNetworkRuntimeLocalProviderUrl(target.baseUrl) &&
              !target.privateNetworkApproved
            ) {
              setPendingPrivateNetworkSetup({ target, projectPath: openCodeCatalogScopeKey });
              return;
            }
            void addAndTestLocalModel(target);
            return;
          }
          if (!modelSelectable) return;
          onValueChange(opt.value);
        }}
      >
        <span
          className={cn(
            'flex flex-col justify-center gap-0.5',
            isFlatOpenCodeCell ? 'min-w-0 items-start' : 'items-center'
          )}
        >
          <OverflowModelName
            text={optionDisplayLabel}
            className={cn(
              'max-w-full break-words leading-tight',
              isFlatOpenCodeCell &&
                'w-full truncate text-left text-[12px] font-semibold text-[var(--color-text-secondary)]',
              opt.value === 'gpt-5.5' && 'font-bold'
            )}
          />
          {localModelPresentation && localModelDescriptor ? (
            <OpenCodeLocalModelStatus
              presentation={localModelPresentation}
              providerDisplayName={localModelDescriptor.presetDisplayName}
              statusMessage={modelStatusMessage}
              canAdd={localModelCanAdd}
              retry={localModelActionState?.status === 'error'}
            />
          ) : null}
          {openCodePricingInfo?.summary ? (
            <ModelTooltip content={openCodePricingInfo.title}>
              <span
                data-testid="team-model-selector-model-pricing"
                aria-description={openCodePricingInfo.title}
                className={cn(
                  'max-w-full text-balance text-[9px] font-normal leading-[1.1] text-[var(--color-text-muted)]',
                  isFlatOpenCodeCell && 'w-full truncate text-left text-[10px]'
                )}
              >
                {openCodePricingInfo.summary}
              </span>
            </ModelTooltip>
          ) : null}
          {!isFlatOpenCodeCell && openCodeRouteStatus === 'local' ? (
            <span className="inline-flex items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-300/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-cyan-200">
              {t('modelSelector.badges.local')}
            </span>
          ) : null}
          {!isFlatOpenCodeCell && openCodeRouteStatus === 'configured' ? (
            <span className="inline-flex items-center justify-center rounded-full border border-sky-300/30 bg-sky-300/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-sky-200">
              {t('modelSelector.badges.configured')}
            </span>
          ) : null}
          {!isFlatOpenCodeCell && openCodeRouteStatus === 'connected' ? (
            <span className="inline-flex items-center justify-center rounded-full border border-emerald-300/30 bg-emerald-300/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-emerald-100">
              {t('modelSelector.badges.connected')}
            </span>
          ) : null}
          {!localModelDescriptor && openCodeProofState === 'verified' ? (
            <span className="inline-flex items-center justify-center rounded-full border border-emerald-300/30 bg-emerald-300/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-emerald-100">
              {t('modelSelector.badges.verified')}
            </span>
          ) : null}
          {!localModelDescriptor &&
          shouldShowOpenCodeNeedsTestBadge(
            openCodeProofState,
            openCodeMetadata?.sourceInfo?.id,
            openCodeRouteKind
          ) ? (
            <span className="inline-flex items-center justify-center rounded-full border border-amber-300/30 bg-amber-300/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-amber-200">
              {t('modelSelector.badges.needsTest')}
            </span>
          ) : null}
          {!localModelDescriptor && openCodeProofState === 'failed' ? (
            <span className="inline-flex items-center justify-center rounded-full border border-red-300/30 bg-red-400/10 px-1.5 py-0 text-[9px] font-semibold uppercase text-red-200">
              {t('modelSelector.badges.failed')}
            </span>
          ) : null}
          {modelRecommendation ? (
            <ModelTooltip content={modelRecommendation.reason}>
              <span
                aria-description={modelRecommendation.reason}
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
            </ModelTooltip>
          ) : null}
          {opt.value === '' ? (
            <span className="flex items-center justify-center gap-1">
              <ModelInfoTooltip
                content={defaultModelTooltip}
                iconClassName="size-3 opacity-45 transition-opacity hover:opacity-75"
              />
            </span>
          ) : null}
          {hasBlockingModelIssue && !localModelDescriptor ? (
            <span className="flex items-center justify-center gap-1 text-[10px] font-normal text-red-300">
              <AlertTriangle className="size-3 shrink-0" />
              <span>
                {modelUnavailableReason
                  ? t('modelSelector.badges.unavailable')
                  : t('modelSelector.badges.issue')}
              </span>
              {modelStatusMessage ? (
                <ModelInfoTooltip
                  content={modelStatusMessage}
                  iconClassName="size-3 opacity-55 transition-opacity hover:opacity-85"
                />
              ) : null}
            </span>
          ) : null}
          {hasModelAdvisory && !localModelDescriptor ? (
            <span className="flex items-center justify-center gap-1 text-[10px] font-normal text-amber-200">
              <Info className="size-3 shrink-0" />
              <span>{getModelAdvisoryBadgeLabel(modelAdvisoryReason ?? null)}</span>
              {modelStatusMessage ? (
                <ModelInfoTooltip
                  content={modelStatusMessage}
                  iconClassName="size-3 opacity-55 transition-opacity hover:opacity-85"
                />
              ) : null}
            </span>
          ) : null}
          {!hasBlockingModelIssue && !hasModelAdvisory && modelDisabledReason && (
            <span className="flex items-center justify-center gap-1 text-[10px] font-normal text-[var(--color-text-muted)]">
              <span>{TEAM_MODEL_UI_DISABLED_BADGE_LABEL}</span>
              <ModelInfoTooltip
                content={modelDisabledReason}
                iconClassName="size-3 opacity-45 transition-opacity hover:opacity-75"
              />
            </span>
          )}
        </span>
        {showFreeRibbon ? (
          <span
            data-testid="team-model-selector-model-free-badge"
            className="pointer-events-none absolute right-[-10px] top-1 w-[40px] rotate-45 border-y border-emerald-100/45 bg-emerald-500/90 py-0.5 text-center text-[5px] font-extrabold uppercase leading-none tracking-[0.08em] text-emerald-950 shadow-sm"
          >
            {t('modelSelector.badges.free')}
          </span>
        ) : null}
        {showNewRibbon ? (
          <span className="pointer-events-none absolute left-[-22px] top-1.5 w-[72px] -rotate-45 border border-sky-300/35 bg-sky-400/20 py-0.5 text-center text-[8px] font-bold uppercase leading-none tracking-[0.14em] text-sky-100 shadow-sm">
            New
          </span>
        ) : null}
      </button>
    );
  };
  const activeProviderTabId = isLocalModelsTabActive
    ? OPENCODE_LOCAL_MODELS_TAB_ID
    : effectiveProviderId === 'opencode' && selectedOpenCodeSourceTab
      ? selectedOpenCodeSourceTab.id
      : effectiveProviderId;

  return (
    <TooltipProvider delayDuration={150} skipDelayDuration={1500}>
      <div className="mb-5">
        <Tabs
          orientation="vertical"
          value={activeProviderTabId}
          onValueChange={(nextValue) => {
            autoFocusedOpenCodeSourceRef.current = null;
            if (nextValue === OPENCODE_LOCAL_MODELS_TAB_ID) {
              setSelectedOpenCodeSourceIds(new Set());
              setSelectedOpenCodeRouteTags(new Set(['local']));
              setModelQuery('');
              setRecommendedOnly(false);
              setFreeOnly(false);
              setNewOnly(false);
              setOpenCodeSourceFilterOpen(false);
              if (isProviderSelectable('opencode')) {
                setInspectedProviderId(null);
                if (selectedProviderId !== 'opencode') {
                  onProviderChange('opencode');
                }
              } else if (isProviderInspectable('opencode')) {
                setInspectedProviderId('opencode');
              }
              return;
            }
            const openCodeSourceTab = openCodeProviderTabs.find((tab) => tab.id === nextValue);
            if (openCodeSourceTab) {
              if (!isOpenCodeSourceTabLoadable(openCodeSourceTab)) {
                return;
              }
              setSelectedOpenCodeSourceIds(new Set([openCodeSourceTab.sourceId]));
              setSelectedOpenCodeRouteTags(new Set());
              setModelQuery('');
              setRecommendedOnly(false);
              setFreeOnly(false);
              setNewOnly(false);
              setOpenCodeSourceFilterOpen(false);
              if (isProviderSelectable('opencode')) {
                setInspectedProviderId(null);
                if (selectedProviderId !== 'opencode') {
                  onProviderChange('opencode');
                }
              } else if (isProviderInspectable('opencode')) {
                setInspectedProviderId('opencode');
              }
              return;
            }
            if (!isTeamProviderId(nextValue)) {
              return;
            }
            setSelectedOpenCodeSourceIds(
              nextValue === 'opencode' ? new Set(['opencode']) : new Set()
            );
            setSelectedOpenCodeRouteTags(new Set());
            setModelQuery('');
            setRecommendedOnly(false);
            setFreeOnly(false);
            setNewOnly(false);
            setOpenCodeSourceFilterOpen(false);
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
          <div className="grid min-h-[320px] grid-cols-[minmax(188px,204px)_minmax(0,1fr)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
            <TabsList
              data-testid="team-model-selector-provider-tabs"
              aria-label="Model providers"
              className="h-full min-h-full w-full flex-col items-stretch justify-start gap-1 overflow-visible rounded-none border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-sidebar)] p-2"
            >
              {PROVIDERS.map((provider) => {
                const providerDisabledReason = getProviderDisabledReason(provider.id);
                const providerSelectable = isProviderSelectable(provider.id);
                const providerInspectable = isProviderInspectable(provider.id);
                const statusBadge = getProviderStatusBadge(provider.id);
                const statusBadgeLabel = getProviderStatusBadgeLabel(statusBadge);
                const providerTooltip =
                  providerDisabledReason ??
                  (statusBadge === 'Multimodel off'
                    ? 'Enable Multimodel mode to use this provider.'
                    : statusBadge);

                return (
                  <React.Fragment key={provider.id}>
                    <TabsTrigger
                      value={provider.id}
                      disabled={
                        provider.comingSoon || (!providerSelectable && !providerInspectable)
                      }
                      aria-disabled={!providerSelectable || undefined}
                      aria-description={providerTooltip ?? undefined}
                      data-testid={`team-model-selector-provider-nav-${provider.id}`}
                      className={cn(
                        "relative h-10 w-full shrink-0 justify-start gap-2 overflow-hidden rounded-md border border-transparent px-2.5 text-left text-xs text-[var(--color-text-secondary)] shadow-none transition-colors hover:bg-white/[0.035] hover:text-[var(--color-text)] data-[state=active]:border-white/[0.06] data-[state=active]:bg-white/[0.065] data-[state=active]:text-[var(--color-text)] data-[state=active]:shadow-none data-[state=active]:before:absolute data-[state=active]:before:inset-y-2 data-[state=active]:before:left-0 data-[state=active]:before:w-0.5 data-[state=active]:before:rounded-full data-[state=active]:before:bg-indigo-300 data-[state=active]:before:content-['']",
                        !providerSelectable && 'opacity-50'
                      )}
                    >
                      <ProviderBrandLogo providerId={provider.id} className="size-5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                        {provider.label}
                      </span>
                      {statusBadgeLabel ? (
                        <span
                          data-testid={`team-model-selector-provider-nav-status-${provider.id}`}
                          className="shrink-0 rounded bg-white/[0.05] px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-muted)]"
                          aria-label={statusBadge ?? undefined}
                        >
                          {statusBadgeLabel}
                        </span>
                      ) : null}
                    </TabsTrigger>
                    {provider.id === 'opencode' ? (
                      <TabsTrigger
                        value={OPENCODE_LOCAL_MODELS_TAB_ID}
                        disabled={
                          !isProviderSelectable('opencode') && !isProviderInspectable('opencode')
                        }
                        aria-disabled={!isProviderSelectable('opencode') || undefined}
                        aria-description={getProviderDisabledReason('opencode') ?? undefined}
                        data-testid="team-model-selector-provider-nav-local-models"
                        className="relative h-10 w-full shrink-0 justify-start gap-2 rounded-md border border-transparent px-2.5 text-left text-xs text-[var(--color-text-secondary)] shadow-none transition-colors hover:bg-white/[0.035] hover:text-[var(--color-text)] data-[state=active]:border-cyan-300/10 data-[state=active]:bg-cyan-300/[0.07] data-[state=active]:text-[var(--color-text)] data-[state=active]:shadow-none data-[state=active]:before:absolute data-[state=active]:before:inset-y-2 data-[state=active]:before:left-0 data-[state=active]:before:w-0.5 data-[state=active]:before:rounded-full data-[state=active]:before:bg-cyan-300 data-[state=active]:before:content-['']"
                      >
                        <Server className="size-5 shrink-0 text-cyan-200/80" />
                        <span className="min-w-0 flex-1 leading-tight">
                          <span className="block truncate text-[13px] font-medium">
                            {t('modelSelector.localModels.tabLabel')}
                          </span>
                          <OpenCodeLocalModelsTabStatus
                            loading={openCodeLocalProvidersLoading}
                            error={openCodeLocalProviderLookupError}
                            detectedCount={localDetectedModelCount}
                            configuredCount={localConfiguredModelCount}
                          />
                        </span>
                      </TabsTrigger>
                    ) : null}
                  </React.Fragment>
                );
              })}
              {openCodeProviderTabs.length > 0 ||
              shouldShowOpenCodeSourceSkeleton ||
              shouldShowCachedOpenCodeProviderRows ? (
                <div
                  role="presentation"
                  className="flex items-center justify-between gap-2 px-2 pb-0.5 pt-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]"
                >
                  <span>OpenCode sources</span>
                  {openCodeCatalogLoading ? (
                    <span className="flex items-center gap-1 normal-case tracking-normal">
                      <RefreshCw className="size-2.5 animate-spin" aria-hidden="true" />
                      Syncing models
                    </span>
                  ) : openCodeCatalogRefreshFailed ? (
                    <span className="flex items-center gap-1 normal-case tracking-normal text-amber-200/80">
                      <AlertTriangle className="size-2.5" aria-hidden="true" />
                      Refresh needed
                    </span>
                  ) : null}
                </div>
              ) : null}
              {shouldShowOpenCodeSourceSkeleton ? <OpenCodeProviderTabsLoadingSkeleton /> : null}
              {shouldShowCachedOpenCodeProviderRows
                ? cachedOpenCodeProviderLoadingRows.map((provider) => (
                    <div
                      key={`loading:${provider.sourceId}`}
                      data-testid={`team-model-selector-provider-nav-loading-${provider.sourceId}`}
                      data-connection-status={provider.status}
                      data-catalog-state={
                        openCodeCatalogRefreshFailed ? 'refresh-failed' : 'loading'
                      }
                      role="status"
                      aria-label={
                        openCodeCatalogRefreshFailed
                          ? `${provider.label} provider status is known, but its model catalog could not be refreshed.`
                          : provider.status === 'connected'
                            ? `${provider.label} is connected. Loading models.`
                            : `${provider.label} account status and models are loading.`
                      }
                      className="flex h-10 w-full shrink-0 items-center gap-2 rounded-md px-2.5 text-left text-xs text-[var(--color-text-secondary)]"
                    >
                      <ProviderBrandIcon
                        provider={{ providerId: provider.sourceId, displayName: provider.label }}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                        {provider.label}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
                        <span
                          className={cn(
                            'size-1.5 rounded-full',
                            provider.status === 'connected' ? 'bg-emerald-300' : 'bg-sky-300'
                          )}
                          aria-hidden="true"
                        />
                        {openCodeCatalogRefreshFailed ? (
                          <AlertTriangle className="size-3 text-amber-200/80" aria-hidden="true" />
                        ) : (
                          <RefreshCw className="size-3 animate-spin" aria-hidden="true" />
                        )}
                        <span className="sr-only">
                          {openCodeCatalogRefreshFailed
                            ? 'Provider status known. Model catalog refresh failed.'
                            : provider.status === 'connected'
                              ? 'Connected. Loading models.'
                              : 'Checking account status and loading models.'}
                        </span>
                      </span>
                    </div>
                  ))
                : null}
              {openCodeProviderTabs.map((provider) => {
                const openCodeDisabledReason = getProviderDisabledReason('opencode');
                const sourceModelCount = openCodeSourceModelCountById.get(provider.sourceId) ?? 0;
                const sourceLoadable = isOpenCodeSourceTabLoadable(provider);
                return (
                  <TabsTrigger
                    key={provider.id}
                    value={provider.id}
                    disabled={
                      !sourceLoadable ||
                      (!isProviderSelectable('opencode') && !isProviderInspectable('opencode'))
                    }
                    aria-disabled={
                      !sourceLoadable || !isProviderSelectable('opencode') || undefined
                    }
                    aria-description={
                      sourceLoadable
                        ? (openCodeDisabledReason ?? undefined)
                        : `${provider.label} has no available models.`
                    }
                    data-connection-status={provider.connected ? 'connected' : undefined}
                    data-testid={`team-model-selector-provider-nav-${provider.sourceId}`}
                    className="relative h-10 w-full shrink-0 justify-start gap-2 rounded-md border border-transparent px-2.5 text-left text-xs text-[var(--color-text-secondary)] shadow-none transition-colors hover:bg-white/[0.035] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-45 data-[state=active]:border-white/[0.06] data-[state=active]:bg-white/[0.065] data-[state=active]:text-[var(--color-text)] data-[state=active]:shadow-none data-[state=active]:before:absolute data-[state=active]:before:inset-y-2 data-[state=active]:before:left-0 data-[state=active]:before:w-0.5 data-[state=active]:before:rounded-full data-[state=active]:before:bg-emerald-300 data-[state=active]:before:content-['']"
                  >
                    <ProviderBrandIcon
                      provider={{ providerId: provider.sourceId, displayName: provider.label }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {provider.label}
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-[var(--color-text-muted)]">
                      {provider.connected ? (
                        <>
                          <span
                            data-testid={`team-model-selector-provider-nav-connected-${provider.sourceId}`}
                            className="size-1.5 rounded-full bg-emerald-300"
                            aria-hidden="true"
                          />
                          <span className="sr-only">Connected provider, </span>
                        </>
                      ) : null}
                      {sourceModelCount}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>

            <div className="flex min-h-0 min-w-0 flex-col bg-[var(--color-surface)]">
              {!multimodelAvailable ? (
                <div className="border-b border-[var(--color-border-subtle)] px-3 py-2">
                  <p className="text-[11px] text-[var(--color-text-muted)]">
                    {t('modelSelector.multimodelRequired')}
                  </p>
                </div>
              ) : null}

              <div className="flex min-h-0 flex-1 flex-col p-4">
                {effectiveProviderId === 'codex' ? (
                  <>
                    <CodexModelCatalogFallbackNotice
                      catalog={runtimeProviderStatus?.modelCatalog}
                      runtimeStatus={codexRuntimeStatus}
                      onUpdate={() => setCodexRuntimeDialogOpen(true)}
                    />
                    {!codexModelCatalogFallbackActive ? (
                      <CodexRuntimeUpdateNotice
                        status={codexRuntimeStatus}
                        onUpdate={() => setCodexRuntimeDialogOpen(true)}
                      />
                    ) : null}
                  </>
                ) : null}
                {activeProviderNotice ? (
                  <div data-testid="team-model-selector-provider-notice" className="mb-3">
                    {activeProviderNotice}
                  </div>
                ) : null}
                {activeProviderStatusPanel ? (
                  <div
                    data-testid="team-model-selector-provider-status"
                    data-tone={activeProviderStatusPanel.tone}
                    className={cn(
                      'mb-3 rounded-md border px-3 py-2 text-[11px] leading-relaxed',
                      activeProviderStatusPanel.tone === 'ready'
                        ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-100'
                        : activeProviderStatusPanel.tone === 'info'
                          ? 'border-sky-300/25 bg-sky-300/[0.07] text-sky-100'
                          : 'border-amber-300/30 bg-amber-300/10 text-amber-100'
                    )}
                  >
                    <div className="flex items-start gap-2">
                      {activeProviderStatusPanel.tone === 'ready' ? (
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-200" />
                      ) : activeProviderStatusPanel.tone === 'info' ? (
                        <Info className="mt-0.5 size-3.5 shrink-0 text-sky-200" />
                      ) : (
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-200" />
                      )}
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium">{activeProviderStatusPanel.title}</p>
                        {activeProviderStatusPanel.summary ? (
                          <p className="opacity-90">{activeProviderStatusPanel.summary}</p>
                        ) : null}
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
                            data-testid={
                              openCodeRuntimeStatusUiState === 'retry'
                                ? 'team-model-selector-opencode-runtime-retry'
                                : undefined
                            }
                            className="mt-1 inline-flex h-7 items-center rounded-md border border-emerald-300/35 bg-emerald-300/10 px-2.5 text-[11px] font-medium text-emerald-100 transition-colors hover:border-emerald-200/50 hover:bg-emerald-300/15"
                            onClick={() => {
                              if (openCodeRuntimeStatusUiState === 'retry') {
                                retryOpenCodeRuntimeStatus();
                                return;
                              }
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
                {effectiveProviderId === 'opencode' && openCodeLocalProviderLookupError ? (
                  <OpenCodeLocalModelsLookupError
                    error={openCodeLocalProviderLookupError}
                    onRetry={refreshOpenCodeLocalProviders}
                  />
                ) : null}
                {openCodeCatalogRefreshFailed ? (
                  <div
                    data-testid="team-model-selector-opencode-catalog-refresh-error"
                    className="mb-3 flex items-start gap-2 rounded-md border border-amber-300/25 bg-amber-300/[0.07] px-3 py-2 text-[11px] leading-relaxed text-amber-100"
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-200" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">OpenCode models could not be refreshed</p>
                      <p className="mt-0.5 text-amber-100/80">
                        {openCodeProviderDirectoryCache
                          ? 'Provider connections are known from the dashboard. '
                          : ''}
                        {openCodeProviderTabs.length > 0
                          ? 'The last loaded model catalog remains visible.'
                          : 'Local models remain available while you retry.'}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 gap-1.5 border-amber-200/25 bg-transparent px-2 text-[11px] text-amber-100 hover:bg-amber-200/10 hover:text-amber-50"
                      onClick={retryOpenCodeCatalogRefresh}
                    >
                      <RefreshCw className="size-3" />
                      Retry
                    </Button>
                  </div>
                ) : null}
                {shouldAwaitRuntimeModelList ? (
                  <div className="mb-2 space-y-1.5">
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      {t('modelSelector.runtimeModelsSyncing')}
                    </p>
                    <ProviderActivityStatusStrip
                      cliStatus={effectiveCliStatus}
                      sourceCliStatus={sourceCliStatus}
                      cliStatusLoading={cliStatusLoading}
                      cliProviderStatusLoading={cliProviderStatusLoading}
                      multimodelEnabled={multimodelEnabled}
                      codexSnapshotPending={codexSnapshotPending}
                      providerIds={[effectiveProviderId]}
                      label={null}
                    />
                  </div>
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
                {shouldShowModelSearch || shouldShowOpenCodeFilters ? (
                  <div
                    data-testid="team-model-selector-model-controls"
                    className="mb-3 space-y-2.5"
                  >
                    {shouldShowModelSearch ? (
                      <div className="relative w-full">
                        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
                        <Input
                          data-testid="team-model-selector-model-search"
                          value={modelQuery}
                          onChange={(event) => setModelQuery(event.target.value)}
                          placeholder={t('modelSelector.searchModels')}
                          aria-label={t('modelSelector.searchModels')}
                          className="h-10 pr-10 text-sm"
                          style={{ paddingLeft: 40 }}
                        />
                        {modelQuery ? (
                          <button
                            type="button"
                            data-testid="team-model-selector-model-search-clear"
                            aria-label="Clear model search"
                            onClick={() => setModelQuery('')}
                            className="absolute right-2 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-white/[0.05] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)]"
                          >
                            <X className="size-3.5" />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {shouldShowOpenCodeFilters ? (
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        {openCodeRouteTagOptions.map((routeTag) => {
                          const selected = selectedOpenCodeRouteTags.has(routeTag.id);
                          const styles = OPEN_CODE_ROUTE_FILTER_TAG_STYLES[routeTag.id];
                          return (
                            <Button
                              key={routeTag.id}
                              type="button"
                              variant="outline"
                              size="sm"
                              data-testid={`team-model-selector-opencode-route-tag-${routeTag.id}`}
                              aria-pressed={selected}
                              aria-label={`${routeTag.label}: ${routeTag.count}`}
                              className={cn(
                                'inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-transparent px-2 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-emphasis)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)]',
                                selected && styles.selected
                              )}
                              onClick={() => toggleOpenCodeRouteTag(routeTag.id)}
                            >
                              <span
                                className={cn('size-1.5 rounded-full', styles.dot)}
                                aria-hidden="true"
                              />
                              <span>{routeTag.label}</span>
                              <span className="text-[10px] opacity-65">{routeTag.count}</span>
                            </Button>
                          );
                        })}
                        {shouldShowOpenCodeFilterSkeleton ? (
                          <OpenCodeFilterLoadingSkeleton />
                        ) : null}
                        {effectiveProviderId === 'opencode' &&
                        openCodeSourceOptions.length > 1 &&
                        !selectedOpenCodeSourceTab ? (
                          <Popover
                            open={openCodeSourceFilterOpen}
                            onOpenChange={setOpenCodeSourceFilterOpen}
                          >
                            <PopoverTrigger asChild>
                              <button
                                type="button"
                                data-testid="team-model-selector-opencode-provider-filter"
                                className={cn(
                                  'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-transparent px-2.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-emphasis)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)]',
                                  selectedOpenCodeSourceIds.size > 0 &&
                                    'border-[var(--color-border-emphasis)] text-[var(--color-text)]'
                                )}
                                aria-label={t('modelSelector.openCode.filterSources')}
                              >
                                <Filter className="size-3.5 shrink-0" />
                                <span className="min-w-0 truncate">
                                  {openCodeSourceFilterLabel}
                                </span>
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
                                  {selectedOpenCodeSourceIds.size > 0 &&
                                  !openCodeSourceQuery.trim() ? (
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
                                          onCheckedChange={() =>
                                            toggleOpenCodeSourceFilter(source.id)
                                          }
                                          onClick={(event) => event.stopPropagation()}
                                          className="size-3.5"
                                          aria-label={t('modelSelector.openCode.filterSource', {
                                            source: source.label,
                                          })}
                                        />
                                        <ProviderBrandIcon
                                          provider={{
                                            providerId: source.id,
                                            displayName: source.label,
                                          }}
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
                          <Button
                            id="opencode-team-model-recommended-only"
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid="team-model-selector-opencode-recommended-only"
                            aria-pressed={recommendedOnly}
                            onClick={() => setRecommendedOnly((current) => !current)}
                            className={cn(
                              'inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-transparent px-2 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-emphasis)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]',
                              recommendedOnly &&
                                'border-amber-300/50 bg-amber-300/10 text-amber-100'
                            )}
                          >
                            <Star className="size-3" />
                            <span>{t('modelSelector.openCode.recommendedOnly')}</span>
                            <span className="text-[10px] opacity-65">
                              {recommendedOpenCodeModelCount}
                            </span>
                          </Button>
                        ) : null}
                        {hasFreeOpenCodeModels ? (
                          <Button
                            id="opencode-team-model-free-only"
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid="team-model-selector-opencode-free-only"
                            aria-pressed={freeOnly}
                            onClick={() => setFreeOnly((current) => !current)}
                            className={cn(
                              'inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-transparent px-2 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-emphasis)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]',
                              freeOnly && 'border-emerald-300/50 bg-emerald-300/10 text-emerald-100'
                            )}
                          >
                            <span className="size-1.5 rounded-full bg-emerald-300" />
                            <span>{t('modelSelector.openCode.freeOnly')}</span>
                            <span className="text-[10px] opacity-65">{freeOpenCodeModelCount}</span>
                          </Button>
                        ) : null}
                        {effectiveProviderId === 'opencode' ? (
                          <Button
                            id="opencode-team-model-new-only"
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid="team-model-selector-opencode-new-only"
                            aria-pressed={newOnly}
                            aria-description={
                              hasNewOpenCodeModels
                                ? undefined
                                : 'No models with a recent release date are available.'
                            }
                            disabled={!hasNewOpenCodeModels}
                            onClick={() => setNewOnly((current) => !current)}
                            className={cn(
                              'inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-transparent px-2 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-emphasis)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]',
                              newOnly && 'border-sky-300/50 bg-sky-300/10 text-sky-100'
                            )}
                          >
                            <Sparkles className="size-3" />
                            <span>New</span>
                            <span className="text-[10px] opacity-65">{newOpenCodeModelCount}</span>
                          </Button>
                        ) : null}
                        {hasActiveOpenCodeFilters ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-testid="team-model-selector-clear-filters"
                            onClick={clearOpenCodeFilters}
                            className="h-7 gap-1 rounded-full px-2 text-[11px] text-[var(--color-text-muted)] hover:bg-white/[0.04] hover:text-[var(--color-text)]"
                          >
                            <X className="size-3" />
                            Clear filters
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {effectiveProviderId === 'opencode' ? (
                  shouldShowOpenCodeCatalogLoading ? (
                    <div
                      data-testid="team-model-selector-model-grid"
                      className={cn(
                        '-mx-4 -mb-4 w-[calc(100%+2rem)] flex-none space-y-3 overflow-y-auto rounded-none bg-[var(--color-surface)]',
                        MODEL_GRID_RESPONSIVE_HEIGHT_CLASS
                      )}
                    >
                      {visibleDefaultModelOptions.length > 0 ? (
                        <div
                          className="grid border-l border-[var(--color-border-subtle)]"
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
                        '-mx-4 -mb-4 w-[calc(100%+2rem)] flex-none space-y-4 overflow-y-auto rounded-none bg-[var(--color-surface)]',
                        MODEL_GRID_RESPONSIVE_HEIGHT_CLASS
                      )}
                    >
                      {visibleDefaultModelOptions.length > 0 ? (
                        <div
                          className="grid border-l border-[var(--color-border-subtle)]"
                          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
                        >
                          {visibleDefaultModelOptions.map(renderModelOption)}
                        </div>
                      ) : null}
                      {visibleOpenCodeModelGroups.map((group) => (
                        <section
                          key={group.groupId}
                          data-testid="team-model-selector-opencode-group"
                        >
                          <OpenCodeModelGroupHeader group={group} sticky />
                          <div
                            className="grid border-l border-[var(--color-border-subtle)]"
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
                      '-mx-4 -mb-4 grid min-h-[240px] w-[calc(100%+2rem)] flex-none gap-1.5 rounded-none bg-[var(--color-surface)]',
                      shouldConstrainModelListHeight &&
                        cn('overflow-y-auto', MODEL_GRID_RESPONSIVE_HEIGHT_CLASS)
                    )}
                    style={{
                      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                    }}
                  >
                    {visibleModelOptions.map((option) => renderModelOption(option))}
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
        <CodexRuntimeUpdateDialog
          open={codexRuntimeDialogOpen}
          onOpenChange={setCodexRuntimeDialogOpen}
          status={codexRuntimeStatus}
          loading={codexRuntimeStatusLoading}
          error={codexRuntimeError}
          onInstall={() => void installCodexRuntime?.()}
        />
        <OpenCodeLocalModelPrivateNetworkApprovalDialog
          target={pendingPrivateNetworkSetup?.target ?? null}
          onCancel={() => setPendingPrivateNetworkSetup(null)}
          onApprove={(target) => {
            const approvedProjectPath = pendingPrivateNetworkSetup?.projectPath;
            setPendingPrivateNetworkSetup(null);
            if (!approvedProjectPath || approvedProjectPath !== openCodeCatalogScopeKey) return;
            void addAndTestLocalModel({ ...target, privateNetworkApproved: true });
          }}
        />
      </div>
    </TooltipProvider>
  );
};

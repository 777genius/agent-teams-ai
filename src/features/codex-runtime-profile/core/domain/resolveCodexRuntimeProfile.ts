import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { isDefaultProviderModelSelection } from '@shared/utils/providerModelSelection';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type {
  CliProviderModelCatalog,
  CliProviderModelCatalogItem,
  CliProviderStatus,
  TeamFastMode,
  TeamProviderBackendId,
} from '@shared/types';

export const CODEX_FAST_MODEL_ID = 'gpt-5.4';
export const CODEX_FAST_SPEED_MULTIPLIER = 1.5;
export const CODEX_FAST_CREDIT_COST_MULTIPLIER = 2;

export type CodexFastCapabilitySource = 'model-catalog' | 'static-fallback' | 'unavailable';

type CodexProviderStatusSource = Partial<
  Pick<
    CliProviderStatus,
    | 'providerId'
    | 'authenticated'
    | 'authMethod'
    | 'selectedBackendId'
    | 'resolvedBackendId'
    | 'backend'
    | 'connection'
    | 'modelCatalog'
    | 'runtimeCapabilities'
    | 'models'
  >
> & {
  providerId?: CliProviderStatus['providerId'];
};

export interface CodexRuntimeProfileSource {
  providerStatus?: CodexProviderStatusSource | null;
  accountSnapshot?: Pick<
    CodexAccountSnapshotDto,
    'effectiveAuthMode' | 'launchAllowed' | 'launchIssueMessage' | 'launchReadinessState'
  > | null;
  providerBackendId?: TeamProviderBackendId | string | null;
}

export interface CodexRuntimeSelection {
  resolvedLaunchModel: string | null;
  catalogModel: CliProviderModelCatalogItem | null;
  displayName: string | null;
  catalogSource: CliProviderModelCatalog['source'] | 'runtime' | 'unavailable';
  catalogStatus: CliProviderModelCatalog['status'] | 'unavailable';
  catalogFetchedAt: string | null;
  providerBackendId: TeamProviderBackendId | null;
  effectiveAuthMode: 'chatgpt' | 'api_key' | null;
  launchAllowed: boolean;
  launchReadinessState: string | null;
  launchIssueMessage: string | null;
}

export interface CodexFastModeResolution {
  selectedFastMode: TeamFastMode;
  requestedFastMode: boolean;
  resolvedFastMode: boolean;
  showFastModeControl: boolean;
  selectable: boolean;
  disabledReason: string | null;
  capabilitySource: CodexFastCapabilitySource;
  creditCostMultiplier: 2;
  speedMultiplier: 1.5;
}

export interface CodexRuntimeReconciliation {
  nextFastMode: TeamFastMode;
  fastModeResetReason: string | null;
}

function getCodexCatalog(
  providerStatus: CodexProviderStatusSource | null | undefined
): CliProviderModelCatalog | null {
  return providerStatus?.modelCatalog?.providerId === 'codex' ? providerStatus.modelCatalog : null;
}

function normalizeSelectedModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed || isDefaultProviderModelSelection(trimmed)) {
    return null;
  }
  return trimmed;
}

function getDefaultCatalogModel(
  catalog: CliProviderModelCatalog
): CliProviderModelCatalogItem | null {
  return (
    catalog.models.find((model) => model.id === catalog.defaultModelId) ??
    catalog.models.find((model) => model.launchModel === catalog.defaultLaunchModel) ??
    catalog.models.find((model) => model.isDefault) ??
    null
  );
}

function findCatalogModel(
  catalog: CliProviderModelCatalog | null,
  selectedModel: string | null
): CliProviderModelCatalogItem | null {
  if (!catalog) {
    return null;
  }

  if (!selectedModel) {
    return getDefaultCatalogModel(catalog);
  }

  return (
    catalog.models.find(
      (model) => model.launchModel === selectedModel || model.id === selectedModel
    ) ?? null
  );
}

function resolveBackendId(source: CodexRuntimeProfileSource): TeamProviderBackendId | null {
  const status = source.providerStatus;
  return (
    migrateProviderBackendId('codex', source.providerBackendId) ??
    migrateProviderBackendId('codex', status?.resolvedBackendId) ??
    migrateProviderBackendId('codex', status?.selectedBackendId) ??
    migrateProviderBackendId('codex', status?.backend?.kind) ??
    'codex-native'
  );
}

function resolveEffectiveAuthMode(
  source: CodexRuntimeProfileSource
): CodexRuntimeSelection['effectiveAuthMode'] {
  return (
    source.accountSnapshot?.effectiveAuthMode ??
    source.providerStatus?.connection?.codex?.effectiveAuthMode ??
    (source.providerStatus?.authMethod === 'chatgpt'
      ? 'chatgpt'
      : source.providerStatus?.authMethod === 'api_key'
        ? 'api_key'
        : null)
  );
}

function resolveLaunchAllowed(source: CodexRuntimeProfileSource): {
  launchAllowed: boolean;
  launchReadinessState: string | null;
  launchIssueMessage: string | null;
} {
  const account = source.accountSnapshot;
  const connection = source.providerStatus?.connection?.codex;
  const launchAllowed =
    account?.launchAllowed ??
    connection?.launchAllowed ??
    source.providerStatus?.authenticated ??
    false;
  return {
    launchAllowed,
    launchReadinessState: account?.launchReadinessState ?? connection?.launchReadinessState ?? null,
    launchIssueMessage: account?.launchIssueMessage ?? connection?.launchIssueMessage ?? null,
  };
}

function isCatalogUsableForFast(selection: CodexRuntimeSelection): boolean {
  return selection.catalogStatus === 'ready' || selection.catalogStatus === 'stale';
}

function isCodexProfileStillLoading(selection: CodexRuntimeSelection): boolean {
  return (
    selection.catalogStatus === 'unavailable' &&
    selection.effectiveAuthMode === null &&
    selection.launchReadinessState === null
  );
}

function resolveCodexFastCapability(selection: CodexRuntimeSelection): {
  supported: boolean;
  source: CodexFastCapabilitySource;
} {
  const resolvedModel = selection.catalogModel?.launchModel ?? selection.resolvedLaunchModel;
  if (selection.catalogModel?.supportsFastMode === true) {
    return { supported: true, source: 'model-catalog' };
  }

  if (resolvedModel === CODEX_FAST_MODEL_ID) {
    return { supported: true, source: 'static-fallback' };
  }

  return { supported: false, source: 'unavailable' };
}

export function resolveCodexRuntimeSelection(params: {
  source: CodexRuntimeProfileSource;
  selectedModel?: string | null;
}): CodexRuntimeSelection {
  const providerStatus =
    params.source.providerStatus?.providerId === 'codex' ? params.source.providerStatus : null;
  const source = { ...params.source, providerStatus };
  const catalog = getCodexCatalog(providerStatus);
  const explicitModel = normalizeSelectedModel(params.selectedModel);
  const catalogModel = findCatalogModel(catalog, explicitModel);
  const resolvedLaunchModel =
    catalogModel?.launchModel?.trim() ||
    explicitModel ||
    catalog?.defaultLaunchModel?.trim() ||
    catalog?.defaultModelId?.trim() ||
    null;
  const launch = resolveLaunchAllowed(source);

  return {
    resolvedLaunchModel,
    catalogModel,
    displayName: catalogModel?.displayName?.trim() || null,
    catalogSource: catalog?.source ?? 'unavailable',
    catalogStatus: catalog?.status ?? 'unavailable',
    catalogFetchedAt: catalog?.fetchedAt ?? null,
    providerBackendId: resolveBackendId(source),
    effectiveAuthMode: resolveEffectiveAuthMode(source),
    launchAllowed: launch.launchAllowed,
    launchReadinessState: launch.launchReadinessState,
    launchIssueMessage: launch.launchIssueMessage,
  };
}

export function resolveCodexFastMode(params: {
  selection: CodexRuntimeSelection;
  selectedFastMode?: TeamFastMode | null;
}): CodexFastModeResolution {
  const selectedFastMode = params.selectedFastMode ?? 'inherit';
  const requestedFastMode = selectedFastMode === 'on';
  const selection = params.selection;
  const catalogUsable = isCatalogUsableForFast(selection);
  const fastCapability = resolveCodexFastCapability(selection);

  const selectable =
    selection.providerBackendId === 'codex-native' &&
    selection.effectiveAuthMode === 'chatgpt' &&
    selection.launchAllowed &&
    catalogUsable &&
    Boolean(selection.catalogModel) &&
    fastCapability.supported;

  let disabledReason: string | null = null;
  if (selection.providerBackendId !== 'codex-native') {
    disabledReason = 'Codex Fast mode requires the native Codex runtime.';
  } else if (isCodexProfileStillLoading(selection)) {
    disabledReason = 'Codex runtime capability data is still loading.';
  } else if (selection.effectiveAuthMode === 'api_key') {
    disabledReason =
      'Codex Fast mode is available only with a ChatGPT account. API key mode uses standard API pricing.';
  } else if (selection.effectiveAuthMode !== 'chatgpt') {
    disabledReason = 'Connect a ChatGPT account to use Codex Fast mode.';
  } else if (!selection.launchAllowed) {
    disabledReason =
      selection.launchIssueMessage ??
      'Codex Fast mode requires a launch-ready ChatGPT account session.';
  } else if (!catalogUsable || !selection.catalogModel) {
    disabledReason = 'Codex Fast mode is disabled until the runtime model catalog is available.';
  } else if (!fastCapability.supported) {
    disabledReason = selection.displayName
      ? `Codex Fast mode is not available for ${selection.displayName}.`
      : 'Codex Fast mode is not available for the selected model.';
  }

  return {
    selectedFastMode,
    requestedFastMode,
    resolvedFastMode: requestedFastMode && selectable,
    showFastModeControl: true,
    selectable,
    disabledReason,
    capabilitySource: fastCapability.source,
    creditCostMultiplier: CODEX_FAST_CREDIT_COST_MULTIPLIER,
    speedMultiplier: CODEX_FAST_SPEED_MULTIPLIER,
  };
}

export function reconcileCodexRuntimeSelections(params: {
  selection: CodexRuntimeSelection;
  selectedFastMode?: TeamFastMode | null;
}): CodexRuntimeReconciliation {
  if (isCodexProfileStillLoading(params.selection)) {
    return {
      nextFastMode: params.selectedFastMode ?? 'inherit',
      fastModeResetReason: null,
    };
  }

  const fastResolution = resolveCodexFastMode({
    selection: params.selection,
    selectedFastMode: params.selectedFastMode,
  });
  const nextFastMode =
    fastResolution.selectedFastMode === 'on' && !fastResolution.selectable
      ? 'inherit'
      : fastResolution.selectedFastMode;
  return {
    nextFastMode,
    fastModeResetReason:
      fastResolution.selectedFastMode === 'on' && nextFastMode !== 'on'
        ? (fastResolution.disabledReason ??
          'Codex Fast mode is not available for the selected model or account. Reset to Default.')
        : null,
  };
}

export function buildCodexFastModeArgs(resolvedFastMode: boolean | null | undefined): string[] {
  return resolvedFastMode === true
    ? [
        '--settings',
        JSON.stringify({
          codex: {
            agent_teams_launch_config: {
              config_overrides: ['service_tier="fast"', 'features.fast_mode=true'],
            },
          },
        }),
      ]
    : [];
}

import type { RuntimeLocalProviderListEntryDto } from '@features/runtime-provider-management/contracts';
import type { TeamRuntimeModelOption } from '@renderer/utils/teamModelAvailability';
import type { CliProviderStatus } from '@shared/types';

type ProviderModelCatalogItem = NonNullable<CliProviderStatus['modelCatalog']>['models'][number];

export type OpenCodeLocalModelBaseStatus = 'not_configured' | 'needs_verification' | 'unavailable';

export type OpenCodeLocalModelPresentationStatus =
  | 'ready'
  | 'not_configured'
  | 'needs_verification'
  | 'incompatible'
  | 'experimental'
  | 'adding';

export interface OpenCodeLocalModelDescriptor {
  route: string;
  providerId: string;
  modelId: string;
  presetId: RuntimeLocalProviderListEntryDto['preset']['id'];
  presetDisplayName: string;
  baseUrl: string;
  privateNetworkApproved: boolean;
  configuredModelIds: readonly string[];
  configured: boolean;
  detected: boolean;
  baseStatus: OpenCodeLocalModelBaseStatus;
  baseReason: string | null;
}

export interface OpenCodeLocalModelActionState {
  status: 'adding' | 'ready' | 'needs_verification' | 'incompatible' | 'experimental' | 'error';
  message: string | null;
}

export interface OpenCodeLocalModelPresentation {
  status: OpenCodeLocalModelPresentationStatus;
  reason: string | null;
}

export interface OpenCodeLocalModelOverlay {
  options: TeamRuntimeModelOption[];
  catalogModels: ProviderModelCatalogItem[];
  modelIds: Set<string>;
  descriptorByRoute: Map<string, OpenCodeLocalModelDescriptor>;
  detectedCount: number;
  configuredCount: number;
}

export function buildOpenCodeLocalModelOverlay(
  providers: readonly RuntimeLocalProviderListEntryDto[],
  configuredModelUnavailableReason: string
): OpenCodeLocalModelOverlay {
  const options: TeamRuntimeModelOption[] = [];
  const catalogModels: ProviderModelCatalogItem[] = [];
  const modelIds = new Set<string>();
  const descriptorByRoute = new Map<string, OpenCodeLocalModelDescriptor>();
  let detectedCount = 0;
  let configuredCount = 0;

  for (const provider of providers) {
    const providerId = provider.providerId.trim();
    if (!providerId) continue;

    const liveModelById = new Map(
      provider.liveModels
        .map((model) => [model.id.trim(), model] as const)
        .filter(([modelId]) => Boolean(modelId))
    );
    const configuredModelIds = new Set(
      provider.configuredModelIds.map((modelId) => modelId.trim()).filter(Boolean)
    );
    const configuredLiveModelIds = Array.from(configuredModelIds).filter((modelId) =>
      liveModelById.has(modelId)
    );
    const providerModelIds = Array.from(new Set([...liveModelById.keys(), ...configuredModelIds]));

    for (const modelId of providerModelIds) {
      const route = `${providerId}/${modelId}`;
      if (modelIds.has(route)) continue;

      const liveModel = liveModelById.get(modelId);
      const detected = provider.state === 'available' && Boolean(liveModel);
      const configured = configuredModelIds.has(modelId);
      const baseStatus: OpenCodeLocalModelBaseStatus = !configured
        ? 'not_configured'
        : detected
          ? 'needs_verification'
          : 'unavailable';
      const baseReason =
        baseStatus === 'unavailable'
          ? provider.state === 'unavailable'
            ? provider.message
            : configuredModelUnavailableReason
          : null;
      const displayName = liveModel?.displayName.trim() || modelId;

      if (detected) detectedCount += 1;
      if (configured) configuredCount += 1;
      modelIds.add(route);
      descriptorByRoute.set(route, {
        route,
        providerId,
        modelId,
        presetId: provider.preset.id,
        presetDisplayName: provider.preset.displayName,
        baseUrl: provider.baseUrl,
        privateNetworkApproved: provider.privateNetworkApproved === true,
        configuredModelIds: configuredLiveModelIds,
        configured,
        detected,
        baseStatus,
        baseReason,
      });
      options.push({
        value: route,
        label: displayName,
        badgeLabel: provider.preset.displayName,
        availabilityStatus: configured && detected ? 'available' : 'unavailable',
        availabilityReason: baseReason,
      });
      catalogModels.push({
        id: route,
        launchModel: route,
        displayName,
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: configured && provider.isDefault && provider.defaultModelId === modelId,
        upgrade: false,
        source: 'app-server',
        badgeLabel: provider.preset.displayName,
        statusMessage: baseReason,
        metadata: {
          free: false,
          opencode: {
            providerId,
            modelId,
            sourceLabel: provider.preset.displayName,
            accessKind:
              configured && detected
                ? 'configured_authless'
                : detected
                  ? 'unknown_model'
                  : 'execution_failed',
            routeKind: 'configured_local',
            proofState: configured && detected ? 'needs_probe' : 'failed',
            requiresExecutionProof: true,
            reason: baseReason,
          },
        },
      });
    }
  }

  return {
    options,
    catalogModels,
    modelIds,
    descriptorByRoute,
    detectedCount,
    configuredCount,
  };
}

export function resolveOpenCodeLocalModelPresentation({
  descriptor,
  actionState,
  providerLookupAuthoritative = true,
  proofState,
  advisoryReason,
  blockingReason,
}: {
  descriptor: OpenCodeLocalModelDescriptor;
  actionState?: OpenCodeLocalModelActionState | null;
  providerLookupAuthoritative?: boolean;
  proofState?: 'not_required' | 'needs_probe' | 'verified' | 'failed' | null;
  advisoryReason?: string | null;
  blockingReason?: string | null;
}): OpenCodeLocalModelPresentation {
  if (actionState?.status === 'adding') {
    return { status: 'adding', reason: actionState.message };
  }
  if (descriptor.baseStatus === 'unavailable') {
    return { status: 'incompatible', reason: descriptor.baseReason };
  }
  if (actionState?.status === 'incompatible') {
    return { status: 'incompatible', reason: actionState.message };
  }
  if (blockingReason) {
    return { status: 'incompatible', reason: blockingReason };
  }
  if (descriptor.baseStatus === 'not_configured') {
    if (
      !providerLookupAuthoritative &&
      (actionState?.status === 'ready' ||
        actionState?.status === 'experimental' ||
        actionState?.status === 'needs_verification')
    ) {
      return { status: actionState.status, reason: actionState.message };
    }
    return {
      status: 'not_configured',
      reason: actionState?.status === 'error' ? actionState.message : descriptor.baseReason,
    };
  }
  if (actionState?.status === 'ready') {
    return { status: 'ready', reason: actionState.message };
  }
  if (actionState?.status === 'experimental') {
    return { status: 'experimental', reason: actionState.message };
  }
  if (actionState?.status === 'needs_verification') {
    return { status: 'needs_verification', reason: actionState.message };
  }
  if (advisoryReason?.toLowerCase().includes('experimental local-model override')) {
    return { status: 'experimental', reason: advisoryReason };
  }
  if (proofState === 'verified') {
    return { status: 'ready', reason: null };
  }
  return {
    status: 'needs_verification',
    reason: advisoryReason ?? actionState?.message ?? null,
  };
}

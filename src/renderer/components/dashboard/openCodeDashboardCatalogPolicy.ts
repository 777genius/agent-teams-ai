import {
  getOpenCodeGeneration,
  isOpenCodeRuntimeUsable,
} from '@features/runtime-provider-management/renderer';
import { getAvailableTeamProviderModels } from '@renderer/utils/teamModelAvailability';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { isOpenCodeModelExplicitlyFree } from '@shared/utils/opencodeModelRoute';
import { isOpenCodeFreeTierVersionOutdated } from '@shared/utils/version';

import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';

/** Detection permits a read-only model query, never grants launch authority. */
export function canLoadOpenCodeDashboardCatalog(
  provider: CliProviderStatus | null,
  runtime: OpenCodeRuntimeStatus | null
): boolean {
  return Boolean(
    provider &&
    (provider.supported ||
      isOpenCodeRuntimeUsable(runtime) ||
      provider.externalRuntimeDiagnostics?.some(
        (diagnostic) =>
          diagnostic.detected &&
          (diagnostic.id === 'opencode-live-host' || diagnostic.id === 'opencode-managed-runtime')
      ))
  );
}

export function hasAvailableFreeOpenCodeDashboardModel(
  provider: CliProviderStatus,
  runtime: OpenCodeRuntimeStatus | null
): boolean {
  const catalog = provider.modelCatalog;
  // V2 can report free pricing even when Zen refuses free-tier execution.
  if (
    provider.providerId !== 'opencode' ||
    !provider.supported ||
    !isOpenCodeRuntimeUsable(runtime) ||
    getOpenCodeGeneration(runtime?.version) !== 'v1' ||
    catalog?.status !== 'ready'
  ) {
    return false;
  }

  const availableModels = new Set(getAvailableTeamProviderModels('opencode', provider));
  return catalog.models.some((model) => {
    const route = model.metadata?.opencode;
    return (
      !model.hidden &&
      availableModels.has(model.launchModel) &&
      route != null &&
      !route.failureCode &&
      route.proofState !== 'failed' &&
      route.proofState !== 'needs_probe' &&
      (!route.requiresExecutionProof || route.proofState === 'verified') &&
      (parseOpenCodeQualifiedModelRef(model.launchModel)?.sourceId !== 'opencode' ||
        !isOpenCodeFreeTierVersionOutdated(runtime?.version)) &&
      ['builtin_free', 'credentialed', 'configured_authless', 'verified'].includes(
        route.accessKind
      ) &&
      isOpenCodeModelExplicitlyFree({
        modelId: model.launchModel,
        catalogId: model.id,
        providerId: route.providerId,
        routeKind: route.routeKind,
        accessKind: route.accessKind,
        free: model.metadata?.free,
        badgeLabel: model.badgeLabel,
      })
    );
  });
}

export function countVerifiedOpenCodeDashboardModels(provider: CliProviderStatus): number {
  return new Set(
    (provider.modelCatalog?.models ?? [])
      .filter((model) => model.metadata?.opencode?.proofState === 'verified')
      .map((model) => model.launchModel)
  ).size;
}

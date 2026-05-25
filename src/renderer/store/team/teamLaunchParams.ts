import { extractProviderScopedBaseModel } from '@renderer/utils/teamModelContext';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';

import type {
  EffortLevel,
  TeamCreateRequest,
  TeamFastMode,
  TeamProviderId,
} from '@shared/types';

/** Per-team launch parameters shown in the header badge. */
export interface TeamLaunchParams {
  providerId?: TeamProviderId;
  providerBackendId?: string;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  limitContext?: boolean;
}

export function extractBaseModel(
  raw?: string,
  providerId?: TeamProviderId
): string | undefined {
  return extractProviderScopedBaseModel(raw, providerId);
}

export function buildLaunchParamsFromRuntimeRequest(
  request: Pick<
    TeamCreateRequest,
    'providerId' | 'providerBackendId' | 'model' | 'effort' | 'fastMode' | 'limitContext'
  >,
  fallback?: TeamLaunchParams
): TeamLaunchParams {
  const providerId = request.providerId ?? fallback?.providerId ?? 'anthropic';
  const providerChanged =
    request.providerId != null &&
    fallback?.providerId != null &&
    request.providerId !== fallback.providerId;
  const hasModel = Object.hasOwn(request, 'model');
  const baseModel =
    hasModel && typeof request.model === 'string'
      ? extractBaseModel(request.model, providerId)
      : undefined;
  const rawProviderBackendId = Object.hasOwn(request, 'providerBackendId')
    ? request.providerBackendId
    : providerChanged
      ? undefined
      : fallback?.providerBackendId;
  return {
    providerId,
    providerBackendId: migrateProviderBackendId(providerId, rawProviderBackendId),
    model: hasModel
      ? baseModel || 'default'
      : (providerChanged ? undefined : fallback?.model) || 'default',
    effort: Object.hasOwn(request, 'effort')
      ? request.effort
      : providerChanged
        ? undefined
        : fallback?.effort,
    fastMode: Object.hasOwn(request, 'fastMode')
      ? request.fastMode
      : providerChanged
        ? undefined
        : fallback?.fastMode,
    limitContext:
      typeof request.limitContext === 'boolean'
        ? request.limitContext
        : providerChanged
          ? false
          : (fallback?.limitContext ?? false),
  };
}

export function areTeamLaunchParamsEqual(
  left: TeamLaunchParams | undefined,
  right: TeamLaunchParams | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.providerId === right.providerId &&
    left.providerBackendId === right.providerBackendId &&
    left.model === right.model &&
    left.effort === right.effort &&
    left.fastMode === right.fastMode &&
    left.limitContext === right.limitContext
  );
}

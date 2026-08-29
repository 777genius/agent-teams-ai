import { extractProviderScopedBaseModel } from '@renderer/utils/teamModelContext';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import {
  migrateProviderBackendId,
  normalizePersistedProviderBackendId,
} from '@shared/utils/providerBackend';
import { normalizeTeamLeadRuntimeSelectionProvenance } from '@shared/utils/teamMemberRuntimeSelectionProvenance';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type {
  EffortLevel,
  TeamCreateRequest,
  TeamFastMode,
  TeamLeadRuntimeSelectionProvenance,
  TeamProviderId,
} from '@shared/types';
import type { ProviderBackendMigrationSource } from '@shared/utils/providerBackend';

const TEAM_LAUNCH_PARAMS_STORAGE_VERSION = 1 as const;

/** Per-team launch parameters shown in the header badge. */
export interface TeamLaunchParams {
  providerId?: TeamProviderId;
  providerBackendId?: string;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  limitContext?: boolean;
  leadRuntimeSelectionProvenance?: TeamLeadRuntimeSelectionProvenance;
}

export interface LeadRuntimeLaunchSettings {
  model: string | null;
  effort: EffortLevel | null;
}

interface TeamLaunchParamsStorageEnvelope {
  version: typeof TEAM_LAUNCH_PARAMS_STORAGE_VERSION;
  params: TeamLaunchParams;
}

const VERSIONED_ENVELOPE_FIELDS = new Set(['version', 'params']);
const LAUNCH_PARAM_FIELDS = new Set([
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'limitContext',
  'leadRuntimeSelectionProvenance',
]);

function hasOnlyFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function parseVersionedLaunchParams(value: unknown): TeamLaunchParams | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const params = value as Record<string, unknown>;
  if (!hasOnlyFields(params, LAUNCH_PARAM_FIELDS)) return null;

  const providerId =
    params.providerId === undefined
      ? undefined
      : normalizeOptionalTeamProviderId(params.providerId);
  if (params.providerId !== undefined && !providerId) return null;
  if (params.model !== undefined && typeof params.model !== 'string') return null;
  if (params.effort !== undefined && !isTeamEffortLevel(params.effort)) return null;
  if (
    params.fastMode !== undefined &&
    params.fastMode !== 'inherit' &&
    params.fastMode !== 'on' &&
    params.fastMode !== 'off'
  ) {
    return null;
  }
  if (params.limitContext !== undefined && typeof params.limitContext !== 'boolean') return null;
  if (
    params.leadRuntimeSelectionProvenance !== undefined &&
    !normalizeTeamLeadRuntimeSelectionProvenance(params.leadRuntimeSelectionProvenance)
  ) {
    return null;
  }
  if (params.providerBackendId !== undefined) {
    if (typeof params.providerBackendId !== 'string' || !providerId) return null;
    const normalizedBackendId = migrateProviderBackendId(
      providerId,
      params.providerBackendId,
      'explicit-selection'
    );
    if (!normalizedBackendId || normalizedBackendId !== params.providerBackendId.trim())
      return null;
  }

  return normalizeStoredLaunchParams(params as TeamLaunchParams, 'explicit-selection');
}

function parseLegacyLaunchParams(record: Record<string, unknown>): TeamLaunchParams {
  const providerId = normalizeOptionalTeamProviderId(record.providerId);
  const params: TeamLaunchParams = {
    providerId,
    providerBackendId:
      typeof record.providerBackendId === 'string' ? record.providerBackendId : undefined,
    model: typeof record.model === 'string' ? record.model : undefined,
    effort: isTeamEffortLevel(record.effort) ? record.effort : undefined,
    fastMode:
      record.fastMode === 'inherit' || record.fastMode === 'on' || record.fastMode === 'off'
        ? record.fastMode
        : undefined,
    limitContext: typeof record.limitContext === 'boolean' ? record.limitContext : undefined,
    leadRuntimeSelectionProvenance: normalizeTeamLeadRuntimeSelectionProvenance(
      record.leadRuntimeSelectionProvenance
    ),
  };
  return normalizeStoredLaunchParams(params, 'legacy-storage');
}

function normalizeStoredLaunchParams(
  params: TeamLaunchParams,
  source: ProviderBackendMigrationSource
): TeamLaunchParams {
  const providerId = params.providerId ?? 'anthropic';
  return {
    ...params,
    providerId,
    providerBackendId: normalizePersistedProviderBackendId(
      providerId,
      params.providerBackendId,
      source === 'explicit-selection' ? 'current-version' : 'legacy-unversioned'
    ),
  };
}

export function parseStoredTeamLaunchParams(raw: string): TeamLaunchParams | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version === TEAM_LAUNCH_PARAMS_STORAGE_VERSION) {
    if (!hasOnlyFields(record, VERSIONED_ENVELOPE_FIELDS)) return null;
    return parseVersionedLaunchParams(record.params);
  }
  if (record.version !== undefined) return null;
  return parseLegacyLaunchParams(record);
}

export function extractBaseModel(raw?: string, providerId?: TeamProviderId): string | undefined {
  return extractProviderScopedBaseModel(raw, providerId);
}

export function buildLaunchParamsFromRuntimeRequest(
  request: Pick<
    TeamCreateRequest,
    | 'providerId'
    | 'providerBackendId'
    | 'model'
    | 'effort'
    | 'fastMode'
    | 'limitContext'
    | 'leadRuntimeSelectionProvenance'
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
    providerBackendId: migrateProviderBackendId(
      providerId,
      rawProviderBackendId,
      'explicit-selection'
    ),
    model:
      request.leadRuntimeSelectionProvenance?.model === 'default'
        ? 'default'
        : hasModel
          ? baseModel || 'default'
          : (providerChanged ? undefined : fallback?.model) || 'default',
    effort:
      request.leadRuntimeSelectionProvenance?.effort === 'default'
        ? undefined
        : Object.hasOwn(request, 'effort')
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
    leadRuntimeSelectionProvenance:
      request.leadRuntimeSelectionProvenance ??
      (providerChanged ? undefined : fallback?.leadRuntimeSelectionProvenance),
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
    left.limitContext === right.limitContext &&
    JSON.stringify(left.leadRuntimeSelectionProvenance) ===
      JSON.stringify(right.leadRuntimeSelectionProvenance)
  );
}

export function applyLeadRuntimeSettingsToLaunchParams(
  current: TeamLaunchParams | undefined,
  settings: LeadRuntimeLaunchSettings
): TeamLaunchParams | undefined {
  if (!current) return undefined;
  return {
    ...current,
    model: extractBaseModel(settings.model ?? undefined, current.providerId) ?? 'default',
    effort: settings.effort ?? undefined,
    leadRuntimeSelectionProvenance: {
      version: 1,
      providerBackendId:
        current.leadRuntimeSelectionProvenance?.providerBackendId === 'explicit'
          ? 'explicit'
          : 'default',
      model: settings.model ? 'explicit' : 'default',
      effort: settings.effort ? 'explicit' : 'default',
    },
  };
}

export function saveTeamLaunchParams(teamName: string, params: TeamLaunchParams): void {
  try {
    const envelope: TeamLaunchParamsStorageEnvelope = {
      version: TEAM_LAUNCH_PARAMS_STORAGE_VERSION,
      params: normalizeStoredLaunchParams(params, 'explicit-selection'),
    };
    localStorage.setItem(`team:launchParams:${teamName}`, JSON.stringify(envelope));
  } catch {
    // Best-effort renderer persistence; main metadata remains authoritative.
  }
}

import type { MemberSpawnStatusEntry } from '@shared/types';

export type TeamProvisioningBootstrapHeartbeatFreshness =
  | 'not_confirmed'
  | 'fresh'
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'future_timestamp'
  | 'stale';

export type TeamProvisioningRuntimeStatusEvidence = Pick<
  MemberSpawnStatusEntry,
  | 'bootstrapConfirmed'
  | 'launchState'
  | 'lastHeartbeatAt'
  | 'pendingPermissionRequestIds'
  | 'updatedAt'
>;

export interface TeamProvisioningBootstrapEvidence {
  rawBootstrapConfirmed: boolean;
  bootstrapConfirmed: boolean;
  permissionBlocked: boolean;
  heartbeatAt?: string;
  heartbeatFreshness: TeamProvisioningBootstrapHeartbeatFreshness;
  runtimeDiagnostic?: string;
  diagnostic?: string;
}

const DEFAULT_HEARTBEAT_STALE_AFTER_MS = 120_000;
const ISO_SECOND_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/;
const ISO_FRACTIONAL_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{1,9}(Z|([+-])(\d{2}):(\d{2}))$/;

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseIsoTimestampMs(value: string): number | undefined {
  const match =
    ISO_SECOND_TIMESTAMP_PATTERN.exec(value) ?? ISO_FRACTIONAL_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return undefined;
  }

  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) {
    return undefined;
  }

  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  const offsetDirection = match[8] === '-' ? -1 : 1;
  const localTimestamp = new Date(
    timestampMs + offsetDirection * (offsetHours * 60 + offsetMinutes) * 60_000
  );
  const expectedComponents = match.slice(1, 7).map(Number);
  const actualComponents = [
    localTimestamp.getUTCFullYear(),
    localTimestamp.getUTCMonth() + 1,
    localTimestamp.getUTCDate(),
    localTimestamp.getUTCHours(),
    localTimestamp.getUTCMinutes(),
    localTimestamp.getUTCSeconds(),
  ];
  return actualComponents.every((component, index) => component === expectedComponents[index])
    ? timestampMs
    : undefined;
}

export function hasTeamProvisioningRuntimePermissionBlock(
  ...sources: ReadonlyArray<
    | Pick<TeamProvisioningRuntimeStatusEvidence, 'launchState' | 'pendingPermissionRequestIds'>
    | null
    | undefined
  >
): boolean {
  return sources.some(
    (source) =>
      source?.launchState === 'runtime_pending_permission' ||
      (source?.pendingPermissionRequestIds?.length ?? 0) > 0
  );
}

function buildUnfreshHeartbeatDiagnostic(
  freshness: Exclude<TeamProvisioningBootstrapHeartbeatFreshness, 'not_confirmed' | 'fresh'>
): Pick<TeamProvisioningBootstrapEvidence, 'runtimeDiagnostic' | 'diagnostic'> {
  switch (freshness) {
    case 'missing_timestamp':
      return {
        runtimeDiagnostic: 'runtime heartbeat timestamp is missing',
        diagnostic: 'bootstrap evidence exists, but the heartbeat timestamp is missing',
      };
    case 'invalid_timestamp':
      return {
        runtimeDiagnostic: 'runtime heartbeat timestamp is invalid',
        diagnostic: 'bootstrap evidence exists, but the heartbeat timestamp is invalid',
      };
    case 'future_timestamp':
      return {
        runtimeDiagnostic: 'runtime heartbeat timestamp is in the future',
        diagnostic: 'bootstrap evidence exists, but the heartbeat timestamp is in the future',
      };
    case 'stale':
      return {
        runtimeDiagnostic: 'runtime heartbeat is stale',
        diagnostic: 'bootstrap evidence exists, but the heartbeat is stale',
      };
  }
}

export function readTeamProvisioningBootstrapEvidence(params: {
  status: TeamProvisioningRuntimeStatusEvidence | null | undefined;
  nowIso: string;
  heartbeatStaleAfterMs?: number;
}): TeamProvisioningBootstrapEvidence {
  const rawBootstrapConfirmed =
    params.status?.bootstrapConfirmed === true || params.status?.launchState === 'confirmed_alive';
  const permissionBlocked = hasTeamProvisioningRuntimePermissionBlock(params.status);
  if (!rawBootstrapConfirmed) {
    return {
      rawBootstrapConfirmed: false,
      bootstrapConfirmed: false,
      permissionBlocked,
      heartbeatFreshness: 'not_confirmed',
    };
  }

  const heartbeatAt = nonEmptyString(params.status?.lastHeartbeatAt ?? params.status?.updatedAt);
  let heartbeatFreshness: Exclude<TeamProvisioningBootstrapHeartbeatFreshness, 'not_confirmed'>;
  if (!heartbeatAt) {
    heartbeatFreshness = 'missing_timestamp';
  } else {
    const heartbeatMs = parseIsoTimestampMs(heartbeatAt);
    const nowMs = parseIsoTimestampMs(params.nowIso);
    const staleAfterMs = params.heartbeatStaleAfterMs ?? DEFAULT_HEARTBEAT_STALE_AFTER_MS;
    if (
      heartbeatMs === undefined ||
      nowMs === undefined ||
      !Number.isFinite(staleAfterMs) ||
      staleAfterMs < 0
    ) {
      heartbeatFreshness = 'invalid_timestamp';
    } else if (heartbeatMs > nowMs) {
      heartbeatFreshness = 'future_timestamp';
    } else if (nowMs - heartbeatMs > staleAfterMs) {
      heartbeatFreshness = 'stale';
    } else {
      heartbeatFreshness = 'fresh';
    }
  }

  const bootstrapConfirmed = heartbeatFreshness === 'fresh' && !permissionBlocked;
  const unfreshDiagnostic =
    heartbeatFreshness === 'fresh'
      ? undefined
      : buildUnfreshHeartbeatDiagnostic(heartbeatFreshness);
  return {
    rawBootstrapConfirmed: true,
    bootstrapConfirmed,
    permissionBlocked,
    ...(heartbeatAt ? { heartbeatAt } : {}),
    heartbeatFreshness,
    ...unfreshDiagnostic,
  };
}

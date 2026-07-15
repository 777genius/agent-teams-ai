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
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME_PATTERN = /^\d{2}:\d{2}:\d{2}$/;
const ISO_FRACTION_PATTERN = /^\d{1,9}$/;
const ISO_OFFSET_PATTERN = /^[+-]\d{2}:?\d{2}$/;

interface NormalizedIsoTimestamp {
  value: string;
  offsetMinutes: number;
  expectedComponents: readonly number[];
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeIsoTimestamp(value: string): NormalizedIsoTimestamp | undefined {
  const separator = value.at(10);
  if (separator !== 'T' && separator !== ' ') {
    return undefined;
  }

  let dateTime = value;
  let offset = '';
  if (value.endsWith('Z')) {
    dateTime = value.slice(0, -1);
  } else {
    const offsetIndex = Math.max(value.lastIndexOf('+'), value.lastIndexOf('-'));
    if (offsetIndex > 10) {
      dateTime = value.slice(0, offsetIndex);
      offset = value.slice(offsetIndex);
    }
  }

  const date = dateTime.slice(0, 10);
  const time = dateTime.slice(11);
  const timeParts = time.split('.');
  if (
    !ISO_DATE_PATTERN.test(date) ||
    !ISO_TIME_PATTERN.test(timeParts[0]) ||
    timeParts.length > 2 ||
    (timeParts.length === 2 && !ISO_FRACTION_PATTERN.test(timeParts[1]))
  ) {
    return undefined;
  }

  let normalizedOffset = 'Z';
  let offsetMinutes = 0;
  if (offset) {
    if (!ISO_OFFSET_PATTERN.test(offset)) {
      return undefined;
    }
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinuteComponent = Number(offset.slice(-2));
    if (offsetHours > 23 || offsetMinuteComponent > 59) {
      return undefined;
    }
    const offsetDirection = offset.startsWith('-') ? -1 : 1;
    offsetMinutes = offsetDirection * (offsetHours * 60 + offsetMinuteComponent);
    normalizedOffset = `${offset.slice(0, 3)}:${offset.slice(-2)}`;
  }

  return {
    value: `${date}T${time}${normalizedOffset}`,
    offsetMinutes,
    expectedComponents: [
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)),
      Number(date.slice(8, 10)),
      Number(time.slice(0, 2)),
      Number(time.slice(3, 5)),
      Number(time.slice(6, 8)),
    ],
  };
}

function parseIsoTimestampMs(value: string): number | undefined {
  const normalized = normalizeIsoTimestamp(value);
  if (!normalized) {
    return undefined;
  }

  const timestampMs = Date.parse(normalized.value);
  if (!Number.isFinite(timestampMs)) {
    return undefined;
  }

  const localTimestamp = new Date(timestampMs + normalized.offsetMinutes * 60_000);
  const actualComponents = [
    localTimestamp.getUTCFullYear(),
    localTimestamp.getUTCMonth() + 1,
    localTimestamp.getUTCDate(),
    localTimestamp.getUTCHours(),
    localTimestamp.getUTCMinutes(),
    localTimestamp.getUTCSeconds(),
  ];
  return actualComponents.every(
    (component, index) => component === normalized.expectedComponents[index]
  )
    ? timestampMs
    : undefined;
}

export function hasTeamProvisioningRuntimePermissionBlock(
  ...sources: readonly (
    | Pick<TeamProvisioningRuntimeStatusEvidence, 'launchState' | 'pendingPermissionRequestIds'>
    | null
    | undefined
  )[]
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

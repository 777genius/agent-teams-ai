import type {
  MemberLaunchState,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimePidSource,
} from '@shared/types';

export interface MemberLaunchDiagnosticsPayload {
  teamName?: string;
  runId?: string;
  memberName: string;
  launchState?: MemberLaunchState;
  spawnStatus?: MemberSpawnStatus;
  livenessKind?: TeamAgentRuntimeLivenessKind;
  livenessSource?: MemberSpawnLivenessSource;
  pid?: number;
  pidSource?: TeamAgentRuntimePidSource;
  paneId?: string;
  panePid?: number;
  paneCurrentCommand?: string;
  processCommand?: string;
  runtimePid?: number;
  runtimeSessionId?: string;
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  diagnostics?: string[];
  updatedAt?: string;
}

const MAX_DIAGNOSTIC_STRING_LENGTH = 500;
const MAX_DIAGNOSTIC_ITEMS = 20;
const SECRET_FLAG_PATTERN =
  /(--(?:api-key|token|password|secret|authorization|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;

function boundedString(
  value: string | undefined,
  maxLength = MAX_DIAGNOSTIC_STRING_LENGTH
): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  const redacted = trimmed.replace(SECRET_FLAG_PATTERN, '$1[redacted]');
  return redacted.length > maxLength
    ? `${redacted.slice(0, Math.max(0, maxLength - 3))}...`
    : redacted;
}

function boundedNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function uniqueDiagnostics(
  ...groups: Array<readonly (string | undefined)[] | undefined>
): string[] | undefined {
  const seen = new Set<string>();
  const diagnostics: string[] = [];
  for (const group of groups) {
    for (const item of group ?? []) {
      const normalized = boundedString(item);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      diagnostics.push(normalized);
      if (diagnostics.length >= MAX_DIAGNOSTIC_ITEMS) {
        return diagnostics;
      }
    }
  }
  return diagnostics.length > 0 ? diagnostics : undefined;
}

export function buildMemberLaunchDiagnosticsPayload(params: {
  teamName?: string | null;
  runId?: string | null;
  memberName: string;
  spawnStatus?: MemberSpawnStatus;
  launchState?: MemberLaunchState;
  livenessSource?: MemberSpawnLivenessSource;
  spawnEntry?: MemberSpawnStatusEntry;
  runtimeEntry?: TeamAgentRuntimeEntry;
}): MemberLaunchDiagnosticsPayload {
  const spawnEntry = params.spawnEntry;
  const runtimeEntry = params.runtimeEntry;
  const runtimeDiagnostic =
    boundedString(spawnEntry?.runtimeDiagnostic) ??
    boundedString(runtimeEntry?.runtimeDiagnostic) ??
    boundedString(spawnEntry?.hardFailureReason) ??
    boundedString(spawnEntry?.error);
  const diagnostics = uniqueDiagnostics(
    runtimeDiagnostic ? [runtimeDiagnostic] : undefined,
    spawnEntry?.hardFailureReason ? [spawnEntry.hardFailureReason] : undefined,
    spawnEntry?.error ? [spawnEntry.error] : undefined,
    runtimeEntry?.diagnostics
  );
  const runId = boundedString(params.runId ?? undefined);

  return {
    ...(params.teamName ? { teamName: params.teamName } : {}),
    ...(runId ? { runId } : {}),
    memberName: params.memberName,
    ...((spawnEntry?.launchState ?? params.launchState)
      ? { launchState: spawnEntry?.launchState ?? params.launchState }
      : {}),
    ...((spawnEntry?.status ?? params.spawnStatus)
      ? { spawnStatus: spawnEntry?.status ?? params.spawnStatus }
      : {}),
    ...((spawnEntry?.livenessKind ?? runtimeEntry?.livenessKind)
      ? { livenessKind: spawnEntry?.livenessKind ?? runtimeEntry?.livenessKind }
      : {}),
    ...((spawnEntry?.livenessSource ?? params.livenessSource)
      ? { livenessSource: spawnEntry?.livenessSource ?? params.livenessSource }
      : {}),
    ...(boundedNumber(runtimeEntry?.pid) ? { pid: boundedNumber(runtimeEntry?.pid) } : {}),
    ...(runtimeEntry?.pidSource ? { pidSource: runtimeEntry.pidSource } : {}),
    ...(boundedString(runtimeEntry?.paneId) ? { paneId: boundedString(runtimeEntry?.paneId) } : {}),
    ...(boundedNumber(runtimeEntry?.panePid)
      ? { panePid: boundedNumber(runtimeEntry?.panePid) }
      : {}),
    ...(boundedString(runtimeEntry?.paneCurrentCommand)
      ? { paneCurrentCommand: boundedString(runtimeEntry?.paneCurrentCommand) }
      : {}),
    ...(boundedString(runtimeEntry?.processCommand)
      ? { processCommand: boundedString(runtimeEntry?.processCommand) }
      : {}),
    ...(boundedNumber(runtimeEntry?.runtimePid)
      ? { runtimePid: boundedNumber(runtimeEntry?.runtimePid) }
      : {}),
    ...(boundedString(runtimeEntry?.runtimeSessionId)
      ? { runtimeSessionId: boundedString(runtimeEntry?.runtimeSessionId) }
      : {}),
    ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
    ...((spawnEntry?.runtimeDiagnosticSeverity ?? runtimeEntry?.runtimeDiagnosticSeverity)
      ? {
          runtimeDiagnosticSeverity:
            spawnEntry?.runtimeDiagnosticSeverity ?? runtimeEntry?.runtimeDiagnosticSeverity,
        }
      : {}),
    ...(diagnostics ? { diagnostics } : {}),
    ...(boundedString(spawnEntry?.updatedAt ?? runtimeEntry?.updatedAt)
      ? { updatedAt: boundedString(spawnEntry?.updatedAt ?? runtimeEntry?.updatedAt) }
      : {}),
  };
}

export function hasMemberLaunchDiagnosticsDetails(
  payload: MemberLaunchDiagnosticsPayload
): boolean {
  const weakLiveness =
    payload.livenessKind === 'runtime_process_candidate' ||
    payload.livenessKind === 'permission_blocked' ||
    payload.livenessKind === 'shell_only' ||
    payload.livenessKind === 'registered_only' ||
    payload.livenessKind === 'stale_metadata' ||
    payload.livenessKind === 'not_found';
  return Boolean(
    (payload.launchState && payload.launchState !== 'confirmed_alive') ||
    (payload.spawnStatus && payload.spawnStatus !== 'online') ||
    weakLiveness ||
    payload.runtimeDiagnostic ||
    payload.diagnostics?.length
  );
}

export function hasMemberLaunchDiagnosticsError(payload: MemberLaunchDiagnosticsPayload): boolean {
  return Boolean(
    payload.spawnStatus === 'error' ||
    payload.launchState === 'failed_to_start' ||
    payload.runtimeDiagnosticSeverity === 'error'
  );
}

export function getMemberLaunchDiagnosticsErrorMessage(
  payload: MemberLaunchDiagnosticsPayload
): string | undefined {
  if (!hasMemberLaunchDiagnosticsError(payload)) {
    return undefined;
  }
  return payload.runtimeDiagnostic ?? payload.diagnostics?.[0] ?? 'Launch failed';
}

export function formatMemberLaunchDiagnosticsPayload(
  payload: MemberLaunchDiagnosticsPayload
): string {
  return JSON.stringify(payload, null, 2);
}

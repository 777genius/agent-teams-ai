import type {
  MemberLaunchState,
  MemberRuntimeAdvisory,
  MemberSpawnStatus,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeLivenessKind,
} from '@shared/types';

const OPENCODE_APP_MCP_CONNECTIVITY_NEEDLES = [
  'attach_failed',
  'readiness check failed',
  'unable to connect',
] as const;

const OPENCODE_NON_HEALTHY_LIVENESS_KINDS = new Set<TeamAgentRuntimeLivenessKind>([
  'runtime_process_candidate',
  'permission_blocked',
  'shell_only',
  'registered_only',
  'stale_metadata',
  'not_found',
]);

function hasOpenCodeAppMcpConnectivityEvidence(values: readonly (string | undefined)[]): boolean {
  const text = values
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n')
    .toLowerCase();
  return (
    text.includes('opencode app mcp') &&
    OPENCODE_APP_MCP_CONNECTIVITY_NEEDLES.some((needle) => text.includes(needle))
  );
}

export function isHealthyOpenCodeAppMcpConnectivityAdvisory(input: {
  providerId?: string;
  runtimeAdvisory?: MemberRuntimeAdvisory;
  runtimeAdvisoryLabel?: string | null;
  runtimeAdvisoryTitle?: string;
  runtimeAdvisoryMessage?: string;
  spawnStatus?: MemberSpawnStatus;
  launchState?: MemberLaunchState;
  runtimeAlive?: boolean;
  bootstrapConfirmed?: boolean;
  agentToolAccepted?: boolean;
  hardFailure?: boolean;
  livenessKind?: TeamAgentRuntimeLivenessKind;
  runtimeEntry?: TeamAgentRuntimeEntry;
}): boolean {
  const livenessKind = input.livenessKind ?? input.runtimeEntry?.livenessKind;
  return (
    input.providerId === 'opencode' &&
    input.runtimeAdvisory?.kind === 'api_error' &&
    input.runtimeAdvisory.reasonCode === 'network_error' &&
    hasOpenCodeAppMcpConnectivityEvidence([
      input.runtimeAdvisoryTitle,
      input.runtimeAdvisoryLabel ?? undefined,
      input.runtimeAdvisoryMessage,
      input.runtimeAdvisory.message,
    ]) &&
    input.spawnStatus === 'online' &&
    input.launchState === 'confirmed_alive' &&
    input.runtimeAlive === true &&
    input.bootstrapConfirmed === true &&
    input.agentToolAccepted === true &&
    input.hardFailure !== true &&
    input.runtimeEntry?.alive !== false &&
    (livenessKind == null || !OPENCODE_NON_HEALTHY_LIVENESS_KINDS.has(livenessKind))
  );
}

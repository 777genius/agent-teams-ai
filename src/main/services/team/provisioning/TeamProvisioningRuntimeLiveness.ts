import {
  type ResolvedTeamMemberRuntimeLiveness,
  resolveTeamMemberRuntimeLiveness,
  type ResolveTeamMemberRuntimeLivenessInput,
} from '../TeamRuntimeLivenessResolver';

import { readTeamProvisioningBootstrapEvidence } from './TeamProvisioningRuntimeEvidenceReader';

function suppressUntrustedBootstrapConfirmation(
  status: ResolveTeamMemberRuntimeLivenessInput['trackedSpawnStatus']
): ResolveTeamMemberRuntimeLivenessInput['trackedSpawnStatus'] {
  if (!status) {
    return undefined;
  }
  return {
    ...status,
    bootstrapConfirmed: false,
    launchState:
      status.launchState === 'confirmed_alive' ? 'runtime_pending_bootstrap' : status.launchState,
  };
}

export function resolveTeamProvisioningRuntimeLiveness(
  input: ResolveTeamMemberRuntimeLivenessInput
): ResolvedTeamMemberRuntimeLiveness {
  const bootstrapEvidence = readTeamProvisioningBootstrapEvidence({
    status: input.trackedSpawnStatus,
    nowIso: input.nowIso,
  });
  const shouldSuppressRawConfirmation =
    bootstrapEvidence.rawBootstrapConfirmed &&
    !bootstrapEvidence.bootstrapConfirmed &&
    !bootstrapEvidence.permissionBlocked;
  const resolved = resolveTeamMemberRuntimeLiveness({
    ...input,
    trackedSpawnStatus: shouldSuppressRawConfirmation
      ? suppressUntrustedBootstrapConfirmation(input.trackedSpawnStatus)
      : input.trackedSpawnStatus,
  });

  if (
    !shouldSuppressRawConfirmation ||
    (resolved.livenessKind !== 'registered_only' && resolved.livenessKind !== 'not_found')
  ) {
    return resolved;
  }

  const runtimeDiagnostic =
    bootstrapEvidence.runtimeDiagnostic ?? 'runtime heartbeat timestamp is invalid';
  const diagnostic = bootstrapEvidence.diagnostic ?? runtimeDiagnostic;
  return {
    ...resolved,
    alive: false,
    livenessKind: 'registered_only',
    pidSource: 'runtime_bootstrap',
    ...(bootstrapEvidence.heartbeatAt ? { runtimeLastSeenAt: bootstrapEvidence.heartbeatAt } : {}),
    runtimeDiagnostic,
    runtimeDiagnosticSeverity: 'warning',
    diagnostics: [...new Set([...resolved.diagnostics, diagnostic])],
  };
}

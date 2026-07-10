import type {
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimePidSource,
} from '@shared/types';

export interface RuntimeProjectionSnapshotMemberLivenessInput {
  liveAlive?: boolean;
  liveLivenessKind?: TeamAgentRuntimeLivenessKind;
  livePidSource?: TeamAgentRuntimePidSource;
  liveRuntimeDiagnostic?: string;
  liveRuntimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  spawnRuntimeDiagnostic?: string;
  spawnRuntimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  confirmedRuntimeBootstrapAlive?: boolean;
  confirmedRuntimeBootstrapDiagnostic?: string;
  confirmedRuntimeBootstrapDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  confirmedSpawnRuntimeFallback?: boolean;
  keepConfirmedSpawnRuntimeDiagnostic?: boolean;
}

export interface RuntimeProjectionSnapshotMemberLivenessFields {
  alive: boolean;
  livenessKind?: TeamAgentRuntimeLivenessKind;
  pidSource?: TeamAgentRuntimePidSource;
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const DEFAULT_RUNTIME_BOOTSTRAP_DIAGNOSTIC =
  'bootstrap confirmed; runtime host/session evidence present.';

export function projectRuntimeSnapshotMemberLivenessFields(
  input: RuntimeProjectionSnapshotMemberLivenessInput
): RuntimeProjectionSnapshotMemberLivenessFields {
  const confirmedRuntimeBootstrapAlive = input.confirmedRuntimeBootstrapAlive === true;
  const confirmedSpawnRuntimeFallback = input.confirmedSpawnRuntimeFallback === true;
  const strongLiveRuntimeEvidence =
    input.liveLivenessKind === 'runtime_process' ||
    input.liveLivenessKind === 'confirmed_bootstrap';
  const runtimeBootstrapConfirmed = confirmedRuntimeBootstrapAlive && !strongLiveRuntimeEvidence;
  const confirmedRuntimeBootstrapDiagnostic = nonEmptyString(
    input.confirmedRuntimeBootstrapDiagnostic
  );
  const spawnRuntimeDiagnostic = nonEmptyString(input.spawnRuntimeDiagnostic);
  const liveRuntimeDiagnostic = nonEmptyString(input.liveRuntimeDiagnostic);

  const alive =
    input.liveAlive === true || confirmedRuntimeBootstrapAlive || confirmedSpawnRuntimeFallback;
  const livenessKind = runtimeBootstrapConfirmed
    ? 'confirmed_bootstrap'
    : confirmedSpawnRuntimeFallback
      ? 'confirmed_bootstrap'
      : input.liveLivenessKind;
  const pidSource =
    (runtimeBootstrapConfirmed || confirmedSpawnRuntimeFallback) &&
    (input.livePidSource === 'persisted_metadata' || input.livePidSource == null)
      ? 'runtime_bootstrap'
      : input.livePidSource;
  const runtimeDiagnostic = runtimeBootstrapConfirmed
    ? (confirmedRuntimeBootstrapDiagnostic ?? DEFAULT_RUNTIME_BOOTSTRAP_DIAGNOSTIC)
    : confirmedSpawnRuntimeFallback
      ? input.keepConfirmedSpawnRuntimeDiagnostic === true && spawnRuntimeDiagnostic
        ? spawnRuntimeDiagnostic
        : 'bootstrap confirmed'
      : liveRuntimeDiagnostic;
  const runtimeDiagnosticSeverity = runtimeBootstrapConfirmed
    ? (input.confirmedRuntimeBootstrapDiagnosticSeverity ?? 'info')
    : confirmedSpawnRuntimeFallback
      ? input.keepConfirmedSpawnRuntimeDiagnostic === true
        ? (input.spawnRuntimeDiagnosticSeverity ?? input.liveRuntimeDiagnosticSeverity ?? 'info')
        : 'info'
      : input.liveRuntimeDiagnosticSeverity;

  return {
    alive,
    ...(livenessKind ? { livenessKind } : {}),
    ...(pidSource ? { pidSource } : {}),
    ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
    ...(runtimeDiagnosticSeverity ? { runtimeDiagnosticSeverity } : {}),
  };
}

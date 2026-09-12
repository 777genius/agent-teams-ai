import {
  type OpenCodeBridgeCommandName,
  type RuntimeStoreManifestEvidence,
  stableHash,
} from './OpenCodeBridgeCommandContract';

export function bindLifecycleManifest<TBody>(
  input: {
    command: OpenCodeBridgeCommandName;
    runId: string | null;
    teamName: string;
    laneId?: string | null;
    capabilitySnapshotId: string | null;
    body: TBody;
  },
  manifest: RuntimeStoreManifestEvidence
): { capabilitySnapshotId: string | null; body: TBody } {
  if (
    input.command !== 'opencode.stopTeam' &&
    input.command !== 'opencode.reconcileTeam' &&
    input.command !== 'opencode.sendMessage'
  ) {
    return { capabilitySnapshotId: input.capabilitySnapshotId, body: input.body };
  }
  const emptyStop =
    input.command === 'opencode.stopTeam' &&
    manifest.activeRunId === null &&
    manifest.capabilitySnapshotId === null &&
    input.capabilitySnapshotId === null &&
    Array.isArray(manifest.stopSessions) &&
    manifest.stopSessions.length === 0 &&
    manifest.sessionIdentityHash === stableHash([]);
  if (
    !emptyStop &&
    (!input.runId || manifest.activeRunId !== input.runId || !manifest.capabilitySnapshotId)
  ) {
    throw new Error(
      'OpenCode lifecycle command requires the exact persisted lane run and capability snapshot'
    );
  }
  const capabilitySnapshotId = manifest.capabilitySnapshotId;
  if (capabilitySnapshotId === undefined) {
    throw new Error('OpenCode lifecycle command requires a persisted lane capability snapshot');
  }
  const bodySnapshotId = isRecord(input.body) ? input.body.expectedCapabilitySnapshotId : null;
  if (
    (input.capabilitySnapshotId !== null && input.capabilitySnapshotId !== capabilitySnapshotId) ||
    (bodySnapshotId != null && bodySnapshotId !== capabilitySnapshotId)
  ) {
    throw new Error(
      'OpenCode lifecycle capability snapshot does not match the persisted lane manifest'
    );
  }
  if (
    !isRecord(input.body) ||
    input.body.runId !== input.runId ||
    input.body.teamId !== input.teamName ||
    input.body.laneId !== (input.laneId ?? 'primary') ||
    (input.body.allowEmptyLaneStop === true && !emptyStop)
  ) {
    throw new Error('OpenCode lifecycle command body does not match its persisted lane identity');
  }
  return {
    capabilitySnapshotId,
    body: {
      ...input.body,
      expectedCapabilitySnapshotId: capabilitySnapshotId,
      ...(emptyStop ? { allowEmptyLaneStop: true } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

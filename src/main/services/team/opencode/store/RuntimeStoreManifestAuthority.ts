import type { RuntimeStoreManifest, RuntimeStoreWriteBatch } from './RuntimeStoreManifest';

type Authority = Pick<
  RuntimeStoreManifest,
  'activeRunId' | 'activeCapabilitySnapshotId' | 'activeBehaviorFingerprint'
>;

export function resolveActiveRunAuthority(
  manifest: RuntimeStoreManifest,
  input: {
    runId: string | null;
    capabilitySnapshotId?: string | null;
    behaviorFingerprint?: string | null;
    expectedRunId?: string;
  }
): Authority {
  const runId = input.runId?.trim() || null;
  const sameRun = manifest.activeRunId === runId;
  const capabilitySnapshotId =
    input.capabilitySnapshotId === undefined
      ? sameRun
        ? manifest.activeCapabilitySnapshotId
        : null
      : input.capabilitySnapshotId?.trim() || null;
  const behaviorFingerprint =
    input.behaviorFingerprint === undefined
      ? sameRun
        ? manifest.activeBehaviorFingerprint
        : null
      : input.behaviorFingerprint?.trim() || null;
  if (
    input.expectedRunId !== undefined &&
    (manifest.activeRunId !== input.expectedRunId ||
      runId !== input.expectedRunId ||
      (manifest.activeCapabilitySnapshotId !== null &&
        manifest.activeCapabilitySnapshotId !== capabilitySnapshotId) ||
      (manifest.activeBehaviorFingerprint !== null &&
        manifest.activeBehaviorFingerprint !== behaviorFingerprint))
  )
    throw new Error('OpenCode launch authority no longer matches the active lane run or binding');
  return {
    activeRunId: runId,
    activeCapabilitySnapshotId: capabilitySnapshotId,
    activeBehaviorFingerprint: behaviorFingerprint,
  };
}

export function resolveCommittedBatchAuthority(
  manifest: RuntimeStoreManifest,
  batch: Pick<
    RuntimeStoreWriteBatch,
    'runId' | 'capabilitySnapshotId' | 'behaviorFingerprint' | 'authorityMode'
  >
): Authority {
  if (batch.authorityMode === 'metadata-only') {
    if (!batch.runId || manifest.activeRunId !== batch.runId) {
      throw new Error('OpenCode metadata batch no longer matches the active lane run');
    }
    if (
      (batch.capabilitySnapshotId !== null &&
        batch.capabilitySnapshotId !== manifest.activeCapabilitySnapshotId) ||
      (batch.behaviorFingerprint !== null &&
        batch.behaviorFingerprint !== manifest.activeBehaviorFingerprint)
    ) {
      throw new Error('OpenCode metadata batch cannot publish launch authority');
    }
    return {
      activeRunId: batch.runId,
      activeCapabilitySnapshotId:
        manifest.activeRunId === batch.runId ? manifest.activeCapabilitySnapshotId : null,
      activeBehaviorFingerprint:
        manifest.activeRunId === batch.runId ? manifest.activeBehaviorFingerprint : null,
    };
  }
  return {
    activeRunId: batch.runId,
    activeCapabilitySnapshotId: batch.capabilitySnapshotId,
    activeBehaviorFingerprint: batch.behaviorFingerprint,
  };
}

export function isActiveRunOnlyWatermark(manifest: RuntimeStoreManifest): boolean {
  return (
    manifest.highWatermark > 0 &&
    manifest.entries.length === 0 &&
    manifest.lastCommittedBatchId === null
  );
}

export function resolveActiveRunWatermark(manifest: RuntimeStoreManifest): number {
  return isActiveRunOnlyWatermark(manifest) ? 0 : manifest.highWatermark;
}

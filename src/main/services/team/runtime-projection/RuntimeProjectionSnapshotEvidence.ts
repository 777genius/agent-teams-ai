export interface RuntimeProjectionBootstrapConfirmationEvidence {
  bootstrapConfirmed?: boolean;
  launchState?: string;
}

export interface RuntimeProjectionSnapshotBootstrapConfirmationEvidence {
  launch?: RuntimeProjectionBootstrapConfirmationEvidence;
  runtimeAdapter?: RuntimeProjectionBootstrapConfirmationEvidence;
  spawnStatus?: RuntimeProjectionBootstrapConfirmationEvidence;
}

export function hasRuntimeProjectionBootstrapConfirmationEvidence(
  evidence: RuntimeProjectionBootstrapConfirmationEvidence | undefined
): boolean {
  return evidence?.bootstrapConfirmed === true || evidence?.launchState === 'confirmed_alive';
}

export function hasRuntimeProjectionSnapshotBootstrapConfirmationEvidence(
  evidence: RuntimeProjectionSnapshotBootstrapConfirmationEvidence
): boolean {
  return (
    hasRuntimeProjectionBootstrapConfirmationEvidence(evidence.launch) ||
    hasRuntimeProjectionBootstrapConfirmationEvidence(evidence.runtimeAdapter) ||
    hasRuntimeProjectionBootstrapConfirmationEvidence(evidence.spawnStatus)
  );
}

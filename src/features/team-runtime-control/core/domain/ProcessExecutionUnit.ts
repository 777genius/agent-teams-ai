import type {
  CredentialExposureSet,
  ProcessExecutionUnit,
  SecretRefMetadata,
} from '../../contracts';

export function credentialRefKey(secretRef: SecretRefMetadata): string {
  return `${secretRef.secretRefId}\u0000${secretRef.secretClass}`;
}

export function credentialExposureSetsOverlap(
  left: CredentialExposureSet,
  right: CredentialExposureSet
): boolean {
  const leftKeys = new Set(left.secretRefs.map(credentialRefKey));
  return right.secretRefs.some((secretRef) => leftKeys.has(credentialRefKey(secretRef)));
}

export function isDedicatedExecutionUnit(unit: ProcessExecutionUnit): boolean {
  return unit.credentialIsolation === 'dedicated_execution_unit';
}

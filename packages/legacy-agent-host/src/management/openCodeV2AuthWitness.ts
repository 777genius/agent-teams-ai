import { ManagementCommandError } from './commandRecords.js';
import { deriveSecretFingerprint, SecretFingerprintError, secretFingerprintsEqual } from './secretFingerprint.js';
import type { OpenCodeV2CredentialProgress } from './openCodeV2CredentialRecord.js';
import type { SecretFingerprint, SecretFingerprintKdf } from './secretFingerprint.js';

/** Protect only the journal witness; captured/runtime identities keep their original bytes. */
export async function deriveOpenCodeV2AuthWitness(
  digest: string,
  original?: SecretFingerprintKdf,
): Promise<SecretFingerprint> {
  try {
    return await deriveSecretFingerprint({ kind: 'opencode-v2-auth-witness-v1', digest }, original);
  } catch (error) {
    if (error instanceof SecretFingerprintError)
      throw new ManagementCommandError(error.code === 'failed' ? 'held' : error.code);
    throw error;
  }
}

/** Only a validated markerless original uses the historical comparison, without a write. */
export async function matchesOpenCodeV2AuthWitness(
  digest: string,
  original: OpenCodeV2CredentialProgress,
): Promise<boolean> {
  if (original.authDigest === undefined) return false;
  const witness = original.authWitnessKdf === undefined
    ? digest : (await deriveOpenCodeV2AuthWitness(digest, original.authWitnessKdf)).fingerprint;
  return secretFingerprintsEqual(original.authDigest, witness);
}

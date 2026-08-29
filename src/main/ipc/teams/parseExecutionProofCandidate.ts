import type { AuthoritativeModelExecutionProof } from '@shared/types';

export function parseExecutionProofCandidate(
  value: unknown
):
  | { valid: true; value: AuthoritativeModelExecutionProof | undefined }
  | { valid: false; error: string } {
  if (value === undefined) return { valid: true, value: undefined };
  if (!value || typeof value !== 'object') {
    return { valid: false, error: 'executionProof must be an object when provided' };
  }
  const proof = value as Record<string, unknown>;
  if (
    typeof proof.authorityId !== 'string' ||
    proof.authorityId.trim().length === 0 ||
    typeof proof.generation !== 'number' ||
    !Number.isSafeInteger(proof.generation) ||
    proof.generation <= 0 ||
    typeof proof.completedAt !== 'string' ||
    typeof proof.expiresAt !== 'string' ||
    typeof proof.requestDigest !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(proof.requestDigest)
  ) {
    return { valid: false, error: 'executionProof is malformed' };
  }
  return {
    valid: true,
    value: {
      authorityId: proof.authorityId,
      generation: proof.generation,
      completedAt: proof.completedAt,
      expiresAt: proof.expiresAt,
      requestDigest: proof.requestDigest,
    },
  };
}

export type LegacyRuntimeOperation = 'status' | 'cancel' | 'stop' | 'recover';
export type LegacyRuntimeGenerationState =
  | 'active'
  | 'cancelling'
  | 'stopping'
  | 'recovering'
  | 'terminal';

export interface LegacyRuntimeGeneration {
  readonly generation: number;
  readonly state: LegacyRuntimeGenerationState;
}

export type LegacyRuntimeCutover =
  | {
      readonly mode: 'canonical';
      readonly revision: number;
    }
  | {
      readonly mode: 'legacy_drain';
      readonly revision: number;
      readonly candidates: readonly LegacyRuntimeGeneration[];
      readonly cleanupVerifiedGeneration: number | null;
    };

export type LegacyRuntimeAdmission =
  | { readonly status: 'admitted'; readonly generation: LegacyRuntimeGeneration }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'legacy_drain_active'
        | 'legacy_generation_ambiguous'
        | 'legacy_generation_mismatch';
    };

export function createCanonicalRuntimeCutover(revision = 1): LegacyRuntimeCutover {
  assertPositiveInteger(revision, 'legacy-runtime-cutover-revision-invalid');
  return Object.freeze({ mode: 'canonical', revision });
}

export function createLegacyRuntimeCutover(
  candidates: readonly LegacyRuntimeGeneration[],
  revision = 1
): LegacyRuntimeCutover {
  assertPositiveInteger(revision, 'legacy-runtime-cutover-revision-invalid');
  if (candidates.length === 0) {
    throw new TypeError('legacy-runtime-cutover-candidates-invalid');
  }
  const seen = new Set<number>();
  const parsed = candidates.map((candidate) => {
    assertPositiveInteger(candidate.generation, 'legacy-runtime-generation-invalid');
    if (
      !['active', 'cancelling', 'stopping', 'recovering', 'terminal'].includes(candidate.state) ||
      seen.has(candidate.generation)
    ) {
      throw new TypeError('legacy-runtime-generation-invalid');
    }
    seen.add(candidate.generation);
    return Object.freeze({ generation: candidate.generation, state: candidate.state });
  });
  parsed.sort((left, right) => left.generation - right.generation);
  return Object.freeze({
    mode: 'legacy_drain',
    revision,
    candidates: Object.freeze(parsed),
    cleanupVerifiedGeneration: null,
  });
}

export function admitCanonicalLaunch(
  cutover: LegacyRuntimeCutover
): { readonly status: 'admitted' } | LegacyRuntimeAdmission {
  if (cutover.mode === 'canonical') return Object.freeze({ status: 'admitted' });
  if (cutover.candidates.length !== 1) {
    return Object.freeze({
      status: 'rejected',
      reason: 'legacy_generation_ambiguous',
    });
  }
  return Object.freeze({ status: 'rejected', reason: 'legacy_drain_active' });
}

export function admitLegacyRuntimeOperation(
  cutover: LegacyRuntimeCutover,
  generation: number,
  _operation: LegacyRuntimeOperation
): LegacyRuntimeAdmission {
  assertPositiveInteger(generation, 'legacy-runtime-generation-invalid');
  if (cutover.mode === 'canonical') {
    return Object.freeze({ status: 'rejected', reason: 'legacy_generation_mismatch' });
  }
  if (cutover.candidates.length !== 1) {
    return Object.freeze({
      status: 'rejected',
      reason: 'legacy_generation_ambiguous',
    });
  }
  const candidate = cutover.candidates[0];
  if (candidate?.generation !== generation) {
    return Object.freeze({
      status: 'rejected',
      reason: 'legacy_generation_mismatch',
    });
  }
  return Object.freeze({ status: 'admitted', generation: candidate });
}

export function updateLegacyRuntimeGeneration(
  cutover: LegacyRuntimeCutover,
  generation: number,
  state: LegacyRuntimeGenerationState,
  cleanupVerified: boolean
): LegacyRuntimeCutover {
  const admitted = admitLegacyRuntimeOperation(cutover, generation, 'recover');
  if (admitted.status === 'rejected' || cutover.mode !== 'legacy_drain') {
    throw new TypeError(admitted.status === 'rejected' ? admitted.reason : 'legacy_drain_active');
  }
  const candidate = Object.freeze({ generation, state });
  return Object.freeze({
    mode: 'legacy_drain',
    revision: cutover.revision + 1,
    candidates: Object.freeze([candidate]),
    cleanupVerifiedGeneration:
      state === 'terminal' && cleanupVerified ? generation : cutover.cleanupVerifiedGeneration,
  });
}

export function completeLegacyRuntimeCutover(
  cutover: LegacyRuntimeCutover,
  generation: number
): LegacyRuntimeCutover {
  const admitted = admitLegacyRuntimeOperation(cutover, generation, 'recover');
  if (admitted.status === 'rejected' || cutover.mode !== 'legacy_drain') {
    throw new TypeError(admitted.status === 'rejected' ? admitted.reason : 'legacy_drain_active');
  }
  if (
    admitted.generation.state !== 'terminal' ||
    cutover.cleanupVerifiedGeneration !== generation
  ) {
    throw new TypeError('legacy-runtime-cleanup-unverified');
  }
  return createCanonicalRuntimeCutover(cutover.revision + 1);
}

function assertPositiveInteger(value: number, diagnostic: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(diagnostic);
}

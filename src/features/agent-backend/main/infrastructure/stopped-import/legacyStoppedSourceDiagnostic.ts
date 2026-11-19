import type { LegacyStoppedSourceDiagnosticBoundary } from './retainedLegacyOpenDiagnosticContract';

const boundaries = new WeakMap<object, LegacyStoppedSourceDiagnosticBoundary | undefined>();

/** Private observation on the original error; never mutate a source or error record. */
export function rememberLegacyStoppedSourceBoundary(
  error: object,
  boundary: LegacyStoppedSourceDiagnosticBoundary
): void {
  try {
    // A reused error cannot identify one describe call. Keep it ambiguous thereafter,
    // including when two callers defer observing the same original rejection.
    boundaries.set(error, boundaries.has(error) ? undefined : boundary);
  } catch {
    // Missing diagnostic data cannot replace the original refusal.
  }
}

export function readLegacyStoppedSourceBoundary(
  error: unknown
): LegacyStoppedSourceDiagnosticBoundary | undefined {
  return error && typeof error === 'object' ? boundaries.get(error) : undefined;
}

import { LEGACY_STOPPED_OWNER_FACT_NAMES } from './retainedLegacyOpenDiagnosticContract';

import type {
  LegacyStoppedOwnerFact,
  LegacyStoppedSourceDiagnosticBoundary,
} from './retainedLegacyOpenDiagnosticContract';

const boundaries = new WeakMap<object, LegacyStoppedSourceDiagnosticBoundary | undefined>();
const ownerFacts = new WeakMap<object, readonly LegacyStoppedOwnerFact[] | undefined>();

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

/** Observe the already-read vector only. Never call an owner or evaluate a counter accessor. */
export function rememberLegacyStoppedOwnerFacts(error: object, facts: unknown): void {
  try {
    const reused = ownerFacts.has(error);
    ownerFacts.set(error, undefined);
    if (reused || !facts || typeof facts !== 'object') return;
    const blocked: LegacyStoppedOwnerFact[] = [];
    for (const name of LEGACY_STOPPED_OWNER_FACT_NAMES) {
      const [group, key] = name.split('.');
      const parent = Object.getOwnPropertyDescriptor(facts, group);
      if (!parent || !('value' in parent) || !parent.value || typeof parent.value !== 'object')
        continue;
      const entry = Object.getOwnPropertyDescriptor(parent.value, key);
      if (!entry?.enumerable) continue;
      const value: unknown = 'value' in entry ? entry.value : undefined;
      if (value === 0) continue;
      blocked.push(
        Object.freeze({
          name,
          count:
            typeof value === 'number' && Number.isSafeInteger(value) && value > 0
              ? value
              : 'invalid',
        })
      );
    }
    if (blocked.length) ownerFacts.set(error, Object.freeze(blocked));
  } catch {
    // Missing evidence cannot replace the original refusal or change cleanup.
  }
}

export function readLegacyStoppedOwnerFacts(
  error: unknown
): readonly LegacyStoppedOwnerFact[] | undefined {
  return error && typeof error === 'object' ? ownerFacts.get(error) : undefined;
}

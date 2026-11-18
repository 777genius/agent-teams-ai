import { createHash } from 'node:crypto';

import { validateRetainedLegacyLaunchRequest } from '../../application/validateRetainedLegacyLaunchRequest';

import { createStoppedImportDiagnostic } from './createStoppedImportDiagnostic';
import { RETAINED_LEGACY_OPEN_DIAGNOSTIC_PHASES } from './retainedLegacyOpenDiagnosticContract';

import type {
  RetainedLegacyOpenDiagnostic,
  RetainedLegacyOpenDiagnosticPhase,
} from './retainedLegacyOpenDiagnosticContract';

const phases: ReadonlySet<RetainedLegacyOpenDiagnosticPhase> = new Set(
  RETAINED_LEGACY_OPEN_DIAGNOSTIC_PHASES
);

function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function operationHash(request: unknown, mainPid: number): string | undefined {
  try {
    if (!Number.isSafeInteger(mainPid) || mainPid <= 0) return undefined;
    const action = ownData(request, 'action');
    if (action !== 'open' || !request || typeof request !== 'object') return undefined;
    const teamName = ownData(request, 'teamName');
    const intentId = ownData(request, 'intentId');
    if (
      typeof teamName !== 'string' ||
      teamName.length > 128 ||
      typeof intentId !== 'string' ||
      intentId.length > 128 ||
      Reflect.ownKeys(request).length !== 3
    )
      return undefined;
    // Validate a bounded own-data copy without invoking request getters or toJSON.
    const input = validateRetainedLegacyLaunchRequest({ action, teamName, intentId });
    if (input.action !== 'open') return undefined;
    return createHash('sha256')
      .update(JSON.stringify(['open', input.teamName, input.intentId]), 'utf8')
      .digest('hex');
  } catch {
    return undefined;
  }
}

function normalized(
  phase: RetainedLegacyOpenDiagnosticPhase,
  error: unknown
): Pick<RetainedLegacyOpenDiagnostic, 'phase' | 'category'> {
  let category: RetainedLegacyOpenDiagnostic['category'] = 'unknown';
  createStoppedImportDiagnostic('desktop', (observation) => {
    category = observation.category;
  })('request', error, 'not-dispatched');
  return { phase, category };
}

/** One private record after the original open result, with no raw exception retained. */
export function createRetainedLegacyOpenDiagnostic(
  request: unknown,
  mainPid: number,
  sink?: (observation: RetainedLegacyOpenDiagnostic) => unknown
): {
  remember(phase: RetainedLegacyOpenDiagnosticPhase, error: unknown): void;
  finish(phase: RetainedLegacyOpenDiagnosticPhase, result: unknown): void;
} {
  const hash = operationHash(request, mainPid);
  let first: Pick<RetainedLegacyOpenDiagnostic, 'phase' | 'category'> | undefined;
  let finished = false;
  return {
    remember(phase, error) {
      try {
        if (hash && !finished && !first && phases.has(phase)) first = normalized(phase, error);
      } catch {
        // A diagnostic cannot alter the original capture or cleanup failure.
      }
    },
    finish(phase, result) {
      if (finished) return;
      finished = true;
      try {
        if (!hash || !sink || !phases.has(phase) || ownData(result, 'ok') !== false) return;
        const outcome = ownData(result, 'outcome');
        if (outcome !== 'not-dispatched' && outcome !== 'unknown') return;
        const refusal = first ?? normalized(phase, result);
        const observation: RetainedLegacyOpenDiagnostic = Object.freeze({
          v: 1,
          mainPid,
          operationHash: hash,
          phase: refusal.phase,
          category: refusal.category,
          outcome,
        });
        void Promise.resolve(sink(observation)).catch(() => {
          // A rejected observer is not an open or cleanup failure.
        });
      } catch {
        // Keep the original public result and its uncertainty unchanged.
      }
    },
  };
}

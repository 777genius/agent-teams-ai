import { RAW_ORIGINS, RUNTIME_CAPTURE_NAMES } from './contracts';
import { parseKernelBoundNativeCaptures } from './native-captures';
import { assertP1NativeBindings } from './p1-admission';

import type { RawOrigin, RuntimeCaptureName } from './contracts';
import type { P1HttpCorrelationInput } from './native-http-join';
import type { P1LaunchSelection } from './p1-admission';
import type { SupervisorOutcome } from './processes';
import type { CleanupResult } from './sandbox';

export interface EvidencePreparationInput {
  readonly raw: Readonly<Record<RawOrigin, Buffer>>;
  readonly captures: Readonly<Record<RuntimeCaptureName, readonly Buffer[]>>;
  readonly controllerNonce: string;
  readonly runId: string;
  readonly outcome: SupervisorOutcome;
  readonly selectedLaunch?: P1LaunchSelection;
  /** Untrusted characterization inputs. Supplying these never opens the P1 admission gate. */
  readonly httpCorrelations?: readonly P1HttpCorrelationInput[];
}

export function assertEvidenceCleanup(cleanup: CleanupResult, runId: string): void {
  if (
    cleanup.disposition !== 'removed' ||
    !cleanup.markerVerified ||
    !cleanup.zeroOwnedSurvivors ||
    cleanup.runId !== runId
  )
    throw new Error('p3c_evidence_cleanup_unproven');
}

function freezeData<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    Object.values(value).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
}

/** Copies retained bytes and the pre-launch selection before the common all-family pass.
 * This is data preparation, not an admission capability. No assembly API accepts its output
 * in place of revalidating the source inputs. The caller retains these copies privately. */
export function prepareNativeEvidence(input: EvidencePreparationInput) {
  const { controllerNonce, runId } = input;
  const raw = Object.fromEntries(
    RAW_ORIGINS.map((origin) => [origin, Buffer.from(input.raw[origin])])
  ) as Record<RawOrigin, Buffer>;
  const captures = Object.fromEntries(
    RUNTIME_CAPTURE_NAMES.map((name) => [
      name,
      input.captures[name].map((bytes) => Buffer.from(bytes)),
    ])
  ) as Record<RuntimeCaptureName, Buffer[]>;
  const outcome = freezeData({
    ...structuredClone(input.outcome),
    transcript: input.outcome.transcript && Buffer.from(input.outcome.transcript),
  });
  const selectedLaunch =
    input.selectedLaunch && freezeData(structuredClone(input.selectedLaunch));
  const correlations =
    input.httpCorrelations && freezeData(structuredClone(input.httpCorrelations));
  const native = parseKernelBoundNativeCaptures({ captures, controllerNonce, runId, outcome });
  const shards = RUNTIME_CAPTURE_NAMES.flatMap((name) => native.shards[name]);
  assertP1NativeBindings(shards, outcome, selectedLaunch);

  return Object.freeze({
    raw, captures, outcome, native, shards, correlations, controllerNonce, runId,
  });
}

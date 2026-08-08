import {
  type ProcessOwnershipScope,
  ProcessSupervisionCancellationError,
  ProcessSupervisionProtocolError,
  ProcessSupervisionTimeoutError,
} from '../../../../contracts/processSupervision';

import type { ResolvedProcessLaunchSpec } from '../../../../core/application/ports';

export function scopeFromLaunchSpec(launchSpec: ResolvedProcessLaunchSpec): ProcessOwnershipScope {
  return scopeFromPlanRef(launchSpec.planRef, launchSpec.executionUnitId);
}

export function scopeFromPlanRef(
  planRef: ResolvedProcessLaunchSpec['planRef'],
  executionUnitId: ResolvedProcessLaunchSpec['executionUnitId']
): ProcessOwnershipScope {
  return Object.freeze({
    planRef: Object.freeze({
      teamId: planRef.teamId,
      runId: planRef.runId,
      generation: planRef.generation,
      planHash: planRef.planHash,
    }),
    executionUnitId,
  });
}

export function mapStartRejection(reason: string) {
  switch (reason) {
    case 'cancelled':
      return { status: 'rejected' as const, reason: 'cancelled' as const };
    case 'ownership_conflict':
    case 'argv_digest_mismatch':
    case 'invalid_request':
      return { status: 'rejected' as const, reason: 'not_owned' as const };
    default:
      return { status: 'rejected' as const, reason: 'unavailable' as const };
  }
}

export function mapCaughtStartFailure(error: unknown) {
  return error instanceof ProcessSupervisionCancellationError
    ? { status: 'rejected' as const, reason: 'cancelled' as const }
    : { status: 'rejected' as const, reason: 'unavailable' as const };
}

export function classifyEffectFailure(error: unknown, fallback: string): string {
  if (error instanceof ProcessSupervisionCancellationError) return `${fallback}-cancelled`;
  if (error instanceof ProcessSupervisionTimeoutError) return `${fallback}-timed-out`;
  if (error instanceof ProcessSupervisionProtocolError) return `${fallback}-protocol-error`;
  return `${fallback}-unavailable`;
}

export function neverCancelled() {
  return {
    cancellationId: 'process-observe-never-cancelled' as never,
    isCancellationRequested: () => false,
  };
}

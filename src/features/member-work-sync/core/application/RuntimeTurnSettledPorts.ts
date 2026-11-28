import type { RuntimeTurnSettledEvent, RuntimeTurnSettledProvider } from '../domain';

export interface RuntimeTurnSettledClaimedPayload {
  id: string;
  filePath: string;
  fileName: string;
  provider: RuntimeTurnSettledProvider;
  raw: string;
  claimedAt: string;
}

export interface RuntimeTurnSettledEventStorePort {
  claimPending(limit: number): Promise<RuntimeTurnSettledClaimedPayload[]>;
  markProcessed(
    payload: RuntimeTurnSettledClaimedPayload,
    result: RuntimeTurnSettledProcessedResult
  ): Promise<void>;
  markInvalid(
    payload: RuntimeTurnSettledClaimedPayload,
    result: RuntimeTurnSettledInvalidResult
  ): Promise<void>;
}

export interface RuntimeTurnSettledProcessedResult {
  event: RuntimeTurnSettledEvent;
  teamName?: string;
  memberName?: string;
  outcome: 'enqueued' | 'unresolved' | 'duplicate' | 'ignored';
  reason?: string;
  processedAt: string;
}

export interface RuntimeTurnSettledInvalidResult {
  reason: string;
  processedAt: string;
}

export type RuntimeTurnSettledPayloadNormalization =
  | { ok: true; event: RuntimeTurnSettledEvent }
  | { ok: false; reason: string };

export interface RuntimeTurnSettledPayloadNormalizerPort {
  normalize(input: {
    provider: RuntimeTurnSettledProvider;
    raw: string;
    recordedAt: string;
  }): RuntimeTurnSettledPayloadNormalization;
}

/** In-memory restriction from the original target read; never persisted with the event. */
export interface RuntimeTurnSettledSourceExecution {
  assertCurrent(): void;
  run<T>(operation: () => T): T;
}

export type RuntimeTurnSettledTargetResolution =
  | {
      ok: true;
      teamName: string;
      memberName: string;
      sourceExecution?: RuntimeTurnSettledSourceExecution;
    }
  | { ok: false; reason: string };

export interface RuntimeTurnSettledTargetResolverPort {
  resolve(event: RuntimeTurnSettledEvent): Promise<RuntimeTurnSettledTargetResolution>;
}

export interface RuntimeTurnSettledReconcileQueuePort {
  enqueueRuntimeTurnSettled(input: {
    teamName: string;
    memberName: string;
    event: RuntimeTurnSettledEvent;
  }): boolean;
}

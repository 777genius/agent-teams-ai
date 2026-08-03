import {
  compareHostedReadinessFreshness,
  HostedReadinessProjectionPolicyError,
  normalizeHostedReadinessProjection,
} from '../domain/HostedReadinessProjectionPolicy';

import type { HostedReadinessProjection } from '../../contracts';
import type {
  HostedReadinessProjectionClockPort,
  HostedReadinessProjectionDeadlinePort,
  HostedReadinessProjectionExecutionContext,
  HostedReadinessProjectionSourcePort,
} from './ports/HostedReadinessProjectionPorts';

export type HostedReadinessProjectionExecutionErrorCode =
  | 'request_cancelled'
  | 'deadline_exceeded'
  | 'source_unavailable'
  | 'source_invalid'
  | 'source_fence_mismatch'
  | 'stale_revision'
  | 'revision_conflict';

export class HostedReadinessProjectionExecutionError extends Error {
  constructor(readonly code: HostedReadinessProjectionExecutionErrorCode) {
    super(`hosted-readiness-projection-${code}`);
    this.name = 'HostedReadinessProjectionExecutionError';
  }
}

const SYSTEM_CLOCK: HostedReadinessProjectionClockPort = Object.freeze({ nowMs: Date.now });
const SYSTEM_DEADLINE: HostedReadinessProjectionDeadlinePort = Object.freeze({
  schedule(delayMs: number, onDeadline: () => void) {
    const timer = setTimeout(onDeadline, delayMs);
    return () => clearTimeout(timer);
  },
});

function assertContext(
  context: HostedReadinessProjectionExecutionContext
): HostedReadinessProjectionExecutionContext {
  if (
    !context ||
    typeof context !== 'object' ||
    !Number.isSafeInteger(context.deadlineAtMs) ||
    context.deadlineAtMs < 0 ||
    !(context.signal instanceof AbortSignal)
  ) {
    throw new HostedReadinessProjectionExecutionError('source_invalid');
  }
  return context;
}

export class GetHostedReadinessProjection {
  private lastPublished: HostedReadinessProjection | undefined;

  constructor(
    private readonly source: HostedReadinessProjectionSourcePort,
    private readonly clock: HostedReadinessProjectionClockPort = SYSTEM_CLOCK,
    private readonly deadline: HostedReadinessProjectionDeadlinePort = SYSTEM_DEADLINE
  ) {
    if (!source || typeof source.readProjection !== 'function') {
      throw new TypeError('hosted-readiness-projection-source-invalid');
    }
  }

  async execute(
    contextValue: HostedReadinessProjectionExecutionContext
  ): Promise<HostedReadinessProjection> {
    const context = assertContext(contextValue);
    if (context.signal.aborted) {
      throw new HostedReadinessProjectionExecutionError('request_cancelled');
    }

    const remainingMs = context.deadlineAtMs - this.clock.nowMs();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      throw new HostedReadinessProjectionExecutionError('deadline_exceeded');
    }

    const controller = new AbortController();
    let cancellationCode: 'request_cancelled' | 'deadline_exceeded' = 'request_cancelled';
    let rejectCancellation: ((error: HostedReadinessProjectionExecutionError) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = (code: 'request_cancelled' | 'deadline_exceeded'): void => {
      if (controller.signal.aborted) return;
      cancellationCode = code;
      controller.abort();
      rejectCancellation?.(new HostedReadinessProjectionExecutionError(code));
    };
    const abortFromCaller = (): void => cancel('request_cancelled');
    context.signal.addEventListener('abort', abortFromCaller, { once: true });

    let cancelDeadline: (() => void) | undefined;
    try {
      cancelDeadline = this.deadline.schedule(remainingMs, () => cancel('deadline_exceeded'));
      if (typeof cancelDeadline !== 'function') {
        throw new HostedReadinessProjectionExecutionError('source_invalid');
      }
      if (controller.signal.aborted) {
        throw new HostedReadinessProjectionExecutionError(cancellationCode);
      }

      const sourceResult = Promise.resolve().then(() =>
        this.source.readProjection(
          Object.freeze({
            deploymentId: context.deploymentId,
            bootId: context.bootId,
            deadlineAtMs: context.deadlineAtMs,
            signal: controller.signal,
          })
        )
      );
      let raw: unknown;
      try {
        raw = await Promise.race([sourceResult, cancellation]);
      } catch (error) {
        if (error instanceof HostedReadinessProjectionExecutionError) throw error;
        throw new HostedReadinessProjectionExecutionError('source_unavailable');
      }
      if (controller.signal.aborted) {
        throw new HostedReadinessProjectionExecutionError(cancellationCode);
      }

      let projection: HostedReadinessProjection;
      try {
        projection = normalizeHostedReadinessProjection(raw);
      } catch (error) {
        if (error instanceof HostedReadinessProjectionPolicyError) {
          throw new HostedReadinessProjectionExecutionError('source_invalid');
        }
        throw error;
      }
      if (
        projection.deploymentId !== context.deploymentId ||
        projection.bootId !== context.bootId
      ) {
        throw new HostedReadinessProjectionExecutionError('source_fence_mismatch');
      }

      const freshness = compareHostedReadinessFreshness(this.lastPublished, projection);
      if (freshness !== 'accept') {
        throw new HostedReadinessProjectionExecutionError(
          freshness === 'revision_conflict' ? 'revision_conflict' : 'stale_revision'
        );
      }
      this.lastPublished = projection;
      return projection;
    } finally {
      context.signal.removeEventListener('abort', abortFromCaller);
      try {
        cancelDeadline?.();
      } catch {
        // The projection has already been safely classified.
      }
      if (!controller.signal.aborted) controller.abort();
    }
  }
}

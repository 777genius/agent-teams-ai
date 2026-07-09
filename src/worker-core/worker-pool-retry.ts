import { SubscriptionWorkerError } from "./errors";
import type {
  WorkerPoolRetryPolicy,
  WorkerPoolRunOptions,
} from "./types";

const defaultCapacityPollMs = 30_000;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runAbortedError(): SubscriptionWorkerError {
  return new SubscriptionWorkerError(
    "subscription_worker_pool_run_aborted",
    "Worker pool run was aborted before it started.",
  );
}

export function isStartTimeoutError(
  error: unknown,
): error is SubscriptionWorkerError {
  return (
    error instanceof SubscriptionWorkerError &&
    error.code === "subscription_worker_start_timeout"
  );
}

export function normalizeIdempotencyKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function waitForIdempotentRun<Result>(
  run: Promise<Result>,
  abortSignal: AbortSignal | undefined,
): Promise<Result> {
  if (!abortSignal) return run;
  if (abortSignal.aborted) return Promise.reject(runAbortedError());

  return new Promise((resolve, reject) => {
    const cleanup = () => abortSignal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(runAbortedError());
    };
    abortSignal.addEventListener("abort", abort, { once: true });
    run.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function retryPolicy(
  options: WorkerPoolRunOptions,
  poolPolicy: WorkerPoolRetryPolicy | undefined,
): Required<WorkerPoolRetryPolicy> {
  const maxAttempts =
    options.retryPolicy?.maxAttempts ?? poolPolicy?.maxAttempts ?? 1;
  return {
    maxAttempts: Math.max(1, maxAttempts),
    retryOnSlotCapacityUnavailable:
      options.retryPolicy?.retryOnSlotCapacityUnavailable ??
      poolPolicy?.retryOnSlotCapacityUnavailable ??
      false,
    capacityPollMs: Math.max(
      250,
      options.retryPolicy?.capacityPollMs ??
        poolPolicy?.capacityPollMs ??
        defaultCapacityPollMs,
    ),
  };
}

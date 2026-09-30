import { isCancellationRequested } from '../../../../core/application/process-supervision';
import { computeCanonicalPolicyDigest } from '../../../../core/domain/process-supervision';

import type { Sha256Hash } from '../../../../contracts/runtimePlan';
import type {
  StartProcessExecutionUnitRequest,
  StartProcessExecutionUnitResult,
} from '../../../../core/application/ports';

export function exactStartRequestKey(request: StartProcessExecutionUnitRequest): Sha256Hash {
  // Cancellation belongs to one caller, not to the semantic durable-start identity.
  return computeCanonicalPolicyDigest({
    executionUnit: request.executionUnit,
    launchSpec: request.launchSpec,
  });
}

export async function waitForCallerCancellation(
  inFlight: Promise<StartProcessExecutionUnitResult>,
  cancellation: StartProcessExecutionUnitRequest['cancellation']
): Promise<StartProcessExecutionUnitResult> {
  if (isCancellationRequested(cancellation)) {
    return { status: 'rejected', reason: 'cancelled' };
  }

  return await new Promise<StartProcessExecutionUnitResult>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearInterval(cancellationPoll);
      callback();
    };
    const cancellationPoll = setInterval(() => {
      if (isCancellationRequested(cancellation)) {
        settle(() => resolve({ status: 'rejected', reason: 'cancelled' }));
      }
    }, 5);

    void inFlight.then(
      (result) =>
        settle(() =>
          resolve(
            isCancellationRequested(cancellation)
              ? { status: 'rejected', reason: 'cancelled' }
              : result
          )
        ),
      (error: unknown) =>
        settle(() => reject(error instanceof Error ? error : new Error('in-flight-start-rejected')))
    );
  });
}

import type { AgentBackendApi, BackendOperationRequest } from '../contracts/operations';
import type { ReviewCommandLookup } from '@agent-teams/task-change-ledger/review-transport';

/** Retains one uncertain original request; this is correlation metadata, never an outcome journal. */
export class HostReviewOperationError extends Error {
  readonly #request: BackendOperationRequest;
  constructor(
    readonly code: string,
    readonly outcome: 'not-dispatched' | 'rejected' | 'unknown',
    originalRequest: BackendOperationRequest
  ) {
    super(`Host review ${code}`);
    this.#request = structuredClone(originalRequest);
    this.name = 'HostReviewOperationError';
  }
  async lookupOriginalOutcome(
    backend: Pick<AgentBackendApi, 'invoke'>
  ): Promise<ReviewCommandLookup | null> {
    const original = this.#request;
    if (original.operation !== 'review.invoke')
      throw new Error('No review mutation receipt for this request');
    const lookup: BackendOperationRequest = {
      handle: structuredClone(original.handle),
      commandId: original.commandId,
      operation: 'review.lookup',
      payload: structuredClone({
        scope: original.payload.scope,
        expected: original.payload.request,
      }),
    };
    let result;
    try {
      result = await backend.invoke(lookup);
    } catch {
      throw new HostReviewOperationError('unavailable', 'unknown', original);
    }
    if (!result.ok) throw new HostReviewOperationError(result.code, result.outcome, original);
    if (result.value === null) return null;
    if (
      !('kind' in result.value) ||
      result.value.kind !== 'review-command' ||
      result.value.commandId !== original.commandId
    )
      throw new HostReviewOperationError('hold', 'unknown', original);
    return result.value;
  }
  get originalRequest(): BackendOperationRequest {
    return structuredClone(this.#request);
  }
}

import type { BackendReviewUnwatchRequest } from '../../../contracts/reviewWatch';

/** Orders only pending watch admission against exact sender-owned replacement/cleanup. No persistence. */
export function createReviewWatchAdmissionOrder() {
  const owners = new WeakMap<object, Map<string, object>>();
  let disposed = false;
  const key = (request: BackendReviewUnwatchRequest) =>
    JSON.stringify([request.handle.handleId, request.watchId]);
  return {
    begin(owner: object, request: BackendReviewUnwatchRequest) {
      const id = key(request),
        token = {};
      let entries = owners.get(owner);
      if (!entries) owners.set(owner, (entries = new Map()));
      entries.set(id, token);
      const current = entries;
      return {
        isCurrent: () => !disposed && current.get(id) === token,
        finish() {
          if (current.get(id) === token) current.delete(id);
        },
      };
    },
    cancel(owner: object, request: BackendReviewUnwatchRequest) {
      owners.get(owner)?.delete(key(request));
    },
    dispose() {
      disposed = true;
    },
  };
}

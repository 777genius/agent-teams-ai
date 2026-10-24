import { useStore } from '@renderer/store';
import { captureSessionConnectionScope } from '@renderer/store/session/sessionRequestIdentity';
import { captureContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';

export interface MemberLogReadScope {
  readonly key: string;
  readonly source: object;
  isCurrent(): boolean;
}

function currentScopeKey(): string {
  return JSON.stringify([
    captureContextScopedRequestEpoch(),
    captureSessionConnectionScope(useStore.getState()),
  ]);
}

let latestScope: { key: string; source: object } | null = null;

/** Keep only the current scope identity, never completed read payloads or history. */
export function useMemberLogReadScope(): MemberLogReadScope {
  const key = useStore((state) =>
    JSON.stringify([captureContextScopedRequestEpoch(), captureSessionConnectionScope(state)])
  );
  if (latestScope?.key !== key) latestScope = { key, source: {} };
  return { key, source: latestScope.source, isCurrent: () => currentScopeKey() === key };
}

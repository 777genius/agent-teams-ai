import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { api } from '@renderer/api';
import {
  captureContextScopedRequestEpoch,
  subscribeContextScopedRequestEpoch,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { getTeamMessageReadContextScope } from '@renderer/utils/teamMessageReadStorage';

interface LocalScopeResult {
  epoch: number;
  scope: string | null;
  error: string | null;
}

// One effective-root request per workspace epoch, shared by all read consumers.
let localRequest: { epoch: number; promise: Promise<string> } | null = null;

function resolveLocalScope(epoch: number): Promise<string> {
  if (localRequest?.epoch === epoch) return localRequest.promise;
  const promise = Promise.resolve()
    .then(() => api.config.getClaudeRootInfo())
    .then((info) => getTeamMessageReadContextScope('local', info));
  localRequest = { epoch, promise };
  void promise.catch(() => {
    if (localRequest?.promise === promise) localRequest = null;
  });
  return promise;
}

export function useTeamMessageReadContextScope(contextId: string) {
  const epoch = useSyncExternalStore(
    subscribeContextScopedRequestEpoch,
    captureContextScopedRequestEpoch,
    captureContextScopedRequestEpoch
  );
  const [local, setLocal] = useState<LocalScopeResult | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const retry = useCallback(() => setRetryVersion((version) => version + 1), []);

  useEffect(() => {
    if (contextId !== 'local') return;
    let active = true;
    const load = (): void => {
      void resolveLocalScope(epoch).then(
        (scope) => {
          if (active && captureContextScopedRequestEpoch() === epoch) {
            setLocal({ epoch, scope, error: null });
          }
        },
        () => {
          if (active && captureContextScopedRequestEpoch() === epoch) {
            setLocal({ epoch, scope: null, error: 'Unable to resolve message read context' });
          }
        }
      );
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      active = false;
      window.removeEventListener('focus', load);
    };
  }, [contextId, epoch, retryVersion]);

  if (contextId !== 'local') return { scope: contextId || null, error: null, retry, epoch };
  return {
    scope: local?.epoch === epoch ? local.scope : null,
    error: local?.epoch === epoch ? local.error : null,
    retry,
    epoch,
  };
}

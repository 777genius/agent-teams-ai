import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import { isHostSavedRequest } from './launchDialogPrefill';

import type { TeamCreateRequest } from '@shared/types/team';

const READ_BUDGET_MS = 30_000;
interface Source {
  scope: string;
  request: TeamCreateRequest | null;
  error?: string;
}

/** One existing-dialog source query. Loading/error never means proven absent owner settings. */
export function useLaunchDialogSavedRequest(open: boolean, launch: boolean, teamName: string) {
  const contextId = useStore((state) => state.activeContextId);
  const switching = useStore((state) => state.isContextSwitching);
  const epoch = captureContextScopedRequestEpoch();
  const scope = open && launch ? JSON.stringify([teamName, contextId, switching, epoch]) : null;
  const lifetime = useRef({ scope: null as string | null, revision: 0 });
  if (lifetime.current.scope !== scope) {
    lifetime.current = { scope, revision: lifetime.current.revision + 1 };
  }
  const host = launch && isHostTeamSelectionKey(teamName);
  const identity = `${lifetime.current.revision}:${scope}`;
  const key = host ? identity : teamName;
  const [source, setSource] = useState<Source>();
  const reset = useCallback(() => setSource(undefined), []);

  useEffect(() => {
    if (!scope || switching) return;
    let cancelled = false;
    const current = () => !cancelled && isContextScopedRequestEpochCurrent(epoch);
    let deadline: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Saved source read timed out')), READ_BUDGET_MS);
    });
    void Promise.race([
      Promise.resolve().then(() => (teamName ? api.teams.getSavedRequest(teamName) : null)),
      timeout,
    ])
      .then((request) => {
        if (!current()) return;
        if (
          request !== null &&
          (request.teamName !== teamName || (host && !isHostSavedRequest(request)))
        )
          throw new Error('Saved source Team changed');
        setSource({ scope: identity, request });
      })
      .catch((error: unknown) => {
        if (current())
          setSource({
            scope: identity,
            request: null,
            ...(host
              ? { error: 'Saved Team configuration unavailable. Close and reopen Launch.' }
              : String(error).includes('RUNTIME_SELECTION_UNSUPPORTED')
                ? {
                    error:
                      'RUNTIME_SELECTION_UNSUPPORTED: Unsupported saved team runtime selection.',
                  }
                : {}),
          });
      })
      .finally(() => clearTimeout(deadline));
    return () => {
      cancelled = true;
      clearTimeout(deadline);
    };
  }, [scope, identity, teamName, switching, epoch, host]);

  const current = open && !switching && source?.scope === identity;
  return useMemo(
    () => ({
      key,
      host,
      ready: current && source !== undefined && !source.error,
      request: current ? (source?.request ?? null) : null,
      error: current ? source?.error : undefined,
      reset,
    }),
    [key, host, current, source, reset]
  );
}

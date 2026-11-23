import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { useRetainedLegacyLaunch } from '@features/agent-backend/renderer';
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
  projectSkipPermissions?: boolean;
  error?: string;
}

/** One existing-dialog source query. Loading/error never means proven absent owner settings. */
export function useLaunchDialogSavedRequest(
  open: boolean,
  launch: boolean,
  teamName: string,
  projectPermissionTeamName?: string | null
) {
  const retained = useRetainedLegacyLaunch();
  const contextId = useStore((state) => state.activeContextId);
  const switching = useStore((state) => state.isContextSwitching);
  const epoch = captureContextScopedRequestEpoch();
  const scope = open && launch ? JSON.stringify([teamName, contextId, switching, epoch, retained?.choice.scopeId, projectPermissionTeamName]) : null;
  const lifetime = useRef({ scope: null as string | null, revision: 0 });
  if (lifetime.current.scope !== scope) {
    lifetime.current = { scope, revision: lifetime.current.revision + 1 };
  }
  const host = launch && isHostTeamSelectionKey(teamName);
  const identity = `${lifetime.current.revision}:${scope}`;
  const key = host || retained
    ? identity
    : projectPermissionTeamName === undefined
      ? teamName
      : JSON.stringify([teamName, projectPermissionTeamName]);
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
    const readProjectPermissions = async (): Promise<boolean | undefined> => {
      if (projectPermissionTeamName === undefined) return undefined;
      if (!projectPermissionTeamName || projectPermissionTeamName === teamName) return false;
      try {
        const saved = await api.teams.getSavedRequest(projectPermissionTeamName);
        return saved?.teamName === projectPermissionTeamName && saved.skipPermissions === true;
      } catch {
        return false;
      }
    };
    void Promise.race([
      Promise.all([
        Promise.resolve().then(() => (retained ? retained.read() : teamName ? api.teams.getSavedRequest(teamName) : null)),
        readProjectPermissions(),
      ]),
      timeout,
    ])
      .then(([request, projectSkipPermissions]) => {
        if (!current()) return;
        if (
          request !== null &&
          (request.teamName !== teamName || (host && !isHostSavedRequest(request)))
        )
          throw new Error('Saved source Team changed');
        setSource({ scope: identity, request, projectSkipPermissions });
      })
      .catch((error: unknown) => {
        if (current())
          setSource({
            scope: identity,
            request: null,
            ...(projectPermissionTeamName !== undefined ? { projectSkipPermissions: false } : {}),
            ...(host || retained
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
  }, [scope, identity, teamName, switching, epoch, host, retained, projectPermissionTeamName]);

  const current = open && !switching && source?.scope === identity;
  return useMemo(
    () => ({
      key,
      host: host || !!retained,
      ready: current && source !== undefined && !source.error,
      request: current ? (source?.request ?? null) : null,
      projectSkipPermissions: current ? source?.projectSkipPermissions : undefined,
      error: current ? source?.error : undefined,
      reset,
    }),
    [key, host, retained, current, source, reset]
  );
}

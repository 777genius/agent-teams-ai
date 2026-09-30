import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TeamWorktreeGitReadinessRendererPorts } from '../ports/TeamWorktreeGitReadinessRendererPorts';
import type { TeamWorktreeGitStatus } from '@shared/types';

export interface WorktreeGitReadinessState {
  status: TeamWorktreeGitStatus | null;
  loading: boolean;
  actionLoading: 'init' | 'commit' | null;
  error: string | null;
  refresh: () => Promise<void>;
  initializeRepository: () => Promise<void>;
  createInitialCommit: () => Promise<void>;
}

interface RequestScope {
  enabled: boolean;
  projectPath: string | null;
}

interface RequestToken extends RequestScope {
  id: number;
}

function activeProjectPath(projectPath: string | null): string | null {
  return projectPath?.trim() ? projectPath : null;
}

function isSameScope(left: RequestScope, right: RequestScope): boolean {
  return left.enabled === right.enabled && left.projectPath === right.projectPath;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useWorktreeGitReadiness(
  projectPath: string | null,
  enabled: boolean,
  ports: TeamWorktreeGitReadinessRendererPorts
): WorktreeGitReadinessState {
  const [status, setStatus] = useState<TeamWorktreeGitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<'init' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const loadingRequestRef = useRef<number | null>(null);
  const actionRequestRef = useRef<number | null>(null);
  const currentScopeRef = useRef<RequestScope>({
    enabled,
    projectPath: activeProjectPath(projectPath),
  });

  currentScopeRef.current = {
    enabled,
    projectPath: activeProjectPath(projectPath),
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, []);

  const isCurrentScope = useCallback(
    (scope: RequestScope): boolean => isSameScope(scope, currentScopeRef.current),
    []
  );

  const beginRequest = useCallback((scope: RequestScope): RequestToken => {
    const token = {
      ...scope,
      id: requestSequenceRef.current + 1,
    };
    requestSequenceRef.current = token.id;
    return token;
  }, []);

  const isLatestRequest = useCallback(
    (token: RequestToken): boolean =>
      mountedRef.current &&
      requestSequenceRef.current === token.id &&
      isSameScope(token, currentScopeRef.current),
    []
  );

  const clearUnavailableScope = useCallback(() => {
    requestSequenceRef.current += 1;
    loadingRequestRef.current = null;
    actionRequestRef.current = null;
    setStatus(null);
    setError(null);
    setLoading(false);
    setActionLoading(null);
  }, []);

  const runStatusRequest = useCallback(
    async (scope: RequestScope): Promise<void> => {
      if (!scope.enabled || !scope.projectPath || !isCurrentScope(scope)) {
        return;
      }

      const token = beginRequest(scope);
      loadingRequestRef.current = token.id;
      setLoading(true);
      setError(null);

      try {
        const nextStatus = await ports.getStatus(scope.projectPath);
        if (isLatestRequest(token)) {
          setStatus(nextStatus);
        }
      } catch (requestError) {
        if (isLatestRequest(token)) {
          setStatus(null);
          setError(errorMessage(requestError, 'Failed to inspect Git repository'));
        }
      } finally {
        if (
          mountedRef.current &&
          loadingRequestRef.current === token.id &&
          isSameScope(token, currentScopeRef.current)
        ) {
          setLoading(false);
        }
      }
    },
    [beginRequest, isCurrentScope, isLatestRequest, ports]
  );

  const refresh = useCallback(async () => {
    const scope = {
      enabled,
      projectPath: activeProjectPath(projectPath),
    };
    if (!scope.enabled || !scope.projectPath) {
      if (isCurrentScope(scope)) {
        clearUnavailableScope();
      }
      return;
    }
    await runStatusRequest(scope);
  }, [clearUnavailableScope, enabled, isCurrentScope, projectPath, runStatusRequest]);

  useEffect(() => {
    const scope = {
      enabled,
      projectPath: activeProjectPath(projectPath),
    };
    if (!scope.enabled || !scope.projectPath) {
      clearUnavailableScope();
      return;
    }

    actionRequestRef.current = null;
    setActionLoading(null);
    void runStatusRequest(scope);
  }, [clearUnavailableScope, enabled, projectPath, runStatusRequest]);

  const runAction = useCallback(
    async (
      action: 'init' | 'commit',
      invoke: (activePath: string) => Promise<TeamWorktreeGitStatus>,
      fallbackError: string
    ): Promise<void> => {
      const scope = {
        enabled,
        projectPath: activeProjectPath(projectPath),
      };
      if (!scope.enabled || !scope.projectPath || !isCurrentScope(scope)) {
        return;
      }

      const token = beginRequest(scope);
      actionRequestRef.current = token.id;
      setActionLoading(action);
      setError(null);

      try {
        const nextStatus = await invoke(scope.projectPath);
        if (isLatestRequest(token)) {
          setStatus(nextStatus);
        }
      } catch (requestError) {
        if (isLatestRequest(token)) {
          setError(errorMessage(requestError, fallbackError));
        }
      } finally {
        if (
          mountedRef.current &&
          actionRequestRef.current === token.id &&
          isSameScope(token, currentScopeRef.current)
        ) {
          setActionLoading(null);
        }
      }
    },
    [beginRequest, enabled, isCurrentScope, isLatestRequest, projectPath]
  );

  const initializeRepository = useCallback(
    () =>
      runAction(
        'init',
        (activePath) => ports.initialize(activePath),
        'Failed to initialize Git repository'
      ),
    [ports, runAction]
  );

  const createInitialCommit = useCallback(
    () =>
      runAction(
        'commit',
        (activePath) => ports.createInitialCommit(activePath),
        'Failed to create initial Git commit'
      ),
    [ports, runAction]
  );

  return useMemo(
    () => ({
      status,
      loading,
      actionLoading,
      error,
      refresh,
      initializeRepository,
      createInitialCommit,
    }),
    [actionLoading, createInitialCommit, error, initializeRepository, loading, refresh, status]
  );
}

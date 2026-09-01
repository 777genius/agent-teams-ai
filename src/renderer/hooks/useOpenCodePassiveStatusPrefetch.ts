import { useEffect, useReducer, useRef } from 'react';

import { useStore } from '@renderer/store';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';

export function useOpenCodePassiveStatusPrefetch({
  enabled,
  projectPath,
}: {
  enabled: boolean;
  projectPath: string | null | undefined;
}): void {
  const normalizedProjectPath = projectPath?.trim() || '';
  const cliStatus = useStore((state) => state.cliStatus);
  const scopeRevision = useStore((state) => state.cliProviderStatusScopeRevision) ?? 0;
  const fetchCliProviderStatus = useStore((state) => state.fetchCliProviderStatus);
  const scopedProviderStatus = useStore((state) =>
    normalizedProjectPath
      ? (state.cliProviderStatusByScope?.[
          getCliProviderStatusScopeKey('opencode', normalizedProjectPath)
        ] ?? null)
      : null
  );
  const requestedRevisionByScopeRef = useRef(new Map<string, number>());
  const activeScopeRef = useRef('');
  const [, publishCompletion] = useReducer((sequence: number) => sequence + 1, 0);

  activeScopeRef.current = normalizedProjectPath;

  useEffect(() => {
    if (scopedProviderStatus && !requestedRevisionByScopeRef.current.has(normalizedProjectPath)) {
      requestedRevisionByScopeRef.current.set(normalizedProjectPath, scopeRevision);
      return;
    }
    if (
      !enabled ||
      !normalizedProjectPath ||
      cliStatus?.flavor !== 'agent_teams_orchestrator' ||
      typeof fetchCliProviderStatus !== 'function' ||
      requestedRevisionByScopeRef.current.get(normalizedProjectPath) === scopeRevision
    ) {
      return;
    }

    requestedRevisionByScopeRef.current.set(normalizedProjectPath, scopeRevision);
    let cancelled = false;
    void fetchCliProviderStatus('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath: normalizedProjectPath,
    }).then(
      (loaded) => {
        if (!loaded) requestedRevisionByScopeRef.current.delete(normalizedProjectPath);
        if (!cancelled && activeScopeRef.current === normalizedProjectPath) publishCompletion();
      },
      () => {
        requestedRevisionByScopeRef.current.delete(normalizedProjectPath);
        if (!cancelled && activeScopeRef.current === normalizedProjectPath) publishCompletion();
      }
    );

    return () => {
      cancelled = true;
    };
  }, [
    cliStatus?.flavor,
    enabled,
    fetchCliProviderStatus,
    normalizedProjectPath,
    scopedProviderStatus,
    scopeRevision,
  ]);
}

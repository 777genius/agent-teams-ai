import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type { RuntimeProviderCompanionStatusDto } from '../../contracts';

interface RuntimeProviderCompanionState {
  status: RuntimeProviderCompanionStatusDto | null;
  loading: boolean;
  runInstallAndConnect: () => Promise<void>;
  runConnect: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useRuntimeProviderCompanion(
  enabled: boolean,
  projectPath: string | null
): RuntimeProviderCompanionState {
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<RuntimeProviderCompanionStatusDto | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    setLoading(true);
    try {
      const next = await api.runtimeProviderManagement.getCompanionStatus({
        companionId: 'kiro-cli',
        projectPath,
      });
      if (mountedRef.current) setStatus(next);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [enabled, projectPath]);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = api.runtimeProviderManagement.onCompanionProgress((next) => {
      if (next.companionId === 'kiro-cli' && mountedRef.current) {
        setStatus(next);
        setLoading(
          [
            'checking',
            'downloading',
            'installing',
            'verifying-install',
            'signing-in',
            'verifying-auth',
            'verifying-model',
          ].includes(next.phase)
        );
      }
    });
    void refresh();
    return unsubscribe;
  }, [enabled, refresh]);

  const run = useCallback(
    async (operation: 'install' | 'connect'): Promise<void> => {
      setLoading(true);
      try {
        const next =
          operation === 'install'
            ? await api.runtimeProviderManagement.installAndConnectCompanion({
                companionId: 'kiro-cli',
                projectPath,
              })
            : await api.runtimeProviderManagement.connectCompanion({
                companionId: 'kiro-cli',
                projectPath,
              });
        if (mountedRef.current) setStatus(next);
      } catch (error) {
        if (!mountedRef.current) return;
        setStatus((current) =>
          current
            ? {
                ...current,
                phase: 'error',
                percent: null,
                message: 'Kiro CLI setup failed',
                error: error instanceof Error ? error.message : 'Kiro CLI setup failed',
                updatedAt: new Date().toISOString(),
              }
            : current
        );
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [projectPath]
  );

  const runInstallAndConnect = useCallback(() => run('install'), [run]);
  const runConnect = useCallback(() => run('connect'), [run]);

  return { status, loading, runInstallAndConnect, runConnect, refresh };
}

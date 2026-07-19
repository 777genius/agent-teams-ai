import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type {
  RuntimeProviderCompanionActionDto,
  RuntimeProviderCompanionIdDto,
  RuntimeProviderCompanionStatusDto,
} from '../../contracts';

export interface RuntimeProviderCompanionState {
  status: RuntimeProviderCompanionStatusDto | null;
  loading: boolean;
  runInstallAndConnect: () => Promise<void>;
  runConnect: () => Promise<void>;
  runAction: (action: RuntimeProviderCompanionActionDto) => Promise<void>;
  refresh: () => Promise<void>;
}

function companionDisplayName(companionId: RuntimeProviderCompanionIdDto): string {
  return companionId === 'kiro-cli' ? 'Amazon Q Developer / Kiro' : 'Cursor';
}

function companionErrorStatus(
  companionId: RuntimeProviderCompanionIdDto,
  error: unknown,
  current: RuntimeProviderCompanionStatusDto | null
): RuntimeProviderCompanionStatusDto {
  const displayName = current?.displayName ?? companionDisplayName(companionId);
  const message = error instanceof Error ? error.message : `${displayName} setup failed`;
  return {
    companionId,
    displayName,
    phase: 'error',
    installed: current?.installed ?? false,
    authenticated: current?.authenticated ?? false,
    account: current?.account ?? null,
    supportedActions: current?.supportedActions ?? [],
    actionOutput: current?.actionOutput ?? null,
    binaryPath: current?.binaryPath ?? null,
    version: current?.version ?? null,
    percent: null,
    message: `${displayName} setup failed`,
    detail: current?.detail ?? null,
    error: message,
    manualCommand: current?.manualCommand ?? '',
    manualUrl: current?.manualUrl ?? '',
    updatedAt: new Date().toISOString(),
  };
}

export function useRuntimeProviderCompanion(
  companionId: RuntimeProviderCompanionIdDto,
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
        companionId,
        projectPath,
      });
      if (mountedRef.current) setStatus(next);
    } catch (error) {
      if (mountedRef.current) {
        setStatus((current) => companionErrorStatus(companionId, error, current));
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [companionId, enabled, projectPath]);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = api.runtimeProviderManagement.onCompanionProgress((next) => {
      if (next.companionId === companionId && mountedRef.current) {
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
            'running-action',
          ].includes(next.phase)
        );
      }
    });
    void refresh();
    return unsubscribe;
  }, [companionId, enabled, refresh]);

  const run = useCallback(
    async (operation: 'install' | 'connect'): Promise<void> => {
      setLoading(true);
      try {
        const next =
          operation === 'install'
            ? await api.runtimeProviderManagement.installAndConnectCompanion({
                companionId,
                projectPath,
              })
            : await api.runtimeProviderManagement.connectCompanion({
                companionId,
                projectPath,
              });
        if (mountedRef.current) setStatus(next);
      } catch (error) {
        if (!mountedRef.current) return;
        setStatus((current) => companionErrorStatus(companionId, error, current));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [companionId, projectPath]
  );

  const runInstallAndConnect = useCallback(() => run('install'), [run]);
  const runConnect = useCallback(() => run('connect'), [run]);

  const runAction = useCallback(
    async (action: RuntimeProviderCompanionActionDto): Promise<void> => {
      setLoading(true);
      try {
        const next = await api.runtimeProviderManagement.runCompanionAction({
          companionId,
          projectPath,
          action,
        });
        if (mountedRef.current) setStatus(next);
      } catch (error) {
        if (mountedRef.current) {
          setStatus((current) => companionErrorStatus(companionId, error, current));
        }
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [companionId, projectPath]
  );

  return { status, loading, runInstallAndConnect, runConnect, runAction, refresh };
}

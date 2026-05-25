import React, { useCallback, useMemo, useState } from 'react';

import { ProviderRuntimeSettingsDialog } from '@renderer/components/runtime/ProviderRuntimeSettingsDialog';
import {
  getProviderTerminalCommand,
  getProviderTerminalLogoutCommand,
} from '@renderer/components/runtime/providerTerminalCommands';
import { TerminalModal } from '@renderer/components/terminal/TerminalModal';
import { useStore } from '@renderer/store';
import { refreshCliStatusForCurrentMode } from '@renderer/utils/refreshCliStatus';
import { getRuntimeDisplayName } from '@renderer/utils/runtimeDisplayName';
import { useShallow } from 'zustand/react/shallow';

import { getProvisioningProviderLabel } from './ProvisioningProviderStatusList';

import type { CliProviderId, CliProviderStatus } from '@shared/types';

interface ProvisioningProviderRuntimeSettingsDialogProps {
  readonly openProviderId: CliProviderId | null;
  readonly onOpenProviderIdChange: (providerId: CliProviderId | null) => void;
  readonly providers: CliProviderStatus[];
  readonly projectPath?: string | null;
  readonly disabled?: boolean;
  readonly onProviderRuntimeChanged?: (providerId: CliProviderId) => void;
}

interface ProviderTerminalState {
  providerId: CliProviderId;
  action: 'login' | 'logout';
}

export const ProvisioningProviderRuntimeSettingsDialog = ({
  openProviderId,
  onOpenProviderIdChange,
  providers,
  projectPath = null,
  disabled = false,
  onProviderRuntimeChanged,
}: ProvisioningProviderRuntimeSettingsDialogProps): React.JSX.Element | null => {
  const [providerTerminal, setProviderTerminal] = useState<ProviderTerminalState | null>(null);
  const {
    appConfig,
    bootstrapCliStatus,
    cliProviderStatusLoading,
    cliStatus,
    cliStatusLoading,
    codexRuntimeStatus,
    codexRuntimeStatusLoading,
    fetchCliProviderStatus,
    fetchCliStatus,
    installCodexRuntime,
    invalidateCliStatus,
    multimodelEnabled,
    updateConfig,
  } = useStore(
    useShallow((s) => ({
      appConfig: s.appConfig,
      bootstrapCliStatus: s.bootstrapCliStatus,
      cliProviderStatusLoading: s.cliProviderStatusLoading,
      cliStatus: s.cliStatus,
      cliStatusLoading: s.cliStatusLoading,
      codexRuntimeStatus: s.codexRuntimeStatus,
      codexRuntimeStatusLoading: s.codexRuntimeStatusLoading,
      fetchCliProviderStatus: s.fetchCliProviderStatus,
      fetchCliStatus: s.fetchCliStatus,
      installCodexRuntime: s.installCodexRuntime,
      invalidateCliStatus: s.invalidateCliStatus,
      multimodelEnabled: s.appConfig?.general?.multimodelEnabled ?? true,
      updateConfig: s.updateConfig,
    }))
  );

  const selectedProviderId = useMemo<CliProviderId | null>(() => {
    if (!openProviderId || providers.length === 0) {
      return null;
    }

    return providers.some((provider) => provider.providerId === openProviderId)
      ? openProviderId
      : (providers[0]?.providerId ?? null);
  }, [openProviderId, providers]);

  const handleProviderBackendChange = useCallback(
    async (providerId: CliProviderId, backendId: string) => {
      if (providerId !== 'gemini' && providerId !== 'codex') {
        return;
      }

      const currentBackends = appConfig?.runtime?.providerBackends ?? {
        gemini: 'auto' as const,
        codex: 'codex-native' as const,
      };

      await updateConfig('runtime', {
        providerBackends: {
          ...currentBackends,
          [providerId]: backendId,
        },
      });

      try {
        await fetchCliProviderStatus(providerId, { silent: false });
        onProviderRuntimeChanged?.(providerId);
      } catch {
        throw new Error('Runtime updated, but failed to refresh provider status.');
      }
    },
    [
      appConfig?.runtime?.providerBackends,
      fetchCliProviderStatus,
      onProviderRuntimeChanged,
      updateConfig,
    ]
  );

  const handleProviderRefresh = useCallback(
    async (providerId: CliProviderId) => {
      await fetchCliProviderStatus(providerId, { silent: false });
      onProviderRuntimeChanged?.(providerId);
    },
    [fetchCliProviderStatus, onProviderRuntimeChanged]
  );

  const refreshRuntimeAfterTerminal = useCallback(() => {
    void (async () => {
      await invalidateCliStatus();
      await refreshCliStatusForCurrentMode({
        multimodelEnabled,
        bootstrapCliStatus,
        fetchCliStatus,
      });
    })();
  }, [bootstrapCliStatus, fetchCliStatus, invalidateCliStatus, multimodelEnabled]);

  const activeTerminalProvider = providerTerminal
    ? (providers.find((provider) => provider.providerId === providerTerminal.providerId) ?? null)
    : null;
  const providerTerminalCommand =
    providerTerminal && activeTerminalProvider
      ? providerTerminal.action === 'login'
        ? getProviderTerminalCommand(activeTerminalProvider)
        : getProviderTerminalLogoutCommand(activeTerminalProvider)
      : null;

  if (!selectedProviderId) {
    return null;
  }

  return (
    <>
      <ProviderRuntimeSettingsDialog
        open={Boolean(openProviderId)}
        onOpenChange={(open) => {
          if (!open) {
            onOpenProviderIdChange(null);
          }
        }}
        providers={providers}
        projectPath={projectPath}
        initialProviderId={selectedProviderId}
        providerStatusLoading={cliProviderStatusLoading}
        disabled={disabled || cliStatusLoading || !cliStatus?.binaryPath}
        codexRuntimeStatus={codexRuntimeStatus}
        codexRuntimeStatusLoading={codexRuntimeStatusLoading}
        onInstallCodexRuntime={() => installCodexRuntime()}
        onSelectBackend={handleProviderBackendChange}
        onRefreshProvider={handleProviderRefresh}
        onRequestLogin={(providerId) => setProviderTerminal({ providerId, action: 'login' })}
      />
      {providerTerminal && cliStatus?.binaryPath && (
        <TerminalModal
          title={`${getRuntimeDisplayName(cliStatus, multimodelEnabled)} ${
            providerTerminal.action === 'login' ? 'Login' : 'Logout'
          }: ${getProvisioningProviderLabel(providerTerminal.providerId)}`}
          command={cliStatus.binaryPath}
          args={providerTerminalCommand?.args}
          env={providerTerminalCommand?.env}
          onClose={() => {
            setProviderTerminal(null);
            onProviderRuntimeChanged?.(providerTerminal.providerId);
            refreshRuntimeAfterTerminal();
          }}
          onExit={() => {
            onProviderRuntimeChanged?.(providerTerminal.providerId);
            refreshRuntimeAfterTerminal();
          }}
          autoCloseOnSuccessMs={3000}
          successMessage={
            providerTerminal.action === 'login' ? 'Authentication updated' : 'Provider logged out'
          }
          failureMessage={
            providerTerminal.action === 'login' ? 'Authentication failed' : 'Logout failed'
          }
        />
      )}
    </>
  );
};

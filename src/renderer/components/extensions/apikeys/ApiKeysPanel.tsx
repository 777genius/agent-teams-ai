/**
 * ApiKeysPanel — grid of saved API keys with add button and empty state.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  mergeCodexProviderStatusWithSnapshot,
  useCodexAccountSnapshot,
} from '@features/codex-account/renderer';
import { isElectronMode } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { AlertTriangle, Info, Key, Plus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ApiKeyCard } from './ApiKeyCard';
import { ApiKeyFormDialog } from './ApiKeyFormDialog';

import type { ApiKeyEntry } from '@shared/types/extensions';

interface ApiKeysPanelProps {
  projectPath: string | null;
  projectLabel: string | null;
}

export const ApiKeysPanel = ({
  projectPath,
  projectLabel,
}: ApiKeysPanelProps): React.JSX.Element => {
  const isElectron = useMemo(() => isElectronMode(), []);
  const {
    apiKeys,
    apiKeysLoading,
    apiKeysError,
    storageStatus,
    fetchStorageStatus,
    cliStatus,
    cliStatusLoading,
    appConfig,
  } = useStore(
    useShallow((s) => ({
      apiKeys: s.apiKeys,
      apiKeysLoading: s.apiKeysLoading,
      apiKeysError: s.apiKeysError,
      storageStatus: s.apiKeyStorageStatus,
      fetchStorageStatus: s.fetchApiKeyStorageStatus,
      cliStatus: s.cliStatus,
      cliStatusLoading: s.cliStatusLoading,
      appConfig: s.appConfig,
    }))
  );
  const multimodelEnabled = appConfig?.general?.multimodelEnabled ?? true;
  const loadingCliStatus = useMemo(
    () =>
      !cliStatus && cliStatusLoading && multimodelEnabled
        ? createLoadingMultimodelCliStatus()
        : cliStatus,
    [cliStatus, cliStatusLoading, multimodelEnabled]
  );
  const codexAccount = useCodexAccountSnapshot({
    enabled:
      isElectron &&
      loadingCliStatus?.flavor === 'agent_teams_orchestrator' &&
      Boolean(loadingCliStatus?.providers.some((provider) => provider.providerId === 'codex')),
  });
  const effectiveCliStatus = useMemo(
    () =>
      loadingCliStatus
        ? {
            ...loadingCliStatus,
            providers: loadingCliStatus.providers.map((provider) =>
              provider.providerId === 'codex'
                ? mergeCodexProviderStatusWithSnapshot(provider, codexAccount.snapshot)
                : provider
            ),
          }
        : loadingCliStatus,
    [loadingCliStatus, codexAccount.snapshot]
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKeyEntry | null>(null);

  useEffect(() => {
    void fetchStorageStatus();
  }, [fetchStorageStatus]);

  const handleAdd = () => {
    setEditingKey(null);
    setDialogOpen(true);
  };

  const handleEdit = (key: ApiKeyEntry) => {
    setEditingKey(key);
    setDialogOpen(true);
  };

  const handleDialogClose = () => {
    setDialogOpen(false);
    setEditingKey(null);
  };

  const isOsKeychain = storageStatus?.encryptionMethod === 'os-keychain';
  const providerKeyCards = useMemo(() => {
    if (!effectiveCliStatus?.providers?.length) {
      return [];
    }

    return (
      [
        {
          providerId: 'anthropic',
          label: 'Anthropic runtime',
          envVar: 'ANTHROPIC_API_KEY',
        },
        {
          providerId: 'codex',
          label: 'Codex runtime',
          envVar: 'OPENAI_API_KEY',
        },
      ] as const
    ).flatMap((item) => {
      const provider = effectiveCliStatus.providers.find(
        (entry) => entry.providerId === item.providerId
      );
      if (!provider) {
        return [];
      }

      return [
        {
          ...item,
          authenticated: provider.authenticated,
          apiKeyConfigured: provider.connection?.apiKeyConfigured ?? false,
          sourceLabel: provider.connection?.apiKeySourceLabel ?? null,
          statusMessage: provider.statusMessage ?? null,
        },
      ];
    });
  }, [effectiveCliStatus]);

  return (
    <div className="flex flex-col gap-4">
      {providerKeyCards.length > 0 && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {providerKeyCards.map((provider) => (
            <div
              key={provider.providerId}
              className="bg-surface-raised/30 rounded-lg border border-border p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-text">{provider.label}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-text-muted">{provider.envVar}</p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] ${
                    provider.authenticated
                      ? 'bg-emerald-500/10 text-emerald-300'
                      : provider.apiKeyConfigured
                        ? 'bg-blue-500/10 text-blue-300'
                        : 'bg-amber-500/10 text-amber-300'
                  }`}
                >
                  {provider.authenticated
                    ? 'Connected'
                    : provider.apiKeyConfigured
                      ? 'Key configured'
                      : 'Key missing'}
                </span>
              </div>
              <p className="mt-2 text-xs text-text-muted">
                {provider.sourceLabel
                  ? `Current source: ${provider.sourceLabel}.`
                  : 'No stored or environment key detected for this provider.'}
                {provider.statusMessage ? ` ${provider.statusMessage}` : ''}
              </p>
            </div>
          ))}
        </div>
      )}
      {/* Header row */}
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm text-text-secondary">
          Securely store API keys for auto-filling when installing MCP servers.
          {storageStatus && (
            <Tooltip>
              <TooltipTrigger asChild>
                {isOsKeychain ? (
                  <Info className="size-3.5 shrink-0 cursor-help text-text-muted" />
                ) : (
                  <AlertTriangle className="size-3.5 shrink-0 cursor-help text-amber-400" />
                )}
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                {isOsKeychain ? (
                  <p>
                    Keys are encrypted via {storageStatus.backend} and stored with restricted file
                    permissions (owner-only).
                  </p>
                ) : (
                  <p>
                    OS keychain unavailable — keys are encrypted locally with AES-256. For stronger
                    protection, install a keyring service (gnome-keyring, kwallet).
                  </p>
                )}
              </TooltipContent>
            </Tooltip>
          )}
        </p>
        <Button variant="outline" size="sm" onClick={handleAdd} className="gap-1.5">
          <Plus className="size-3.5" />
          Add API Key
        </Button>
      </div>

      {/* Error */}
      {apiKeysError && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
          {apiKeysError}
        </div>
      )}

      {/* Skeleton loading */}
      {apiKeysLoading && apiKeys.length === 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="skeleton-card flex flex-col gap-2 rounded-lg border border-border p-4"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <div className="h-4 w-32 rounded bg-surface-raised" />
              <div className="h-3 w-24 rounded bg-surface-raised" />
              <div className="h-3 w-40 rounded bg-surface-raised" />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!apiKeysLoading && apiKeys.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-sm border border-dashed border-border px-8 py-16">
          <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface-raised">
            <Key className="size-5 text-text-muted" />
          </div>
          <p className="text-sm text-text-secondary">No API keys saved</p>
          <p className="text-xs text-text-muted">
            Add keys to auto-fill environment variables when installing MCP servers.
          </p>
          <Button variant="outline" size="sm" onClick={handleAdd} className="mt-2 gap-1.5">
            <Plus className="size-3.5" />
            Add your first key
          </Button>
        </div>
      )}

      {/* Key cards grid */}
      {apiKeys.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {apiKeys.map((key) => (
            <ApiKeyCard key={key.id} apiKey={key} onEdit={handleEdit} />
          ))}
        </div>
      )}

      {/* Form dialog */}
      <ApiKeyFormDialog
        open={dialogOpen}
        editingKey={editingKey}
        currentProjectPath={projectPath}
        currentProjectLabel={projectLabel}
        onClose={handleDialogClose}
      />
    </div>
  );
};

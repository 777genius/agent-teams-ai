import { type JSX, useState } from 'react';

import {
  useRetainedLegacyAccount,
  useRetainedLegacyInstallers,
  useRetainedLegacyLaunch,
  useRetainedLegacyRuntimeStatus,
} from '@features/agent-backend/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { MULTIMODEL_PROVIDER_IDS } from '@renderer/store/slices/cliInstallerSlice';
import { RefreshCw, Settings2 } from 'lucide-react';

import { useOpenCodeSourceDirectory } from './OpenCodeSourceDirectoryProvider';

import type { TeamProviderId } from '@shared/types';

interface TeamModelProviderActionsProps {
  providerId: TeamProviderId;
  projectPath: string;
  onManageProviders?: (providerId: TeamProviderId) => void;
}

/** Explicitly rescan all providers when users change credentials or runtime settings. */
export const TeamModelProviderActions = ({
  providerId,
  projectPath,
  onManageProviders,
}: Readonly<TeamModelProviderActionsProps>): JSX.Element => {
  const retained = useRetainedLegacyLaunch();
  const original = useRetainedLegacyRuntimeStatus(projectPath);
  const installers = useRetainedLegacyInstallers();
  const account = useRetainedLegacyAccount(!!retained, { loadOnMount: false });
  const { t: commonT } = useAppTranslation('common');
  const { t: dashboardT } = useAppTranslation('dashboard');
  const openSettingsTab = useStore((s) => s.openSettingsTab);
  const invalidateCliStatus = useStore((s) => s.invalidateCliStatus);
  const fetchCliStatus = useStore((s) => s.fetchCliStatus);
  const fetchCliProviderStatus = useStore((s) => s.fetchCliProviderStatus);
  const invalidateOpenCodeRuntimeStatus = useStore((s) => s.invalidateOpenCodeRuntimeStatus);
  const fetchOpenCodeRuntimeStatus = useStore((s) => s.fetchOpenCodeRuntimeStatus);
  const invalidateCodexRuntimeStatus = useStore((s) => s.invalidateCodexRuntimeStatus);
  const fetchCodexRuntimeStatus = useStore((s) => s.fetchCodexRuntimeStatus);
  const directory = useOpenCodeSourceDirectory(projectPath || null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);

  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(false);
    if (retained) {
      try {
        const results = await Promise.all([
          original.refresh(),
          installers.refresh(),
          account.refresh(),
        ]);
        if (results.some((result) => !result)) setRefreshError(true);
        directory?.refresh();
      } finally {
        setRefreshing(false);
      }
      return;
    }
    // Runtime installation snapshots have their own caches and gate model discovery.
    // Recheck them independently so one runtime failure cannot skip the other.
    const runtimeChecks = Promise.allSettled([
      (async () => {
        await invalidateOpenCodeRuntimeStatus();
        await fetchOpenCodeRuntimeStatus();
      })(),
      (async () => {
        await invalidateCodexRuntimeStatus();
        await fetchCodexRuntimeStatus();
      })(),
    ]);
    try {
      // Retire old scoped reads and bypass cached CLI metadata before checking providers.
      await invalidateCliStatus();
      await fetchCliStatus();
      // Metadata reads report errors in the store instead of rejecting.
      if (useStore.getState().cliStatusError) setRefreshError(true);
      // Native Claude CLI has its own auth snapshot; orchestrator-specific
      // provider probes must never overwrite that native status.
      const orchestratorActive =
        useStore.getState().cliStatus?.flavor === 'agent_teams_orchestrator';
      const checks = (orchestratorActive ? MULTIMODEL_PROVIDER_IDS : []).map((id) =>
        fetchCliProviderStatus(id, { checkReason: 'manual_refresh' })
      );
      if (orchestratorActive && projectPath) {
        // Both OpenCode model routes and the Claude default are project-sensitive.
        checks.push(
          fetchCliProviderStatus('opencode', {
            checkReason: 'manual_refresh',
            projectPath,
          }),
          fetchCliProviderStatus('anthropic', {
            checkReason: 'manual_refresh',
            projectPath,
          })
        );
      }
      const results = await Promise.allSettled(checks);
      if (results.some((result) => result.status === 'rejected' || !result.value)) {
        setRefreshError(true);
      }
      // Scoped catalogs/local models react to scope revision; connected sources have
      // an independent directory cache which must also bypass its saved snapshot.
      directory?.refresh();
    } catch {
      setRefreshError(true);
    } finally {
      const runtimeResults = await runtimeChecks;
      const { openCodeRuntimeError, codexRuntimeError } = useStore.getState();
      if (
        runtimeResults.some((result) => result.status === 'rejected') ||
        openCodeRuntimeError ||
        codexRuntimeError
      ) {
        setRefreshError(true);
      }
      setRefreshing(false);
    }
  };

  return (
    <div className="mb-1 space-y-1">
      <div className="flex w-full items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex min-w-0 flex-1" tabIndex={retained ? 0 : undefined}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="team-model-selector-manage-providers"
                className="h-8 min-w-0 flex-1 justify-start gap-2 border-[var(--color-border)] bg-black/[0.025] px-2.5 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-black/[0.05] hover:text-[var(--color-text)] dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
                disabled={!!retained}
                onClick={() => {
                  onManageProviders?.(providerId);
                  openSettingsTab('providers');
                }}
              >
                <Settings2 className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">
                  {dashboardT('cliStatus.actions.manageProviders')}
                </span>
              </Button>
            </span>
          </TooltipTrigger>
          {retained ? (
            <TooltipContent>
              Close Launch before changing the original runtime connection.
            </TooltipContent>
          ) : null}
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="team-model-selector-refresh-providers"
              className="size-8 shrink-0 border-[var(--color-border)] p-0"
              aria-label={commonT('actions.refresh')}
              aria-busy={refreshing}
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw
                className={cn('size-4', refreshing && 'animate-spin')}
                aria-hidden="true"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {commonT('actions.refresh')} · {dashboardT('cliStatus.actions.manageProviders')}
          </TooltipContent>
        </Tooltip>
      </div>
      {retained ? (
        <p className="px-2 text-[11px] text-[var(--color-text-secondary)]">
          Using the original runtime connection. Close Launch to change its settings.
        </p>
      ) : null}
      {refreshError ? (
        <span role="alert" className="px-2 text-[11px] text-red-600 dark:text-red-300">
          {commonT('states.error')} · {commonT('actions.retry')}
        </span>
      ) : null}
    </div>
  );
};

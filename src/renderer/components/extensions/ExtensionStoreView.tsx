/**
 * ExtensionStoreView — top-level component for the Extensions tab.
 * Uses per-tab UI state via useExtensionsTabState() hook.
 * Global catalog data comes from Zustand store.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  isCodexAccountSnapshotPending,
  mergeCodexProviderStatusWithSnapshot,
  useCodexAccountSnapshot,
} from '@features/codex-account/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { api, isElectronMode } from '@renderer/api';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Tabs, TabsContent, TabsList } from '@renderer/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { useTabIdOptional } from '@renderer/contexts/useTabUIContext';
import { useExtensionsTabState } from '@renderer/hooks/useExtensionsTabState';
import { useStore } from '@renderer/store';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import {
  formatCliExtensionCapabilityStatus,
  getVisibleMultimodelProviders,
  isMultimodelRuntimeStatus,
} from '@renderer/utils/multimodelProviderVisibility';
import { resolveProjectPathById } from '@renderer/utils/projectLookup';
import { refreshCliStatusForCurrentMode } from '@renderer/utils/refreshCliStatus';
import { getRuntimeDisplayName } from '@renderer/utils/runtimeDisplayName';
import { getExtensionActionDisableReason } from '@shared/utils/extensionNormalizers';
import { getCliProviderExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import {
  AlertTriangle,
  BookOpen,
  Info,
  Key,
  Loader2,
  Plus,
  Puzzle,
  RefreshCw,
  Server,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ApiKeysPanel } from './apikeys/ApiKeysPanel';
import { CustomMcpServerDialog } from './mcp/CustomMcpServerDialog';
import { McpServersPanel } from './mcp/McpServersPanel';
import { PluginsPanel } from './plugins/PluginsPanel';
import { SkillsPanel } from './skills/SkillsPanel';
import { ExtensionsSubTabTrigger } from './ExtensionsSubTabTrigger';

import type { CliProviderStatus } from '@shared/types';

const ProviderCapabilityCardSkeleton = ({
  providerId,
  displayName,
}: {
  providerId: 'anthropic' | 'codex' | 'gemini' | 'opencode';
  displayName: string;
}): React.JSX.Element => {
  const { t } = useAppTranslation('extensions');
  return (
    <div className="rounded-md border border-border bg-surface-raised px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-2 text-sm font-medium text-text">
            <ProviderBrandLogo providerId={providerId} className="size-4 shrink-0" />
            <span>{displayName}</span>
          </p>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
            <Loader2 className="size-3 animate-spin" />
            <span>{t('store.provider.checkingStatus')}</span>
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 text-text-muted">
          {t('store.provider.loading')}
        </Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {Array.from({ length: 3 }, (_, index) => (
          <span
            key={index}
            className="h-7 w-28 animate-pulse rounded-md border border-border bg-surface"
          />
        ))}
      </div>
    </div>
  );
};

function isProviderCapabilityCardLoading(
  provider: CliProviderStatus,
  providerLoading: boolean
): boolean {
  return (
    providerLoading ||
    (!provider.authenticated &&
      provider.statusMessage === 'Checking...' &&
      provider.models.length === 0 &&
      provider.backend == null)
  );
}

function isCodexSnapshotPending(
  provider: CliProviderStatus,
  codexSnapshotPending: boolean
): boolean {
  return provider.providerId === 'codex' && codexSnapshotPending;
}

export const ExtensionStoreView = (): React.JSX.Element => {
  const { t } = useAppTranslation('extensions');
  const isElectron = useMemo(() => isElectronMode(), []);
  const tabId = useTabIdOptional();
  const {
    fetchPluginCatalog,
    bootstrapCliStatus,
    fetchCliStatus,
    fetchApiKeys,
    fetchSkillsCatalog,
    mcpBrowse,
    mcpFetchInstalled,
    apiKeysLoading,
    pluginCatalogLoading,
    mcpBrowseLoading,
    skillsLoading,
    cliStatus,
    cliStatusLoading,
    cliProviderStatusLoading,
    appConfig,
    openDashboard,
    sessions,
    projects,
    repositoryGroups,
  } = useStore(
    useShallow((s) => ({
      fetchPluginCatalog: s.fetchPluginCatalog,
      bootstrapCliStatus: s.bootstrapCliStatus,
      fetchCliStatus: s.fetchCliStatus,
      fetchApiKeys: s.fetchApiKeys,
      fetchSkillsCatalog: s.fetchSkillsCatalog,
      mcpBrowse: s.mcpBrowse,
      mcpFetchInstalled: s.mcpFetchInstalled,
      apiKeysLoading: s.apiKeysLoading,
      pluginCatalogLoading: s.pluginCatalogLoading,
      mcpBrowseLoading: s.mcpBrowseLoading,
      skillsLoading: s.skillsLoading,
      cliStatus: s.cliStatus,
      cliStatusLoading: s.cliStatusLoading,
      cliProviderStatusLoading: s.cliProviderStatusLoading,
      appConfig: s.appConfig,
      openDashboard: s.openDashboard,
      sessions: s.sessions,
      projects: s.projects,
      repositoryGroups: s.repositoryGroups,
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
      multimodelEnabled &&
      loadingCliStatus?.flavor === 'agent_teams_orchestrator' &&
      Boolean(
        loadingCliStatus?.providers.some(
          (provider: CliProviderStatus) => provider.providerId === 'codex'
        )
      ),
    includeRateLimits: true,
  });
  const codexSnapshotPending =
    isCodexAccountSnapshotPending(codexAccount.loading, codexAccount.snapshot) &&
    Boolean(
      loadingCliStatus?.providers.some(
        (provider: CliProviderStatus) => provider.providerId === 'codex'
      )
    );
  const effectiveCliStatus = useMemo(
    () =>
      loadingCliStatus
        ? {
            ...loadingCliStatus,
            providers: loadingCliStatus.providers.map((provider: CliProviderStatus) =>
              provider.providerId === 'codex'
                ? mergeCodexProviderStatusWithSnapshot(provider, codexAccount.snapshot)
                : provider
            ),
          }
        : loadingCliStatus,
    [loadingCliStatus, codexAccount.snapshot]
  );
  const effectiveCliStatusLoading = cliStatusLoading && effectiveCliStatus === null;
  const runtimeDisplayName = getRuntimeDisplayName(effectiveCliStatus, multimodelEnabled);
  const cliInstalled = effectiveCliStatus?.installed ?? true;
  const hasOngoingSessions = sessions.some((sess) => sess.isOngoing);
  const extensionsTabProjectId = useStore((s) =>
    tabId
      ? (s.paneLayout.panes.flatMap((pane) => pane.tabs).find((tab) => tab.id === tabId)
          ?.projectId ?? null)
      : null
  );

  const tabState = useExtensionsTabState();
  const [customMcpDialogOpen, setCustomMcpDialogOpen] = useState(false);
  const resolvedProject = useMemo(
    () => resolveProjectPathById(extensionsTabProjectId, projects, repositoryGroups),
    [extensionsTabProjectId, projects, repositoryGroups]
  );
  const projectPath = resolvedProject?.path ?? null;
  const projectLabel = resolvedProject?.name ?? null;
  const subTabs = useMemo(
    () => [
      {
        value: 'plugins' as const,
        label: t('store.tabs.plugins.label'),
        icon: Puzzle,
        description: t('store.tabs.plugins.description'),
      },
      {
        value: 'mcp-servers' as const,
        label: t('store.tabs.mcpServers.label'),
        icon: Server,
        description: t('store.tabs.mcpServers.description'),
      },
      {
        value: 'skills' as const,
        label: t('store.tabs.skills.label'),
        icon: BookOpen,
        description: t('store.tabs.skills.description'),
      },
      {
        value: 'api-keys' as const,
        label: t('store.tabs.apiKeys.label'),
        icon: Key,
        description: t('store.tabs.apiKeys.description'),
      },
    ],
    [t]
  );

  // Fetch plugin catalog on mount
  useEffect(() => {
    void fetchPluginCatalog(projectPath ?? undefined);
  }, [fetchPluginCatalog, projectPath]);

  useEffect(() => {
    const cliStatusMatchesCurrentMode =
      cliStatus &&
      (multimodelEnabled
        ? cliStatus.flavor === 'agent_teams_orchestrator'
        : cliStatus.flavor !== 'agent_teams_orchestrator');
    if (cliStatusLoading || cliStatusMatchesCurrentMode) {
      return;
    }
    void refreshCliStatusForCurrentMode({
      multimodelEnabled,
      providerStatusMode: 'defer',
      bootstrapCliStatus,
      fetchCliStatus,
    });
  }, [bootstrapCliStatus, cliStatus, cliStatusLoading, fetchCliStatus, multimodelEnabled]);

  // Fetch MCP installed state on mount
  useEffect(() => {
    void mcpFetchInstalled(projectPath ?? undefined);
  }, [mcpFetchInstalled, projectPath]);

  // Fetch Skills catalog on mount / project change
  useEffect(() => {
    void fetchSkillsCatalog(projectPath ?? undefined);
  }, [fetchSkillsCatalog, projectPath]);

  // Refresh all data (plugins + MCP browse + installed + skills)
  const handleRefresh = useCallback(() => {
    void refreshCliStatusForCurrentMode({
      multimodelEnabled,
      bootstrapCliStatus,
      fetchCliStatus,
    });
    if (tabState.activeSubTab === 'api-keys') {
      void fetchApiKeys();
    }
    void fetchPluginCatalog(projectPath ?? undefined, true);
    void mcpBrowse(); // re-fetch first page
    void mcpFetchInstalled(projectPath ?? undefined);
    void fetchSkillsCatalog(projectPath ?? undefined);
  }, [
    bootstrapCliStatus,
    fetchApiKeys,
    fetchCliStatus,
    fetchPluginCatalog,
    fetchSkillsCatalog,
    multimodelEnabled,
    mcpBrowse,
    mcpFetchInstalled,
    projectPath,
    tabState.activeSubTab,
  ]);

  const isRefreshing =
    effectiveCliStatusLoading ||
    apiKeysLoading ||
    pluginCatalogLoading ||
    mcpBrowseLoading ||
    skillsLoading;
  const mcpMutationDisableReason = useMemo(
    () =>
      getExtensionActionDisableReason({
        isInstalled: false,
        cliStatus: effectiveCliStatus,
        cliStatusLoading: effectiveCliStatusLoading,
        section: 'mcp',
      }),
    [effectiveCliStatus, effectiveCliStatusLoading]
  );
  const cliStatusBanner = useMemo(() => {
    const providers = effectiveCliStatus?.providers ?? [];
    const visibleProviders = getVisibleMultimodelProviders(providers);
    const isMultimodel = isMultimodelRuntimeStatus(effectiveCliStatus);
    const shouldShowMultimodelProviderCards =
      isMultimodel && visibleProviders.length > 0 && effectiveCliStatus !== null;

    if (
      (effectiveCliStatusLoading || effectiveCliStatus === null) &&
      !shouldShowMultimodelProviderCards
    ) {
      return (
        <div className="bg-surface/70 mx-4 mt-3 flex items-start gap-3 rounded-md border border-border px-4 py-3">
          <Info className="mt-0.5 size-4 shrink-0 text-text-secondary" />
          <div>
            <p className="text-sm font-medium text-text">
              {t('store.runtime.checkingAvailabilityTitle')}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              {t('store.runtime.checkingAvailabilityDescription')}
            </p>
          </div>
        </div>
      );
    }

    if (!effectiveCliStatus.installed) {
      const cliLaunchIssue = Boolean(
        effectiveCliStatus.binaryPath && effectiveCliStatus.launchError
      );
      return (
        <div className="mx-4 mt-3 flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-300">
              {cliLaunchIssue
                ? t('store.runtime.failedToStartTitle')
                : t('store.runtime.notAvailableTitle')}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              {cliLaunchIssue
                ? t('store.runtime.failedToStartDescription')
                : t('store.runtime.notAvailableDescription')}
            </p>
            {cliLaunchIssue && effectiveCliStatus.launchError && (
              <p className="mt-2 break-all font-mono text-[11px] text-text-muted">
                {effectiveCliStatus.launchError}
              </p>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={openDashboard}>
            {t('store.actions.openDashboard')}
          </Button>
        </div>
      );
    }

    if (!isMultimodel && !effectiveCliStatus.authLoggedIn) {
      return (
        <div className="mx-4 mt-3 flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-300">
              {t('store.runtime.needsSignInTitle', { runtime: runtimeDisplayName })}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              {t('store.runtime.needsSignInDescription', {
                runtime: runtimeDisplayName,
                version: effectiveCliStatus.installedVersion
                  ? ` (${effectiveCliStatus.installedVersion})`
                  : '',
              })}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={openDashboard}>
            {t('store.actions.openDashboard')}
          </Button>
        </div>
      );
    }

    if (isMultimodel) {
      return (
        <div className="bg-surface/70 mx-4 mt-3 rounded-md border border-border px-4 py-3">
          <div className="flex items-start gap-3">
            <Info className="mt-0.5 size-4 shrink-0 text-text-secondary" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text">
                {t('store.runtime.multimodelCapabilitiesTitle')}
              </p>
              <p className="mt-0.5 text-xs text-text-muted">
                {t('store.runtime.multimodelCapabilitiesDescription')}
              </p>
            </div>
          </div>
          {visibleProviders.length > 0 && (
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {visibleProviders.map((provider) => {
                const providerLoading = cliProviderStatusLoading[provider.providerId] === true;
                if (
                  isProviderCapabilityCardLoading(provider, providerLoading) ||
                  isCodexSnapshotPending(provider, codexSnapshotPending)
                ) {
                  return (
                    <ProviderCapabilityCardSkeleton
                      key={provider.providerId}
                      providerId={provider.providerId}
                      displayName={provider.displayName}
                    />
                  );
                }

                const statusTone = provider.authenticated
                  ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
                  : provider.supported
                    ? 'border-amber-500/30 bg-amber-500/5 text-amber-300'
                    : 'border-border bg-surface-raised text-text-muted';
                const statusLabel = provider.authenticated
                  ? 'Connected'
                  : provider.supported
                    ? t('store.provider.needsSetup')
                    : t('store.provider.unsupported');
                const finalStatusLabel = provider.authenticated
                  ? t('store.provider.connected')
                  : statusLabel;
                const extensionCapabilities = getCliProviderExtensionCapabilities(provider);
                const pluginStatus = extensionCapabilities.plugins.status;

                return (
                  <div
                    key={provider.providerId}
                    className={`rounded-md border px-3 py-2 ${statusTone}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="inline-flex items-center gap-2 text-sm font-medium">
                          <ProviderBrandLogo
                            providerId={provider.providerId}
                            className="size-4 shrink-0"
                          />
                          <span>{provider.displayName}</span>
                        </p>
                        <p className="truncate text-[11px] text-text-muted">
                          {provider.statusMessage ??
                            provider.backend?.label ??
                            t('store.provider.readyToConfigure')}
                        </p>
                      </div>
                      <Badge variant="outline" className="shrink-0">
                        {finalStatusLabel}
                      </Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                      <Badge
                        variant={pluginStatus === 'unsupported' ? 'outline' : 'secondary'}
                        className={
                          pluginStatus === 'unsupported'
                            ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                            : undefined
                        }
                      >
                        {t('store.capabilities.plugins', {
                          status: formatCliExtensionCapabilityStatus(pluginStatus),
                        })}
                      </Badge>
                      <Badge variant="secondary">
                        {t('store.capabilities.mcp', {
                          status: formatCliExtensionCapabilityStatus(
                            extensionCapabilities.mcp.status
                          ),
                        })}
                      </Badge>
                      <Badge variant="secondary">
                        {t('store.capabilities.skills', {
                          status: extensionCapabilities.skills.ownership,
                        })}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="mx-4 mt-3 flex items-start gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
        <Info className="mt-0.5 size-4 shrink-0 text-emerald-300" />
        <div>
          <p className="text-sm font-medium text-emerald-300">
            {t('store.runtime.readyTitle', { runtime: runtimeDisplayName })}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">
            {t('store.runtime.readyDescription', {
              runtime: runtimeDisplayName,
              versionSuffix: effectiveCliStatus.installedVersion
                ? ` using ${runtimeDisplayName} ${effectiveCliStatus.installedVersion}`
                : '',
            })}
          </p>
        </div>
      </div>
    );
  }, [
    cliProviderStatusLoading,
    codexSnapshotPending,
    effectiveCliStatus,
    effectiveCliStatusLoading,
    openDashboard,
    runtimeDisplayName,
    t,
  ]);

  // Browser mode guard
  if (!api.plugins && !api.mcpRegistry && !api.skills) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <Puzzle className="mx-auto mb-3 size-12 text-text-muted" />
          <h2 className="text-lg font-semibold text-text">{t('store.title')}</h2>
          <p className="mt-1 text-sm text-text-muted">{t('store.desktopOnly')}</p>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          {cliStatusBanner}
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              <Puzzle className="size-5 text-text-muted" />
              <h1 className="text-lg font-semibold text-text">{t('store.title')}</h1>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={isRefreshing}>
                  <RefreshCw className={`size-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('store.actions.refreshCatalog')}</TooltipContent>
            </Tooltip>
          </div>

          {/* Sub-tabs */}
          <div className="px-6 py-4">
            {/* CLI not installed warning */}
            {!cliInstalled && (
              <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-400">
                <AlertTriangle className="size-4 shrink-0" />
                {t('store.runtime.requiredForMutations')}
              </div>
            )}
            {/* Active sessions warning */}
            {hasOngoingSessions && (
              <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm text-blue-400">
                <Info className="size-4 shrink-0" />
                {t('store.sessionsRestartWarning')}
              </div>
            )}
            <Tabs
              value={tabState.activeSubTab}
              onValueChange={(v) =>
                tabState.setActiveSubTab(v as 'plugins' | 'mcp-servers' | 'skills' | 'api-keys')
              }
            >
              <div className="-mx-6 flex items-end justify-between border-b border-border px-6">
                <TabsList className="gap-1 rounded-b-none">
                  {subTabs.map((subTab) => (
                    <ExtensionsSubTabTrigger
                      key={subTab.value}
                      value={subTab.value}
                      label={subTab.label}
                      icon={subTab.icon}
                      description={subTab.description}
                    />
                  ))}
                </TabsList>
                {tabState.activeSubTab === 'mcp-servers' && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setCustomMcpDialogOpen(true)}
                          className="mb-1 whitespace-nowrap"
                          disabled={Boolean(mcpMutationDisableReason)}
                        >
                          <Plus className="mr-1 size-3.5" />
                          {t('store.actions.addCustom')}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {mcpMutationDisableReason && (
                      <TooltipContent>{mcpMutationDisableReason}</TooltipContent>
                    )}
                  </Tooltip>
                )}
              </div>

              <TabsContent value="plugins" className="mt-0 pt-4">
                <PluginsPanel
                  projectPath={projectPath}
                  pluginFilters={tabState.pluginFilters}
                  pluginSort={tabState.pluginSort}
                  selectedPluginId={tabState.selectedPluginId}
                  updatePluginSearch={tabState.updatePluginSearch}
                  toggleCategory={tabState.toggleCategory}
                  toggleCapability={tabState.toggleCapability}
                  toggleInstalledOnly={tabState.toggleInstalledOnly}
                  setSelectedPluginId={tabState.setSelectedPluginId}
                  clearFilters={tabState.clearFilters}
                  hasActiveFilters={tabState.hasActiveFilters}
                  setPluginSort={tabState.setPluginSort}
                  cliStatus={effectiveCliStatus}
                  cliStatusLoading={effectiveCliStatusLoading}
                />
              </TabsContent>

              <TabsContent value="mcp-servers" className="mt-0 pt-4">
                <McpServersPanel
                  projectPath={projectPath}
                  mcpSearchQuery={tabState.mcpSearchQuery}
                  mcpSearch={tabState.mcpSearch}
                  mcpSearchResults={tabState.mcpSearchResults}
                  mcpSearchLoading={tabState.mcpSearchLoading}
                  mcpSearchWarnings={tabState.mcpSearchWarnings}
                  selectedMcpServerId={tabState.selectedMcpServerId}
                  setSelectedMcpServerId={tabState.setSelectedMcpServerId}
                  cliStatus={effectiveCliStatus}
                  cliStatusLoading={effectiveCliStatusLoading}
                />
              </TabsContent>

              <TabsContent value="api-keys" className="mt-0 pt-4">
                <ApiKeysPanel projectPath={projectPath} projectLabel={projectLabel} />
              </TabsContent>

              <TabsContent value="skills" className="mt-0 pt-4">
                <SkillsPanel
                  projectPath={projectPath}
                  projectLabel={projectLabel}
                  skillsSearchQuery={tabState.skillsSearchQuery}
                  setSkillsSearchQuery={tabState.setSkillsSearchQuery}
                  skillsSort={tabState.skillsSort}
                  setSkillsSort={tabState.setSkillsSort}
                  selectedSkillId={tabState.selectedSkillId}
                  setSelectedSkillId={tabState.setSelectedSkillId}
                />
              </TabsContent>
            </Tabs>

            {/* Custom MCP server dialog (lifted to store view level) */}
            <CustomMcpServerDialog
              open={customMcpDialogOpen}
              onClose={() => setCustomMcpDialogOpen(false)}
              projectPath={projectPath}
              cliStatus={effectiveCliStatus}
              cliStatusLoading={effectiveCliStatusLoading}
            />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};

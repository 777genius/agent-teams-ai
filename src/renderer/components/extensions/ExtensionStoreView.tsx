/**
 * ExtensionStoreView — top-level component for the Extensions tab.
 * Uses per-tab UI state via useExtensionsTabState() hook.
 * Global catalog data comes from Zustand store.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
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
import {
  formatCliExtensionCapabilityStatus,
  getVisibleMultimodelProviders,
  isMultimodelRuntimeStatus,
} from '@renderer/utils/multimodelProviderVisibility';
import { resolveProjectPathById } from '@renderer/utils/projectLookup';
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
  providerId: 'anthropic' | 'codex' | 'gemini';
  displayName: string;
}): React.JSX.Element => (
  <div className="rounded-md border border-border bg-surface-raised px-3 py-2">
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="inline-flex items-center gap-2 text-sm font-medium text-text">
          <ProviderBrandLogo providerId={providerId} className="size-4 shrink-0" />
          <span>{displayName}</span>
        </p>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
          <Loader2 className="size-3 animate-spin" />
          <span>Checking provider status...</span>
        </div>
      </div>
      <Badge variant="outline" className="shrink-0 text-text-muted">
        Loading...
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

export const ExtensionStoreView = (): React.JSX.Element => {
  const tabId = useTabIdOptional();
  const {
    fetchPluginCatalog,
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
    openDashboard,
    sessions,
    projects,
    repositoryGroups,
  } = useStore(
    useShallow((s) => ({
      fetchPluginCatalog: s.fetchPluginCatalog,
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
      openDashboard: s.openDashboard,
      sessions: s.sessions,
      projects: s.projects,
      repositoryGroups: s.repositoryGroups,
    }))
  );
  const cliInstalled = cliStatus?.installed ?? true;
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
        label: 'Plugins',
        icon: Puzzle,
        description:
          'Small add-ons for the runtime. In multimodel mode they currently apply to Anthropic sessions when supported. Broader provider support is in development.',
      },
      {
        value: 'mcp-servers' as const,
        label: 'MCP Servers',
        icon: Server,
        description:
          'Connections to outside tools and apps. They let the runtime read data or do actions beyond this app.',
      },
      {
        value: 'skills' as const,
        label: 'Skills',
        icon: BookOpen,
        description:
          'Ready-made instructions for common jobs. They help the runtime handle repeatable tasks more consistently.',
      },
      {
        value: 'api-keys' as const,
        label: 'API Keys',
        icon: Key,
        description:
          'Secret keys for online services. Add them here so plugins, servers, and integrations can connect and work.',
      },
    ],
    []
  );

  // Fetch plugin catalog on mount
  useEffect(() => {
    void fetchPluginCatalog(projectPath ?? undefined);
  }, [fetchPluginCatalog, projectPath]);

  useEffect(() => {
    void fetchCliStatus();
  }, [fetchCliStatus]);

  // Fetch MCP installed state on mount
  useEffect(() => {
    void mcpFetchInstalled(projectPath ?? undefined);
  }, [mcpFetchInstalled, projectPath]);

  // Fetch API keys on mount
  useEffect(() => {
    void fetchApiKeys();
  }, [fetchApiKeys]);

  // Fetch Skills catalog on mount / project change
  useEffect(() => {
    void fetchSkillsCatalog(projectPath ?? undefined);
  }, [fetchSkillsCatalog, projectPath]);

  // Refresh all data (plugins + MCP browse + installed + skills)
  const handleRefresh = useCallback(() => {
    void fetchCliStatus();
    void fetchApiKeys();
    void fetchPluginCatalog(projectPath ?? undefined, true);
    void mcpBrowse(); // re-fetch first page
    void mcpFetchInstalled(projectPath ?? undefined);
    void fetchSkillsCatalog(projectPath ?? undefined);
  }, [
    fetchApiKeys,
    fetchCliStatus,
    fetchPluginCatalog,
    fetchSkillsCatalog,
    mcpBrowse,
    mcpFetchInstalled,
    projectPath,
  ]);

  const isRefreshing =
    cliStatusLoading || apiKeysLoading || pluginCatalogLoading || mcpBrowseLoading || skillsLoading;
  const mcpMutationDisableReason = useMemo(
    () =>
      getExtensionActionDisableReason({
        isInstalled: false,
        cliStatus,
        cliStatusLoading,
        section: 'mcp',
      }),
    [cliStatus, cliStatusLoading]
  );
  const cliStatusBanner = useMemo(() => {
    const providers = cliStatus?.providers ?? [];
    const visibleProviders = getVisibleMultimodelProviders(providers);
    const isMultimodel = isMultimodelRuntimeStatus(cliStatus);
    const shouldShowMultimodelProviderCards =
      isMultimodel && visibleProviders.length > 0 && cliStatus !== null;

    if ((cliStatusLoading || cliStatus === null) && !shouldShowMultimodelProviderCards) {
      return (
        <div className="bg-surface/70 mx-4 mt-3 flex items-start gap-3 rounded-md border border-border px-4 py-3">
          <Info className="mt-0.5 size-4 shrink-0 text-text-secondary" />
          <div>
            <p className="text-sm font-medium text-text">
              Checking extensions runtime availability
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              Extensions need the configured runtime to manage plugins, MCP servers, skills, and
              provider connections.
            </p>
          </div>
        </div>
      );
    }

    if (!cliStatus.installed) {
      const cliLaunchIssue = Boolean(cliStatus.binaryPath && cliStatus.launchError);
      return (
        <div className="mx-4 mt-3 flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-300">
              {cliLaunchIssue
                ? 'The configured runtime was found but failed to start'
                : 'The configured runtime is not available'}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              {cliLaunchIssue
                ? 'Extensions are disabled until the runtime passes its startup health check. Open the Dashboard to repair or reinstall it.'
                : 'Extensions are disabled until the runtime is installed. Open the Dashboard to install it and retry.'}
            </p>
            {cliLaunchIssue && cliStatus.launchError && (
              <p className="mt-2 break-all font-mono text-[11px] text-text-muted">
                {cliStatus.launchError}
              </p>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={openDashboard}>
            Open Dashboard
          </Button>
        </div>
      );
    }

    if (!isMultimodel && !cliStatus.authLoggedIn) {
      return (
        <div className="mx-4 mt-3 flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-300">Claude CLI needs sign-in</p>
            <p className="mt-0.5 text-xs text-text-muted">
              Claude CLI was found
              {cliStatus.installedVersion ? ` (${cliStatus.installedVersion})` : ''}, but plugin
              installs are disabled until you sign in from the Dashboard.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={openDashboard}>
            Open Dashboard
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
              <p className="text-sm font-medium text-text">Multimodel runtime capabilities</p>
              <p className="mt-0.5 text-xs text-text-muted">
                Provider support can differ by section. Plugins are shown only where the runtime
                explicitly declares support.
              </p>
            </div>
          </div>
          {visibleProviders.length > 0 && (
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {visibleProviders.map((provider) => {
                const providerLoading = cliProviderStatusLoading[provider.providerId] === true;
                if (isProviderCapabilityCardLoading(provider, providerLoading)) {
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
                    ? 'Needs setup'
                    : 'Unsupported';
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
                            'Ready to configure'}
                        </p>
                      </div>
                      <Badge variant="outline" className="shrink-0">
                        {statusLabel}
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
                        Plugins: {formatCliExtensionCapabilityStatus(pluginStatus)}
                      </Badge>
                      <Badge variant="secondary">
                        MCP: {formatCliExtensionCapabilityStatus(extensionCapabilities.mcp.status)}
                      </Badge>
                      <Badge variant="secondary">
                        Skills: {extensionCapabilities.skills.ownership}
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
          <p className="text-sm font-medium text-emerald-300">Claude CLI is ready</p>
          <p className="mt-0.5 text-xs text-text-muted">
            Plugins can be installed from this page
            {cliStatus.installedVersion ? ` using Claude CLI ${cliStatus.installedVersion}` : ''}.
          </p>
        </div>
      </div>
    );
  }, [cliProviderStatusLoading, cliStatus, cliStatusLoading, openDashboard]);

  // Browser mode guard
  if (!api.plugins && !api.mcpRegistry && !api.skills) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <Puzzle className="mx-auto mb-3 size-12 text-text-muted" />
          <h2 className="text-lg font-semibold text-text">Extensions</h2>
          <p className="mt-1 text-sm text-text-muted">Available in the desktop app only.</p>
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
              <h1 className="text-lg font-semibold text-text">Extensions</h1>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={isRefreshing}>
                  <RefreshCw className={`size-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh catalog</TooltipContent>
            </Tooltip>
          </div>

          {/* Sub-tabs */}
          <div className="px-6 py-4">
            {/* CLI not installed warning */}
            {!cliInstalled && (
              <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-400">
                <AlertTriangle className="size-4 shrink-0" />
                The configured runtime is required to install or uninstall extensions. Install or
                repair it from the Dashboard.
              </div>
            )}
            {/* Active sessions warning */}
            {hasOngoingSessions && (
              <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm text-blue-400">
                <Info className="size-4 shrink-0" />
                Running sessions won&apos;t pick up extension changes until restarted.
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
                      <span tabIndex={mcpMutationDisableReason ? 0 : -1}>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setCustomMcpDialogOpen(true)}
                          className="mb-1 whitespace-nowrap"
                          disabled={Boolean(mcpMutationDisableReason)}
                        >
                          <Plus className="mr-1 size-3.5" />
                          Add Custom
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
            />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};

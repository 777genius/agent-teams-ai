/**
 * ExtensionStoreView — top-level component for the Extensions tab.
 * Uses per-tab UI state via useExtensionsTabState() hook.
 * Global catalog data comes from Zustand store.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { useTabIdOptional } from '@renderer/contexts/useTabUIContext';
import { useExtensionsTabState } from '@renderer/hooks/useExtensionsTabState';
import { useStore } from '@renderer/store';
import { Tabs, TabsContent, TabsList } from '@renderer/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { AlertTriangle, BookOpen, Info, Key, Plus, Puzzle, RefreshCw, Server } from 'lucide-react';

import { ApiKeysPanel } from './apikeys/ApiKeysPanel';
import { ExtensionsSubTabTrigger } from './ExtensionsSubTabTrigger';
import { CustomMcpServerDialog } from './mcp/CustomMcpServerDialog';
import { McpServersPanel } from './mcp/McpServersPanel';
import { PluginsPanel } from './plugins/PluginsPanel';
import { SkillsPanel } from './skills/SkillsPanel';

export const ExtensionStoreView = (): React.JSX.Element => {
  const tabId = useTabIdOptional();
  const fetchPluginCatalog = useStore((s) => s.fetchPluginCatalog);
  const fetchApiKeys = useStore((s) => s.fetchApiKeys);
  const fetchSkillsCatalog = useStore((s) => s.fetchSkillsCatalog);
  const mcpBrowse = useStore((s) => s.mcpBrowse);
  const mcpFetchInstalled = useStore((s) => s.mcpFetchInstalled);
  const pluginCatalogLoading = useStore((s) => s.pluginCatalogLoading);
  const mcpBrowseLoading = useStore((s) => s.mcpBrowseLoading);
  const skillsLoading = useStore((s) => s.skillsLoading);
  const cliStatus = useStore((s) => s.cliStatus);
  const cliInstalled = cliStatus?.installed ?? true; // assume installed until checked
  const hasOngoingSessions = useStore((s) => s.sessions.some((sess) => sess.isOngoing));
  const projects = useStore((s) => s.projects);
  const extensionsTabProjectId = useStore((s) =>
    tabId
      ? (s.paneLayout.panes.flatMap((pane) => pane.tabs).find((tab) => tab.id === tabId)
          ?.projectId ?? null)
      : null
  );

  const tabState = useExtensionsTabState();
  const [customMcpDialogOpen, setCustomMcpDialogOpen] = useState(false);
  const projectPath = useMemo(
    () => projects.find((project) => project.id === extensionsTabProjectId)?.path ?? null,
    [extensionsTabProjectId, projects]
  );
  const projectLabel = useMemo(
    () => projects.find((project) => project.id === extensionsTabProjectId)?.name ?? null,
    [extensionsTabProjectId, projects]
  );
  const subTabs = useMemo(
    () => [
      {
        value: 'plugins' as const,
        label: 'Plugins',
        icon: Puzzle,
        description:
          'Small add-ons for Claude. They give the app extra features and integrations you can install when you need them.',
      },
      {
        value: 'mcp-servers' as const,
        label: 'MCP Servers',
        icon: Server,
        description:
          'Connections to outside tools and apps. They let Claude read data or do actions beyond this app.',
      },
      {
        value: 'skills' as const,
        label: 'Skills',
        icon: BookOpen,
        description:
          'Ready-made instructions for common jobs. They help Claude do specific tasks better and more consistently.',
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
    void fetchPluginCatalog(projectPath ?? undefined, true);
    void mcpBrowse(); // re-fetch first page
    void mcpFetchInstalled(projectPath ?? undefined);
    void fetchSkillsCatalog(projectPath ?? undefined);
  }, [fetchPluginCatalog, fetchSkillsCatalog, mcpBrowse, mcpFetchInstalled, projectPath]);

  const isRefreshing = pluginCatalogLoading || mcpBrowseLoading || skillsLoading;

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
                Claude CLI is required to install or uninstall extensions. Install it from Settings.
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCustomMcpDialogOpen(true)}
                    className="mb-1 whitespace-nowrap"
                  >
                    <Plus className="mr-1 size-3.5" />
                    Add Custom
                  </Button>
                )}
              </div>

              <TabsContent value="plugins" className="mt-0 pt-4">
                <PluginsPanel
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
                <ApiKeysPanel />
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
            />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};

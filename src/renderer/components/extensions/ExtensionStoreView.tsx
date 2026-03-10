/**
 * ExtensionStoreView — top-level component for the Extensions tab.
 * Uses per-tab UI state via useExtensionsTabState() hook.
 * Global catalog data comes from Zustand store.
 */

import { useCallback, useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { useExtensionsTabState } from '@renderer/hooks/useExtensionsTabState';
import { useStore } from '@renderer/store';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { AlertTriangle, Info, Key, Plus, Puzzle, RefreshCw, Server } from 'lucide-react';

import { ApiKeysPanel } from './apikeys/ApiKeysPanel';
import { CustomMcpServerDialog } from './mcp/CustomMcpServerDialog';
import { McpServersPanel } from './mcp/McpServersPanel';
import { PluginsPanel } from './plugins/PluginsPanel';

export const ExtensionStoreView = (): React.JSX.Element => {
  const fetchPluginCatalog = useStore((s) => s.fetchPluginCatalog);
  const fetchApiKeys = useStore((s) => s.fetchApiKeys);
  const mcpBrowse = useStore((s) => s.mcpBrowse);
  const mcpFetchInstalled = useStore((s) => s.mcpFetchInstalled);
  const pluginCatalogLoading = useStore((s) => s.pluginCatalogLoading);
  const mcpBrowseLoading = useStore((s) => s.mcpBrowseLoading);
  const cliStatus = useStore((s) => s.cliStatus);
  const cliInstalled = cliStatus?.installed ?? true; // assume installed until checked
  const hasOngoingSessions = useStore((s) => s.sessions.some((sess) => sess.isOngoing));

  const tabState = useExtensionsTabState();
  const [customMcpDialogOpen, setCustomMcpDialogOpen] = useState(false);

  // Fetch plugin catalog on mount
  useEffect(() => {
    void fetchPluginCatalog();
  }, [fetchPluginCatalog]);

  // Fetch MCP installed state on mount
  useEffect(() => {
    void mcpFetchInstalled();
  }, [mcpFetchInstalled]);

  // Fetch API keys on mount
  useEffect(() => {
    void fetchApiKeys();
  }, [fetchApiKeys]);

  // Refresh all data (plugins + MCP browse + installed)
  const handleRefresh = useCallback(() => {
    void fetchPluginCatalog(undefined, true);
    void mcpBrowse(); // re-fetch first page
    void mcpFetchInstalled();
  }, [fetchPluginCatalog, mcpBrowse, mcpFetchInstalled]);

  const isRefreshing = pluginCatalogLoading || mcpBrowseLoading;

  // Browser mode guard
  if (!api.plugins && !api.mcpRegistry) {
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
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <Puzzle className="size-5 text-text-muted" />
          <h1 className="text-lg font-semibold text-text">Extensions</h1>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={isRefreshing}>
                <RefreshCw className={`size-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh catalog</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Sub-tabs */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
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
            tabState.setActiveSubTab(v as 'plugins' | 'mcp-servers' | 'api-keys')
          }
        >
          <div className="mb-4 flex items-center justify-between">
            <TabsList>
              <TabsTrigger value="plugins" className="gap-1.5">
                <Puzzle className="size-3.5" />
                Plugins
              </TabsTrigger>
              <TabsTrigger value="mcp-servers" className="gap-1.5">
                <Server className="size-3.5" />
                MCP Servers
              </TabsTrigger>
              <TabsTrigger value="api-keys" className="gap-1.5">
                <Key className="size-3.5" />
                API Keys
              </TabsTrigger>
            </TabsList>
            {tabState.activeSubTab === 'mcp-servers' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCustomMcpDialogOpen(true)}
                className="whitespace-nowrap"
              >
                <Plus className="mr-1 size-3.5" />
                Add Custom
              </Button>
            )}
          </div>

          <TabsContent value="plugins">
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

          <TabsContent value="mcp-servers">
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

          <TabsContent value="api-keys">
            <ApiKeysPanel />
          </TabsContent>
        </Tabs>

        {/* Custom MCP server dialog (lifted to store view level) */}
        <CustomMcpServerDialog
          open={customMcpDialogOpen}
          onClose={() => setCustomMcpDialogOpen(false)}
        />
      </div>
    </div>
  );
};

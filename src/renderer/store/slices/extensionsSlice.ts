/**
 * Extensions slice — global catalog caches shared across all Extensions tabs.
 * Per-tab UI state lives in useExtensionsTabState() hook, NOT here.
 */

import { api } from '@renderer/api';

import type { AppState } from '../types';
import type {
  EnrichedPlugin,
  ExtensionOperationState,
  InstallScope,
  InstalledMcpEntry,
  McpCatalogItem,
  McpInstallRequest,
  PluginInstallRequest,
} from '@shared/types/extensions';
import type { StateCreator } from 'zustand';

// =============================================================================
// Slice Interface
// =============================================================================

export interface ExtensionsSlice {
  // ── Plugin catalog cache ──
  pluginCatalog: EnrichedPlugin[];
  pluginCatalogLoading: boolean;
  pluginCatalogError: string | null;
  pluginCatalogProjectPath: string | null;
  pluginReadmes: Record<string, string | null>;
  pluginReadmeLoading: Record<string, boolean>;

  // ── MCP catalog cache ──
  mcpBrowseCatalog: McpCatalogItem[];
  mcpBrowseNextCursor?: string;
  mcpBrowseLoading: boolean;
  mcpBrowseError: string | null;
  mcpInstalledServers: InstalledMcpEntry[];
  mcpInstalledProjectPath: string | null;

  // ── Install progress ──
  pluginInstallProgress: Record<string, ExtensionOperationState>;
  mcpInstallProgress: Record<string, ExtensionOperationState>;

  // ── Read actions ──
  fetchPluginCatalog: (projectPath?: string, forceRefresh?: boolean) => Promise<void>;
  fetchPluginReadme: (pluginId: string) => void;
  mcpBrowse: (cursor?: string) => Promise<void>;
  mcpFetchInstalled: (projectPath?: string) => Promise<void>;

  // ── Mutation actions ──
  installPlugin: (request: PluginInstallRequest) => Promise<void>;
  uninstallPlugin: (pluginId: string, scope?: InstallScope, projectPath?: string) => Promise<void>;
  installMcpServer: (request: McpInstallRequest) => Promise<void>;
  uninstallMcpServer: (
    registryId: string,
    name: string,
    scope?: string,
    projectPath?: string
  ) => Promise<void>;

  // ── Tab opener ──
  openExtensionsTab: () => void;
}

// =============================================================================
// Slice Creator
// =============================================================================

let pluginFetchInFlight: Promise<void> | null = null;

/** Duration to show "success" state before returning to idle */
const SUCCESS_DISPLAY_MS = 2_000;

export const createExtensionsSlice: StateCreator<AppState, [], [], ExtensionsSlice> = (
  set,
  get
) => ({
  // ── Initial state ──
  pluginCatalog: [],
  pluginCatalogLoading: false,
  pluginCatalogError: null,
  pluginCatalogProjectPath: null,
  pluginReadmes: {},
  pluginReadmeLoading: {},

  mcpBrowseCatalog: [],
  mcpBrowseNextCursor: undefined,
  mcpBrowseLoading: false,
  mcpBrowseError: null,
  mcpInstalledServers: [],
  mcpInstalledProjectPath: null,

  pluginInstallProgress: {},
  mcpInstallProgress: {},

  // ── Plugin catalog fetch ──
  fetchPluginCatalog: async (projectPath?: string, forceRefresh?: boolean) => {
    if (!api.plugins) return;

    // Dedup concurrent requests
    if (pluginFetchInFlight && !forceRefresh) {
      await pluginFetchInFlight;
      return;
    }

    set({ pluginCatalogLoading: true, pluginCatalogError: null });

    const promise = (async () => {
      try {
        const result = await api.plugins!.getAll(projectPath, forceRefresh);
        set({
          pluginCatalog: result,
          pluginCatalogLoading: false,
          pluginCatalogProjectPath: projectPath ?? null,
        });
      } catch (err) {
        set({
          pluginCatalogLoading: false,
          pluginCatalogError: err instanceof Error ? err.message : 'Failed to load plugins',
        });
      } finally {
        pluginFetchInFlight = null;
      }
    })();

    pluginFetchInFlight = promise;
    await promise;
  },

  // ── Plugin README fetch ──
  fetchPluginReadme: (pluginId: string) => {
    if (!api.plugins) return;
    const state = get();
    if (pluginId in state.pluginReadmes || state.pluginReadmeLoading[pluginId]) return;

    set((prev) => ({
      pluginReadmeLoading: { ...prev.pluginReadmeLoading, [pluginId]: true },
    }));

    void api.plugins.getReadme(pluginId).then(
      (readme) => {
        set((prev) => ({
          pluginReadmes: { ...prev.pluginReadmes, [pluginId]: readme },
          pluginReadmeLoading: { ...prev.pluginReadmeLoading, [pluginId]: false },
        }));
      },
      () => {
        set((prev) => ({
          pluginReadmes: { ...prev.pluginReadmes, [pluginId]: null },
          pluginReadmeLoading: { ...prev.pluginReadmeLoading, [pluginId]: false },
        }));
      }
    );
  },

  // ── MCP browse ──
  mcpBrowse: async (cursor?: string) => {
    if (!api.mcpRegistry) return;

    set({ mcpBrowseLoading: true, mcpBrowseError: null });
    try {
      const result = await api.mcpRegistry.browse(cursor);
      set((prev) => ({
        mcpBrowseCatalog: cursor ? [...prev.mcpBrowseCatalog, ...result.servers] : result.servers,
        mcpBrowseNextCursor: result.nextCursor,
        mcpBrowseLoading: false,
      }));
    } catch (err) {
      set({
        mcpBrowseLoading: false,
        mcpBrowseError: err instanceof Error ? err.message : 'Failed to browse MCP servers',
      });
    }
  },

  // ── MCP installed fetch ──
  mcpFetchInstalled: async (projectPath?: string) => {
    if (!api.mcpRegistry) return;

    try {
      const installed = await api.mcpRegistry.getInstalled(projectPath);
      set({
        mcpInstalledServers: installed,
        mcpInstalledProjectPath: projectPath ?? null,
      });
    } catch {
      // Silently fail — installed state is supplementary
    }
  },

  // ── Plugin install ──
  installPlugin: async (request: PluginInstallRequest) => {
    if (!api.plugins) return;

    set((prev) => ({
      pluginInstallProgress: { ...prev.pluginInstallProgress, [request.pluginId]: 'pending' },
    }));

    try {
      const result = await api.plugins.install(request);
      if (result.state === 'error') {
        set((prev) => ({
          pluginInstallProgress: { ...prev.pluginInstallProgress, [request.pluginId]: 'error' },
        }));
        return;
      }

      set((prev) => ({
        pluginInstallProgress: { ...prev.pluginInstallProgress, [request.pluginId]: 'success' },
      }));

      // Refresh catalog to pick up new installed state
      void get().fetchPluginCatalog(get().pluginCatalogProjectPath ?? undefined, true);

      // Return to idle after brief success display
      setTimeout(() => {
        set((prev) => ({
          pluginInstallProgress: { ...prev.pluginInstallProgress, [request.pluginId]: 'idle' },
        }));
      }, SUCCESS_DISPLAY_MS);
    } catch {
      set((prev) => ({
        pluginInstallProgress: { ...prev.pluginInstallProgress, [request.pluginId]: 'error' },
      }));
    }
  },

  // ── Plugin uninstall ──
  uninstallPlugin: async (pluginId: string, scope?: InstallScope, projectPath?: string) => {
    if (!api.plugins) return;

    set((prev) => ({
      pluginInstallProgress: { ...prev.pluginInstallProgress, [pluginId]: 'pending' },
    }));

    try {
      const result = await api.plugins.uninstall(pluginId, scope, projectPath);
      if (result.state === 'error') {
        set((prev) => ({
          pluginInstallProgress: { ...prev.pluginInstallProgress, [pluginId]: 'error' },
        }));
        return;
      }

      set((prev) => ({
        pluginInstallProgress: { ...prev.pluginInstallProgress, [pluginId]: 'success' },
      }));

      // Refresh catalog
      void get().fetchPluginCatalog(get().pluginCatalogProjectPath ?? undefined, true);

      setTimeout(() => {
        set((prev) => ({
          pluginInstallProgress: { ...prev.pluginInstallProgress, [pluginId]: 'idle' },
        }));
      }, SUCCESS_DISPLAY_MS);
    } catch {
      set((prev) => ({
        pluginInstallProgress: { ...prev.pluginInstallProgress, [pluginId]: 'error' },
      }));
    }
  },

  // ── MCP install ──
  installMcpServer: async (request: McpInstallRequest) => {
    if (!api.mcpRegistry) return;

    set((prev) => ({
      mcpInstallProgress: { ...prev.mcpInstallProgress, [request.registryId]: 'pending' },
    }));

    try {
      const result = await api.mcpRegistry.install(request);
      if (result.state === 'error') {
        set((prev) => ({
          mcpInstallProgress: { ...prev.mcpInstallProgress, [request.registryId]: 'error' },
        }));
        return;
      }

      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [request.registryId]: 'success' },
      }));

      // Refresh installed list
      void get().mcpFetchInstalled(get().mcpInstalledProjectPath ?? undefined);

      setTimeout(() => {
        set((prev) => ({
          mcpInstallProgress: { ...prev.mcpInstallProgress, [request.registryId]: 'idle' },
        }));
      }, SUCCESS_DISPLAY_MS);
    } catch {
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [request.registryId]: 'error' },
      }));
    }
  },

  // ── MCP uninstall ──
  uninstallMcpServer: async (
    registryId: string,
    name: string,
    scope?: string,
    projectPath?: string
  ) => {
    if (!api.mcpRegistry) return;

    set((prev) => ({
      mcpInstallProgress: { ...prev.mcpInstallProgress, [registryId]: 'pending' },
    }));

    try {
      const result = await api.mcpRegistry.uninstall(name, scope, projectPath);
      if (result.state === 'error') {
        set((prev) => ({
          mcpInstallProgress: { ...prev.mcpInstallProgress, [registryId]: 'error' },
        }));
        return;
      }

      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [registryId]: 'success' },
      }));

      void get().mcpFetchInstalled(get().mcpInstalledProjectPath ?? undefined);

      setTimeout(() => {
        set((prev) => ({
          mcpInstallProgress: { ...prev.mcpInstallProgress, [registryId]: 'idle' },
        }));
      }, SUCCESS_DISPLAY_MS);
    } catch {
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [registryId]: 'error' },
      }));
    }
  },

  // ── Tab opener ──
  openExtensionsTab: () => {
    const state = get();
    const focusedPane = state.paneLayout.panes.find((p) => p.id === state.paneLayout.focusedPaneId);
    const existingTab = focusedPane?.tabs.find((tab) => tab.type === 'extensions');
    if (existingTab) {
      state.setActiveTab(existingTab.id);
      return;
    }

    state.openTab({
      type: 'extensions',
      label: 'Extensions',
    });
  },
});

/**
 * Extensions slice — global catalog caches shared across all Extensions tabs.
 * Per-tab UI state lives in useExtensionsTabState() hook, NOT here.
 */

import { api } from '@renderer/api';

import type { AppState } from '../types';
import type {
  ApiKeyEntry,
  ApiKeySaveRequest,
  ApiKeyStorageStatus,
  EnrichedPlugin,
  ExtensionOperationState,
  InstallScope,
  InstalledMcpEntry,
  McpCatalogItem,
  McpCustomInstallRequest,
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
  installErrors: Record<string, string>; // keyed by pluginId or registryId

  // ── API Keys ──
  apiKeys: ApiKeyEntry[];
  apiKeysLoading: boolean;
  apiKeysError: string | null;
  apiKeySaving: boolean;
  apiKeyStorageStatus: ApiKeyStorageStatus | null;

  // ── GitHub Stars (supplementary) ──
  mcpGitHubStars: Record<string, number>;

  // ── Read actions ──
  fetchPluginCatalog: (projectPath?: string, forceRefresh?: boolean) => Promise<void>;
  fetchPluginReadme: (pluginId: string) => void;
  mcpBrowse: (cursor?: string) => Promise<void>;
  mcpFetchInstalled: (projectPath?: string) => Promise<void>;

  // ── Mutation actions ──
  installPlugin: (request: PluginInstallRequest) => Promise<void>;
  uninstallPlugin: (pluginId: string, scope?: InstallScope, projectPath?: string) => Promise<void>;
  installMcpServer: (request: McpInstallRequest) => Promise<void>;
  installCustomMcpServer: (request: McpCustomInstallRequest) => Promise<void>;
  uninstallMcpServer: (
    registryId: string,
    name: string,
    scope?: string,
    projectPath?: string
  ) => Promise<void>;

  // ── API Keys actions ──
  fetchApiKeys: () => Promise<void>;
  fetchApiKeyStorageStatus: () => Promise<void>;
  saveApiKey: (request: ApiKeySaveRequest) => Promise<void>;
  deleteApiKey: (id: string) => Promise<void>;

  // ── Tab opener ──
  openExtensionsTab: () => void;

  // ── GitHub Stars ──
  fetchMcpGitHubStars: (repositoryUrls: string[]) => void;
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
  installErrors: {},

  apiKeys: [],
  apiKeysLoading: false,
  apiKeysError: null,
  apiKeySaving: false,
  apiKeyStorageStatus: null,

  mcpGitHubStars: {},

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
      set((prev) => {
        if (!cursor) {
          return {
            mcpBrowseCatalog: result.servers,
            mcpBrowseNextCursor: result.nextCursor,
            mcpBrowseLoading: false,
          };
        }
        // Deduplicate: existing IDs take precedence
        const existingIds = new Set(prev.mcpBrowseCatalog.map((s) => s.id));
        const newServers = result.servers.filter((s) => !existingIds.has(s.id));
        return {
          mcpBrowseCatalog: [...prev.mcpBrowseCatalog, ...newServers],
          mcpBrowseNextCursor: result.nextCursor,
          mcpBrowseLoading: false,
        };
      });
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
          installErrors: {
            ...prev.installErrors,
            [request.pluginId]: result.error ?? 'Install failed',
          },
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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Install failed';
      set((prev) => ({
        pluginInstallProgress: { ...prev.pluginInstallProgress, [request.pluginId]: 'error' },
        installErrors: { ...prev.installErrors, [request.pluginId]: message },
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
          installErrors: { ...prev.installErrors, [pluginId]: result.error ?? 'Uninstall failed' },
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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Uninstall failed';
      set((prev) => ({
        pluginInstallProgress: { ...prev.pluginInstallProgress, [pluginId]: 'error' },
        installErrors: { ...prev.installErrors, [pluginId]: message },
      }));
    }
  },

  // ── MCP install ──
  installMcpServer: async (request: McpInstallRequest) => {
    if (!api.mcpRegistry) {
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [request.registryId]: 'error' },
        installErrors: {
          ...prev.installErrors,
          [request.registryId]: 'MCP Registry not available',
        },
      }));
      return;
    }

    set((prev) => ({
      mcpInstallProgress: { ...prev.mcpInstallProgress, [request.registryId]: 'pending' },
    }));

    try {
      const result = await api.mcpRegistry.install(request);
      if (result.state === 'error') {
        set((prev) => ({
          mcpInstallProgress: { ...prev.mcpInstallProgress, [request.registryId]: 'error' },
          installErrors: {
            ...prev.installErrors,
            [request.registryId]: result.error ?? 'Install failed',
          },
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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Install failed';
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [request.registryId]: 'error' },
        installErrors: { ...prev.installErrors, [request.registryId]: message },
      }));
    }
  },

  // ── MCP custom install ──
  installCustomMcpServer: async (request: McpCustomInstallRequest) => {
    if (!api.mcpRegistry) {
      const progressKey = `custom:${request.serverName}`;
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [progressKey]: 'error' },
        installErrors: { ...prev.installErrors, [progressKey]: 'MCP Registry not available' },
      }));
      return;
    }

    const progressKey = `custom:${request.serverName}`;
    set((prev) => ({
      mcpInstallProgress: { ...prev.mcpInstallProgress, [progressKey]: 'pending' },
    }));

    try {
      const result = await api.mcpRegistry.installCustom(request);
      if (result.state === 'error') {
        set((prev) => ({
          mcpInstallProgress: { ...prev.mcpInstallProgress, [progressKey]: 'error' },
          installErrors: { ...prev.installErrors, [progressKey]: result.error ?? 'Install failed' },
        }));
        return;
      }

      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [progressKey]: 'success' },
      }));

      // Refresh installed list
      void get().mcpFetchInstalled(get().mcpInstalledProjectPath ?? undefined);

      setTimeout(() => {
        set((prev) => ({
          mcpInstallProgress: { ...prev.mcpInstallProgress, [progressKey]: 'idle' },
        }));
      }, SUCCESS_DISPLAY_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Install failed';
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [progressKey]: 'error' },
        installErrors: { ...prev.installErrors, [progressKey]: message },
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
    if (!api.mcpRegistry) {
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [registryId]: 'error' },
        installErrors: { ...prev.installErrors, [registryId]: 'MCP Registry not available' },
      }));
      return;
    }

    set((prev) => ({
      mcpInstallProgress: { ...prev.mcpInstallProgress, [registryId]: 'pending' },
    }));

    try {
      const result = await api.mcpRegistry.uninstall(name, scope, projectPath);
      if (result.state === 'error') {
        set((prev) => ({
          mcpInstallProgress: { ...prev.mcpInstallProgress, [registryId]: 'error' },
          installErrors: {
            ...prev.installErrors,
            [registryId]: result.error ?? 'Uninstall failed',
          },
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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Uninstall failed';
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [registryId]: 'error' },
        installErrors: { ...prev.installErrors, [registryId]: message },
      }));
    }
  },

  // ── API Keys fetch ──
  fetchApiKeys: async () => {
    if (!api.apiKeys) return;

    set({ apiKeysLoading: true, apiKeysError: null });
    try {
      const keys = await api.apiKeys.list();
      set({ apiKeys: keys, apiKeysLoading: false });
    } catch (err) {
      set({
        apiKeysLoading: false,
        apiKeysError: err instanceof Error ? err.message : 'Failed to load API keys',
      });
    }
  },

  fetchApiKeyStorageStatus: async () => {
    if (!api.apiKeys) return;
    try {
      const status = await api.apiKeys.getStorageStatus();
      set({ apiKeyStorageStatus: status });
    } catch {
      // Non-critical — UI will just not show the info icon
    }
  },

  // ── API Key save ──
  saveApiKey: async (request: ApiKeySaveRequest) => {
    if (!api.apiKeys) return;

    set({ apiKeySaving: true, apiKeysError: null });
    try {
      await api.apiKeys.save(request);
      // Refresh the list to get updated masked values
      const keys = await api.apiKeys.list();
      set({ apiKeys: keys, apiKeySaving: false });
    } catch (err) {
      set({
        apiKeySaving: false,
        apiKeysError: err instanceof Error ? err.message : 'Failed to save API key',
      });
      throw err; // Re-throw so the dialog can show the error
    }
  },

  // ── API Key delete ──
  deleteApiKey: async (id: string) => {
    if (!api.apiKeys) return;

    try {
      await api.apiKeys.delete(id);
      set((prev) => ({
        apiKeys: prev.apiKeys.filter((k) => k.id !== id),
      }));
    } catch (err) {
      set({
        apiKeysError: err instanceof Error ? err.message : 'Failed to delete API key',
      });
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

  // ── GitHub Stars (fire-and-forget) ──
  fetchMcpGitHubStars: (repositoryUrls: string[]) => {
    if (!api.mcpRegistry || repositoryUrls.length === 0) return;
    void api.mcpRegistry
      .githubStars(repositoryUrls)
      .then((stars) => {
        if (Object.keys(stars).length > 0) {
          set((prev) => ({
            mcpGitHubStars: { ...prev.mcpGitHubStars, ...stars },
          }));
        }
      })
      .catch(() => {
        // Silent failure — stars are supplementary data
      });
  },
});

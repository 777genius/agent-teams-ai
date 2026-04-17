/**
 * Extensions slice — global catalog caches shared across all Extensions tabs.
 * Per-tab UI state lives in useExtensionsTabState() hook, NOT here.
 */

import { api } from '@renderer/api';
import { CLI_NOT_FOUND_MESSAGE } from '@shared/constants/cli';
import { getMcpOperationKey, getPluginOperationKey } from '@shared/utils/extensionNormalizers';

import { findPaneByTabId, updatePane } from '../utils/paneHelpers';

import type { AppState } from '../types';
import type {
  ApiKeyEntry,
  ApiKeySaveRequest,
  ApiKeyStorageStatus,
  EnrichedPlugin,
  ExtensionOperationState,
  InstalledMcpEntry,
  InstallScope,
  McpCatalogItem,
  McpCustomInstallRequest,
  McpInstallRequest,
  McpServerDiagnostic,
  PluginInstallRequest,
  SkillCatalogItem,
  SkillDeleteRequest,
  SkillDetail,
  SkillImportRequest,
  SkillReviewPreview,
  SkillUpsertRequest,
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
  mcpDiagnostics: Record<string, McpServerDiagnostic>;
  mcpDiagnosticsLoading: boolean;
  mcpDiagnosticsError: string | null;
  mcpDiagnosticsLastCheckedAt: number | null;

  // ── Install progress ──
  pluginInstallProgress: Record<string, ExtensionOperationState>;
  mcpInstallProgress: Record<string, ExtensionOperationState>;
  installErrors: Record<string, string>; // keyed by scoped operation key

  // ── API Keys ──
  apiKeys: ApiKeyEntry[];
  apiKeysLoading: boolean;
  apiKeysError: string | null;
  apiKeySaving: boolean;
  apiKeyStorageStatus: ApiKeyStorageStatus | null;

  // ── Skills catalog cache ──
  skillsUserCatalog: SkillCatalogItem[];
  skillsProjectCatalogByProjectPath: Record<string, SkillCatalogItem[]>;
  skillsCatalogLoadingByProjectPath: Record<string, boolean>;
  skillsCatalogErrorByProjectPath: Record<string, string | null>;
  skillsLoading: boolean;
  skillsError: string | null;
  skillsDetailsById: Record<string, SkillDetail | null | undefined>;
  skillsDetailLoadingById: Record<string, boolean>;
  skillsDetailErrorById: Record<string, string | null>;
  skillsMutationLoading: boolean;
  skillsMutationError: string | null;

  // ── GitHub Stars (supplementary) ──
  mcpGitHubStars: Record<string, number>;

  // ── Read actions ──
  fetchPluginCatalog: (projectPath?: string, forceRefresh?: boolean) => Promise<void>;
  fetchPluginReadme: (pluginId: string) => void;
  mcpBrowse: (cursor?: string) => Promise<void>;
  mcpFetchInstalled: (projectPath?: string) => Promise<void>;
  runMcpDiagnostics: () => Promise<void>;
  fetchSkillsCatalog: (projectPath?: string) => Promise<void>;
  fetchSkillDetail: (skillId: string, projectPath?: string) => Promise<void>;
  previewSkillUpsert: (request: SkillUpsertRequest) => Promise<SkillReviewPreview>;
  applySkillUpsert: (request: SkillUpsertRequest) => Promise<SkillDetail | null>;
  previewSkillImport: (request: SkillImportRequest) => Promise<SkillReviewPreview>;
  applySkillImport: (request: SkillImportRequest) => Promise<SkillDetail | null>;
  deleteSkill: (request: SkillDeleteRequest) => Promise<void>;

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

let pluginFetchInFlight: { key: string; promise: Promise<void>; token: symbol } | null = null;
let pluginCatalogRequestSeq = 0;
const pluginSuccessResetTimers = new Map<string, ReturnType<typeof setTimeout>>();
const mcpSuccessResetTimers = new Map<string, ReturnType<typeof setTimeout>>();
let mcpDiagnosticsInFlight: Promise<void> | null = null;
let skillsCatalogRequestSeq = 0;
let skillsDetailRequestSeq = 0;
const latestSkillsCatalogRequestByKey = new Map<string, number>();
const latestSkillsDetailRequestById = new Map<string, number>();

const USER_SKILLS_CATALOG_KEY = '__user__';

function hasAnyLoading(loadingMap: Record<string, boolean>): boolean {
  return Object.values(loadingMap).some(Boolean);
}

function getPluginCatalogKey(projectPath?: string): string {
  return projectPath ?? '__user__';
}

function buildPluginIdSet(catalog: EnrichedPlugin[]): Set<string> {
  return new Set(catalog.map((plugin) => plugin.pluginId));
}

function buildPluginOperationKeys(pluginId: string): string[] {
  return PLUGIN_OPERATION_SCOPES.map((scope) => getPluginOperationKey(pluginId, scope));
}

function clearPluginOperationState(
  pluginIds: Set<string>,
  pluginInstallProgress: Record<string, ExtensionOperationState>,
  installErrors: Record<string, string>
): {
  pluginInstallProgress: Record<string, ExtensionOperationState>;
  installErrors: Record<string, string>;
} {
  if (pluginIds.size === 0) {
    return { pluginInstallProgress, installErrors };
  }

  const nextPluginInstallProgress = { ...pluginInstallProgress };
  const nextInstallErrors = { ...installErrors };

  for (const pluginId of pluginIds) {
    for (const operationKey of buildPluginOperationKeys(pluginId)) {
      delete nextPluginInstallProgress[operationKey];
      delete nextInstallErrors[operationKey];
    }
  }

  return {
    pluginInstallProgress: nextPluginInstallProgress,
    installErrors: nextInstallErrors,
  };
}

function clearPluginSuccessResetTimer(operationKey: string): void {
  const timer = pluginSuccessResetTimers.get(operationKey);
  if (!timer) {
    return;
  }

  clearTimeout(timer);
  pluginSuccessResetTimers.delete(operationKey);
}

function clearPluginSuccessResetTimers(pluginIds: Set<string>): void {
  for (const pluginId of pluginIds) {
    for (const operationKey of buildPluginOperationKeys(pluginId)) {
      clearPluginSuccessResetTimer(operationKey);
    }
  }
}

function schedulePluginSuccessReset(
  operationKey: string,
  set: Parameters<StateCreator<AppState, [], [], ExtensionsSlice>>[0]
): void {
  clearPluginSuccessResetTimer(operationKey);
  const timer = setTimeout(() => {
    pluginSuccessResetTimers.delete(operationKey);
    set((prev) => {
      if (prev.pluginInstallProgress[operationKey] !== 'success') {
        return {};
      }

      return {
        pluginInstallProgress: { ...prev.pluginInstallProgress, [operationKey]: 'idle' },
      };
    });
  }, SUCCESS_DISPLAY_MS);
  pluginSuccessResetTimers.set(operationKey, timer);
}

function getCustomMcpOperationKey(serverName: string, scope: InstallScope): string {
  return `mcp-custom:${serverName}:${scope}`;
}

function clearMcpSuccessResetTimer(operationKey: string): void {
  const timer = mcpSuccessResetTimers.get(operationKey);
  if (!timer) {
    return;
  }

  clearTimeout(timer);
  mcpSuccessResetTimers.delete(operationKey);
}

function scheduleMcpSuccessReset(
  operationKey: string,
  set: Parameters<StateCreator<AppState, [], [], ExtensionsSlice>>[0]
): void {
  clearMcpSuccessResetTimer(operationKey);
  const timer = setTimeout(() => {
    mcpSuccessResetTimers.delete(operationKey);
    set((prev) => {
      if (prev.mcpInstallProgress[operationKey] !== 'success') {
        return {};
      }

      return {
        mcpInstallProgress: { ...prev.mcpInstallProgress, [operationKey]: 'idle' },
      };
    });
  }, SUCCESS_DISPLAY_MS);
  mcpSuccessResetTimers.set(operationKey, timer);
}

function clearMcpProjectScopedOperationState(
  mcpInstallProgress: Record<string, ExtensionOperationState>,
  installErrors: Record<string, string>
): {
  mcpInstallProgress: Record<string, ExtensionOperationState>;
  installErrors: Record<string, string>;
} {
  const nextMcpInstallProgress = { ...mcpInstallProgress };
  const nextInstallErrors = { ...installErrors };

  for (const operationKey of Object.keys(nextMcpInstallProgress)) {
    if (
      (operationKey.startsWith('mcp:') || operationKey.startsWith('mcp-custom:')) &&
      (operationKey.endsWith(':project') || operationKey.endsWith(':local'))
    ) {
      delete nextMcpInstallProgress[operationKey];
    }
  }

  for (const operationKey of Object.keys(nextInstallErrors)) {
    if (
      (operationKey.startsWith('mcp:') || operationKey.startsWith('mcp-custom:')) &&
      (operationKey.endsWith(':project') || operationKey.endsWith(':local'))
    ) {
      delete nextInstallErrors[operationKey];
    }
  }

  return {
    mcpInstallProgress: nextMcpInstallProgress,
    installErrors: nextInstallErrors,
  };
}

function clearMcpProjectScopedSuccessResetTimers(): void {
  for (const operationKey of Array.from(mcpSuccessResetTimers.keys())) {
    if (operationKey.endsWith(':project') || operationKey.endsWith(':local')) {
      clearMcpSuccessResetTimer(operationKey);
    }
  }
}

function getSkillsCatalogKey(projectPath?: string): string {
  return projectPath ?? USER_SKILLS_CATALOG_KEY;
}

/** Duration to show "success" state before returning to idle */
const SUCCESS_DISPLAY_MS = 2_000;
const CLI_AUTH_REQUIRED_MESSAGE =
  'Claude CLI is installed but not signed in. Go to the Dashboard and sign in to enable plugin installs.';
const CLI_HEALTHCHECK_FAILED_MESSAGE =
  'Claude CLI was found but failed its startup health check. Open the Dashboard to repair or reinstall it before retrying.';
const CLI_STATUS_UNKNOWN_MESSAGE =
  'Unable to verify Claude CLI status. Open the Dashboard and check the CLI before retrying.';
const PROJECT_SCOPE_REQUIRED_MESSAGE =
  'Project- and local-scoped plugins require an active project in the Extensions tab.';
const PLUGIN_OPERATION_SCOPES: InstallScope[] = ['user', 'project', 'local'];

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
  mcpDiagnostics: {},
  mcpDiagnosticsLoading: false,
  mcpDiagnosticsError: null,
  mcpDiagnosticsLastCheckedAt: null,

  pluginInstallProgress: {},
  mcpInstallProgress: {},
  installErrors: {},

  apiKeys: [],
  apiKeysLoading: false,
  apiKeysError: null,
  apiKeySaving: false,
  apiKeyStorageStatus: null,

  skillsUserCatalog: [],
  skillsProjectCatalogByProjectPath: {},
  skillsCatalogLoadingByProjectPath: {},
  skillsCatalogErrorByProjectPath: {},
  skillsLoading: false,
  skillsError: null,
  skillsDetailsById: {},
  skillsDetailLoadingById: {},
  skillsDetailErrorById: {},
  skillsMutationLoading: false,
  skillsMutationError: null,

  mcpGitHubStars: {},

  // ── Plugin catalog fetch ──
  fetchPluginCatalog: async (projectPath?: string, forceRefresh?: boolean) => {
    if (!api.plugins) return;
    const requestKey = getPluginCatalogKey(projectPath);

    // Dedup concurrent requests
    if (pluginFetchInFlight && !forceRefresh && pluginFetchInFlight.key === requestKey) {
      await pluginFetchInFlight.promise;
      return;
    }

    const requestSeq = ++pluginCatalogRequestSeq;
    const requestToken = Symbol('pluginCatalogRequest');
    set({ pluginCatalogLoading: true, pluginCatalogError: null });

    const promise = (async () => {
      try {
        const result = await api.plugins!.getAll(projectPath, forceRefresh);
        set((prev) => {
          if (requestSeq !== pluginCatalogRequestSeq) {
            return {};
          }

          const nextProjectPath = projectPath ?? null;
          const isSameProjectContext = prev.pluginCatalogProjectPath === nextProjectPath;
          const pluginIdsToClear = isSameProjectContext
            ? new Set<string>()
            : new Set([...buildPluginIdSet(prev.pluginCatalog), ...buildPluginIdSet(result)]);
          const nextOperationState = clearPluginOperationState(
            pluginIdsToClear,
            prev.pluginInstallProgress,
            prev.installErrors
          );
          clearPluginSuccessResetTimers(pluginIdsToClear);

          return {
            pluginCatalog: result,
            pluginCatalogLoading: false,
            pluginCatalogError: null,
            pluginCatalogProjectPath: nextProjectPath,
            pluginInstallProgress: nextOperationState.pluginInstallProgress,
            installErrors: nextOperationState.installErrors,
          };
        });
      } catch (err) {
        set((prev) => {
          if (requestSeq !== pluginCatalogRequestSeq) {
            return {};
          }

          const nextProjectPath = projectPath ?? null;
          const isSameProjectContext = prev.pluginCatalogProjectPath === nextProjectPath;
          const nextOperationState = clearPluginOperationState(
            isSameProjectContext ? new Set<string>() : buildPluginIdSet(prev.pluginCatalog),
            prev.pluginInstallProgress,
            prev.installErrors
          );
          clearPluginSuccessResetTimers(
            isSameProjectContext ? new Set<string>() : buildPluginIdSet(prev.pluginCatalog)
          );

          return {
            pluginCatalog: isSameProjectContext ? prev.pluginCatalog : [],
            pluginCatalogLoading: false,
            pluginCatalogError: err instanceof Error ? err.message : 'Failed to load plugins',
            pluginCatalogProjectPath: nextProjectPath,
            pluginInstallProgress: nextOperationState.pluginInstallProgress,
            installErrors: nextOperationState.installErrors,
          };
        });
      } finally {
        if (pluginFetchInFlight?.token === requestToken) {
          pluginFetchInFlight = null;
        }
      }
    })();

    pluginFetchInFlight = { key: requestKey, promise, token: requestToken };
    await promise;
  },

  // ── Plugin README fetch ──
  fetchPluginReadme: (pluginId: string) => {
    if (!api.plugins) return;
    const state = get();
    const cachedReadme = state.pluginReadmes[pluginId];
    if (
      (cachedReadme !== undefined && cachedReadme !== null) ||
      state.pluginReadmeLoading[pluginId]
    ) {
      return;
    }

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
      set((prev) => {
        const nextProjectPath = projectPath ?? null;
        const isSameProjectContext = prev.mcpInstalledProjectPath === nextProjectPath;
        const nextOperationState = isSameProjectContext
          ? {
              mcpInstallProgress: prev.mcpInstallProgress,
              installErrors: prev.installErrors,
            }
          : clearMcpProjectScopedOperationState(prev.mcpInstallProgress, prev.installErrors);

        if (!isSameProjectContext) {
          clearMcpProjectScopedSuccessResetTimers();
        }

        return {
          mcpInstalledServers: installed,
          mcpInstalledProjectPath: nextProjectPath,
          mcpInstallProgress: nextOperationState.mcpInstallProgress,
          installErrors: nextOperationState.installErrors,
        };
      });
    } catch {
      // Silently fail — installed state is supplementary
    }
  },

  runMcpDiagnostics: async () => {
    const mcpRegistry = api.mcpRegistry;
    if (!mcpRegistry) return;

    if (mcpDiagnosticsInFlight) {
      await mcpDiagnosticsInFlight;
      return;
    }

    set({ mcpDiagnosticsLoading: true, mcpDiagnosticsError: null });

    const promise = (async () => {
      try {
        const diagnostics = await mcpRegistry.diagnose();
        set({
          mcpDiagnostics: Object.fromEntries(
            diagnostics.map((entry) => [entry.name, entry] as const)
          ),
          mcpDiagnosticsLoading: false,
          mcpDiagnosticsLastCheckedAt: Date.now(),
        });
      } catch (err) {
        set({
          mcpDiagnosticsLoading: false,
          mcpDiagnosticsError:
            err instanceof Error ? err.message : 'Failed to check MCP server health',
        });
      } finally {
        mcpDiagnosticsInFlight = null;
      }
    })();

    mcpDiagnosticsInFlight = promise;
    await promise;
  },

  fetchSkillsCatalog: async (projectPath?: string) => {
    if (!api.skills) return;

    const requestKey = getSkillsCatalogKey(projectPath);
    const requestId = ++skillsCatalogRequestSeq;
    latestSkillsCatalogRequestByKey.set(requestKey, requestId);

    set((prev) => {
      const nextLoadingByProjectPath = {
        ...prev.skillsCatalogLoadingByProjectPath,
        [requestKey]: true,
      };
      return {
        skillsCatalogLoadingByProjectPath: nextLoadingByProjectPath,
        skillsCatalogErrorByProjectPath: {
          ...prev.skillsCatalogErrorByProjectPath,
          [requestKey]: null,
        },
        skillsLoading: hasAnyLoading(nextLoadingByProjectPath),
        skillsError: null,
      };
    });
    try {
      const skills = await api.skills.list(projectPath);
      if (latestSkillsCatalogRequestByKey.get(requestKey) !== requestId) {
        return;
      }

      set((prev) => ({
        skillsCatalogLoadingByProjectPath: {
          ...prev.skillsCatalogLoadingByProjectPath,
          [requestKey]: false,
        },
        skillsCatalogErrorByProjectPath: {
          ...prev.skillsCatalogErrorByProjectPath,
          [requestKey]: null,
        },
        skillsLoading: hasAnyLoading({
          ...prev.skillsCatalogLoadingByProjectPath,
          [requestKey]: false,
        }),
        skillsError: null,
        skillsUserCatalog: skills.filter((skill) => skill.scope === 'user'),
        skillsProjectCatalogByProjectPath: projectPath
          ? {
              ...prev.skillsProjectCatalogByProjectPath,
              [projectPath]: skills.filter((skill) => skill.scope === 'project'),
            }
          : prev.skillsProjectCatalogByProjectPath,
      }));
    } catch (err) {
      if (latestSkillsCatalogRequestByKey.get(requestKey) !== requestId) {
        return;
      }

      const message = err instanceof Error ? err.message : 'Failed to load skills';
      set((prev) => ({
        skillsCatalogLoadingByProjectPath: {
          ...prev.skillsCatalogLoadingByProjectPath,
          [requestKey]: false,
        },
        skillsCatalogErrorByProjectPath: {
          ...prev.skillsCatalogErrorByProjectPath,
          [requestKey]: message,
        },
        skillsLoading: hasAnyLoading({
          ...prev.skillsCatalogLoadingByProjectPath,
          [requestKey]: false,
        }),
        skillsError: message,
      }));
    }
  },

  fetchSkillDetail: async (skillId: string, projectPath?: string) => {
    if (!api.skills) return;

    const requestId = ++skillsDetailRequestSeq;
    latestSkillsDetailRequestById.set(skillId, requestId);

    set((prev) => ({
      skillsDetailLoadingById: { ...prev.skillsDetailLoadingById, [skillId]: true },
      skillsDetailErrorById: { ...prev.skillsDetailErrorById, [skillId]: null },
    }));

    try {
      const detail = await api.skills.getDetail(skillId, projectPath);
      if (latestSkillsDetailRequestById.get(skillId) !== requestId) {
        return;
      }

      set((prev) => ({
        skillsDetailsById: { ...prev.skillsDetailsById, [skillId]: detail },
        skillsDetailLoadingById: { ...prev.skillsDetailLoadingById, [skillId]: false },
        skillsDetailErrorById: { ...prev.skillsDetailErrorById, [skillId]: null },
      }));
    } catch (err) {
      if (latestSkillsDetailRequestById.get(skillId) !== requestId) {
        return;
      }

      const message = err instanceof Error ? err.message : 'Failed to load skill details';
      set((prev) => ({
        skillsDetailLoadingById: { ...prev.skillsDetailLoadingById, [skillId]: false },
        skillsDetailErrorById: { ...prev.skillsDetailErrorById, [skillId]: message },
      }));
      throw err;
    }
  },

  previewSkillUpsert: async (request: SkillUpsertRequest) => {
    if (!api.skills) {
      throw new Error('Skills API is not available');
    }

    set({ skillsMutationLoading: true, skillsMutationError: null });
    try {
      const preview = await api.skills.previewUpsert(request);
      set({ skillsMutationLoading: false });
      return preview;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to review skill changes';
      set({ skillsMutationLoading: false, skillsMutationError: message });
      throw err;
    }
  },

  applySkillUpsert: async (request: SkillUpsertRequest) => {
    if (!api.skills) {
      throw new Error('Skills API is not available');
    }

    set({ skillsMutationLoading: true, skillsMutationError: null });
    try {
      const detail = await api.skills.applyUpsert(request);
      await get().fetchSkillsCatalog(request.projectPath);
      set((prev) => ({
        skillsMutationLoading: false,
        skillsDetailsById: detail?.item.id
          ? { ...prev.skillsDetailsById, [detail.item.id]: detail }
          : prev.skillsDetailsById,
      }));
      return detail;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save skill';
      set({ skillsMutationLoading: false, skillsMutationError: message });
      throw err;
    }
  },

  previewSkillImport: async (request: SkillImportRequest) => {
    if (!api.skills) {
      throw new Error('Skills API is not available');
    }

    set({ skillsMutationLoading: true, skillsMutationError: null });
    try {
      const preview = await api.skills.previewImport(request);
      set({ skillsMutationLoading: false });
      return preview;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to review import changes';
      set({ skillsMutationLoading: false, skillsMutationError: message });
      throw err;
    }
  },

  applySkillImport: async (request: SkillImportRequest) => {
    if (!api.skills) {
      throw new Error('Skills API is not available');
    }

    set({ skillsMutationLoading: true, skillsMutationError: null });
    try {
      const detail = await api.skills.applyImport(request);
      await get().fetchSkillsCatalog(request.projectPath);
      set((prev) => ({
        skillsMutationLoading: false,
        skillsDetailsById: detail?.item.id
          ? { ...prev.skillsDetailsById, [detail.item.id]: detail }
          : prev.skillsDetailsById,
      }));
      return detail;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to import skill';
      set({ skillsMutationLoading: false, skillsMutationError: message });
      throw err;
    }
  },

  deleteSkill: async (request: SkillDeleteRequest) => {
    if (!api.skills) {
      throw new Error('Skills API is not available');
    }

    set({ skillsMutationLoading: true, skillsMutationError: null });
    try {
      await api.skills.deleteSkill(request);
      await get().fetchSkillsCatalog(request.projectPath);
      set((prev) => {
        const nextDetails = { ...prev.skillsDetailsById };
        delete nextDetails[request.skillId];
        return {
          skillsMutationLoading: false,
          skillsDetailsById: nextDetails,
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete skill';
      set({ skillsMutationLoading: false, skillsMutationError: message });
      throw err;
    }
  },

  // ── Plugin install ──
  installPlugin: async (request: PluginInstallRequest) => {
    if (!api.plugins) return;

    const effectiveProjectPath =
      request.scope !== 'user'
        ? (request.projectPath ?? get().pluginCatalogProjectPath ?? undefined)
        : request.projectPath;
    const operationKey = getPluginOperationKey(request.pluginId, request.scope);
    const effectiveRequest =
      effectiveProjectPath === request.projectPath
        ? request
        : { ...request, projectPath: effectiveProjectPath };

    const preflightState = get();
    if (preflightState.cliStatus === null || preflightState.cliStatusLoading) {
      try {
        await preflightState.fetchCliStatus();
      } catch {
        // fetchCliStatus stores the error in cliStatusError; map to a user-facing install error below.
      }
    }

    const cliStatus = get().cliStatus;
    const preflightError =
      effectiveRequest.scope !== 'user' && !effectiveRequest.projectPath
        ? PROJECT_SCOPE_REQUIRED_MESSAGE
        : cliStatus === null
          ? CLI_STATUS_UNKNOWN_MESSAGE
          : !cliStatus.installed
            ? cliStatus.binaryPath && cliStatus.launchError
              ? CLI_HEALTHCHECK_FAILED_MESSAGE
              : CLI_NOT_FOUND_MESSAGE
            : !cliStatus.authLoggedIn
              ? CLI_AUTH_REQUIRED_MESSAGE
              : null;

    if (preflightError) {
      clearPluginSuccessResetTimer(operationKey);
      set((prev) => ({
        pluginInstallProgress: { ...prev.pluginInstallProgress, [operationKey]: 'error' },
        installErrors: { ...prev.installErrors, [operationKey]: preflightError },
      }));
      return;
    }

    clearPluginSuccessResetTimer(operationKey);
    set((prev) => ({
      pluginInstallProgress: { ...prev.pluginInstallProgress, [operationKey]: 'pending' },
      installErrors: { ...prev.installErrors, [operationKey]: '' },
    }));

    try {
      const result = await api.plugins.install(effectiveRequest);
      if (result.state === 'error') {
        set((prev) => ({
          pluginInstallProgress: { ...prev.pluginInstallProgress, [operationKey]: 'error' },
          installErrors: {
            ...prev.installErrors,
            [operationKey]: result.error ?? 'Install failed',
          },
        }));
        return;
      }

      set((prev) => ({
        pluginInstallProgress: { ...prev.pluginInstallProgress, [operationKey]: 'success' },
      }));

      // Refresh catalog to pick up new installed state
      void get().fetchPluginCatalog(get().pluginCatalogProjectPath ?? undefined, true);

      schedulePluginSuccessReset(operationKey, set);
    } catch (err) {
      clearPluginSuccessResetTimer(operationKey);
      const message = err instanceof Error ? err.message : 'Install failed';
      set((prev) => ({
        pluginInstallProgress: { ...prev.pluginInstallProgress, [operationKey]: 'error' },
        installErrors: { ...prev.installErrors, [operationKey]: message },
      }));
    }
  },

  // ── Plugin uninstall ──
  uninstallPlugin: async (pluginId: string, scope?: InstallScope, projectPath?: string) => {
    if (!api.plugins) return;

    const effectiveScope = scope ?? 'user';
    const operationKey = getPluginOperationKey(pluginId, effectiveScope);
    const effectiveProjectPath =
      effectiveScope !== 'user'
        ? (projectPath ?? get().pluginCatalogProjectPath ?? undefined)
        : projectPath;
    if (effectiveScope !== 'user' && !effectiveProjectPath) {
      clearPluginSuccessResetTimer(operationKey);
      set((prev) => ({
        pluginInstallProgress: { ...prev.pluginInstallProgress, [operationKey]: 'error' },
        installErrors: { ...prev.installErrors, [operationKey]: PROJECT_SCOPE_REQUIRED_MESSAGE },
      }));
      return;
    }

    clearPluginSuccessResetTimer(operationKey);
    set((prev) => ({
      pluginInstallProgress: { ...prev.pluginInstallProgress, [operationKey]: 'pending' },
    }));

    try {
      const result = await api.plugins.uninstall(pluginId, scope, effectiveProjectPath);
      if (result.state === 'error') {
        set((prev) => ({
          pluginInstallProgress: { ...prev.pluginInstallProgress, [operationKey]: 'error' },
          installErrors: {
            ...prev.installErrors,
            [operationKey]: result.error ?? 'Uninstall failed',
          },
        }));
        return;
      }

      set((prev) => ({
        pluginInstallProgress: { ...prev.pluginInstallProgress, [operationKey]: 'success' },
      }));

      // Refresh catalog
      void get().fetchPluginCatalog(get().pluginCatalogProjectPath ?? undefined, true);

      schedulePluginSuccessReset(operationKey, set);
    } catch (err) {
      clearPluginSuccessResetTimer(operationKey);
      const message = err instanceof Error ? err.message : 'Uninstall failed';
      set((prev) => ({
        pluginInstallProgress: { ...prev.pluginInstallProgress, [operationKey]: 'error' },
        installErrors: { ...prev.installErrors, [operationKey]: message },
      }));
    }
  },

  // ── MCP install ──
  installMcpServer: async (request: McpInstallRequest) => {
    const operationKey = getMcpOperationKey(request.registryId, request.scope);
    if (!api.mcpRegistry) {
      clearMcpSuccessResetTimer(operationKey);
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [operationKey]: 'error' },
        installErrors: {
          ...prev.installErrors,
          [operationKey]: 'MCP Registry not available',
        },
      }));
      return;
    }

    clearMcpSuccessResetTimer(operationKey);
    set((prev) => ({
      mcpInstallProgress: { ...prev.mcpInstallProgress, [operationKey]: 'pending' },
    }));

    try {
      const result = await api.mcpRegistry.install(request);
      if (result.state === 'error') {
        set((prev) => ({
          mcpInstallProgress: { ...prev.mcpInstallProgress, [operationKey]: 'error' },
          installErrors: {
            ...prev.installErrors,
            [operationKey]: result.error ?? 'Install failed',
          },
        }));
        return;
      }

      await Promise.all([
        get().mcpFetchInstalled(get().mcpInstalledProjectPath ?? undefined),
        get().runMcpDiagnostics(),
      ]);

      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [operationKey]: 'success' },
      }));

      scheduleMcpSuccessReset(operationKey, set);
    } catch (err) {
      clearMcpSuccessResetTimer(operationKey);
      const message = err instanceof Error ? err.message : 'Install failed';
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [operationKey]: 'error' },
        installErrors: { ...prev.installErrors, [operationKey]: message },
      }));
    }
  },

  // ── MCP custom install ──
  installCustomMcpServer: async (request: McpCustomInstallRequest) => {
    const operationScope = request.scope;
    const progressKey = getCustomMcpOperationKey(request.serverName, operationScope);
    if (!api.mcpRegistry) {
      clearMcpSuccessResetTimer(progressKey);
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [progressKey]: 'error' },
        installErrors: { ...prev.installErrors, [progressKey]: 'MCP Registry not available' },
      }));
      return;
    }

    clearMcpSuccessResetTimer(progressKey);
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

      await Promise.all([
        get().mcpFetchInstalled(get().mcpInstalledProjectPath ?? undefined),
        get().runMcpDiagnostics(),
      ]);

      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [progressKey]: 'success' },
      }));

      scheduleMcpSuccessReset(progressKey, set);
    } catch (err) {
      clearMcpSuccessResetTimer(progressKey);
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
    const operationScope: InstallScope = scope === 'project' || scope === 'local' ? scope : 'user';
    const operationKey = getMcpOperationKey(registryId, operationScope);
    if (!api.mcpRegistry) {
      clearMcpSuccessResetTimer(operationKey);
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [operationKey]: 'error' },
        installErrors: { ...prev.installErrors, [operationKey]: 'MCP Registry not available' },
      }));
      return;
    }

    clearMcpSuccessResetTimer(operationKey);
    set((prev) => ({
      mcpInstallProgress: { ...prev.mcpInstallProgress, [operationKey]: 'pending' },
    }));

    try {
      const result = await api.mcpRegistry.uninstall(name, scope, projectPath);
      if (result.state === 'error') {
        set((prev) => ({
          mcpInstallProgress: { ...prev.mcpInstallProgress, [operationKey]: 'error' },
          installErrors: {
            ...prev.installErrors,
            [operationKey]: result.error ?? 'Uninstall failed',
          },
        }));
        return;
      }

      await Promise.all([
        get().mcpFetchInstalled(get().mcpInstalledProjectPath ?? undefined),
        get().runMcpDiagnostics(),
      ]);

      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [operationKey]: 'success' },
      }));

      scheduleMcpSuccessReset(operationKey, set);
    } catch (err) {
      clearMcpSuccessResetTimer(operationKey);
      const message = err instanceof Error ? err.message : 'Uninstall failed';
      set((prev) => ({
        mcpInstallProgress: { ...prev.mcpInstallProgress, [operationKey]: 'error' },
        installErrors: { ...prev.installErrors, [operationKey]: message },
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
      throw err;
    }
  },

  // ── Tab opener ──
  openExtensionsTab: () => {
    const state = get();
    const currentProjectId = state.selectedProjectId ?? state.activeProjectId ?? undefined;
    const focusedPane = state.paneLayout.panes.find((p) => p.id === state.paneLayout.focusedPaneId);
    const existingTab = focusedPane?.tabs.find((tab) => tab.type === 'extensions');
    if (existingTab) {
      // Update projectId to reflect the currently selected project
      if (existingTab.projectId !== currentProjectId) {
        const pane = findPaneByTabId(state.paneLayout, existingTab.id);
        if (pane) {
          set({
            paneLayout: updatePane(state.paneLayout, {
              ...pane,
              tabs: pane.tabs.map((t) =>
                t.id === existingTab.id ? { ...t, projectId: currentProjectId } : t
              ),
            }),
          });
        }
      }
      state.setActiveTab(existingTab.id);
      return;
    }

    state.openTab({
      type: 'extensions',
      label: 'Extensions',
      projectId: currentProjectId,
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

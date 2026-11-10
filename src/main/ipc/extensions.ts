/**
 * IPC handlers for Extension Store (plugin catalog + MCP registry).
 *
 * Phase 2: read-only plugin catalog (getAll, getReadme).
 * Phase 3: read-only MCP registry (search, browse, getById, getInstalled).
 * Phase 5: install/uninstall mutations.
 */

import {
  API_KEYS_DELETE,
  API_KEYS_LIST,
  API_KEYS_LOOKUP,
  API_KEYS_SAVE,
  API_KEYS_STORAGE_STATUS,
  MCP_GITHUB_STARS,
  MCP_REGISTRY_BROWSE,
  MCP_REGISTRY_DIAGNOSE,
  MCP_REGISTRY_GET_BY_ID,
  MCP_REGISTRY_GET_INSTALLED,
  MCP_REGISTRY_INSTALL,
  MCP_REGISTRY_INSTALL_CUSTOM,
  MCP_REGISTRY_SEARCH,
  MCP_REGISTRY_UNINSTALL,
  PLUGIN_GET_ALL,
  PLUGIN_GET_README,
  PLUGIN_INSTALL,
  PLUGIN_UNINSTALL,
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';

import { type ApiKeyService } from '../services/extensions/apikeys/ApiKeyService';
import { GitHubStarsService } from '../services/extensions/catalog/GitHubStarsService';

import { captureDesktopNativeExtensions } from './agentBackend';

import type { ExtensionFacadeService } from '../services/extensions/ExtensionFacadeService';
import type { McpInstallService } from '../services/extensions/install/McpInstallService';
import type { PluginInstallService } from '../services/extensions/install/PluginInstallService';
import type { NativeExtensionCapture } from '../services/extensions/runtime/CapturedNativeExtensions';
import type { McpHealthDiagnosticsService } from '../services/extensions/state/McpHealthDiagnosticsService';
import type {
  ApiKeyEntry,
  ApiKeyLookupResult,
  ApiKeySaveRequest,
  ApiKeyStorageStatus,
  EnrichedPlugin,
  InstalledMcpEntry,
  McpCatalogItem,
  McpCustomInstallRequest,
  McpInstallRequest,
  McpSearchResult,
  McpServerDiagnostic,
  OperationResult,
  PluginInstallRequest,
} from '@shared/types/extensions';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:extensions');

/** Allowed scope values. Multimodel runtimes expose `global` for MCPs, not Claude plugins. */
const VALID_PLUGIN_SCOPES = new Set(['local', 'user', 'project']);
const VALID_MCP_SCOPES = new Set(['local', 'user', 'project', 'global']);
const isPluginScope = (value: string): value is PluginInstallRequest['scope'] =>
  VALID_PLUGIN_SCOPES.has(value);
const isMcpScope = (value: string): value is McpInstallRequest['scope'] =>
  VALID_MCP_SCOPES.has(value);

// ── Module state ───────────────────────────────────────────────────────────

const starsService = new GitHubStarsService();
let captureNative: NativeExtensionCapture | undefined;

let extensionFacade: ExtensionFacadeService | null = null;
let pluginInstaller: PluginInstallService | null = null;
let mcpInstaller: McpInstallService | null = null;
let apiKeyService: ApiKeyService | null = null;
let mcpHealthDiagnostics: McpHealthDiagnosticsService | null = null;

// ── Lifecycle ──────────────────────────────────────────────────────────────

export function initializeExtensionHandlers(
  facade: ExtensionFacadeService,
  pluginInstall?: PluginInstallService,
  mcpInstall?: McpInstallService,
  apiKeys?: ApiKeyService,
  mcpDiagnostics?: McpHealthDiagnosticsService
): void {
  extensionFacade = facade;
  pluginInstaller = pluginInstall ?? null;
  mcpInstaller = mcpInstall ?? null;
  apiKeyService = apiKeys ?? null;
  mcpHealthDiagnostics = mcpDiagnostics ?? null;
}

export function registerExtensionHandlers(
  ipcMain: IpcMain,
  nativeCapture: NativeExtensionCapture = captureDesktopNativeExtensions
): void {
  captureNative = nativeCapture;
  ipcMain.handle(PLUGIN_GET_ALL, handleGetAll);
  ipcMain.handle(PLUGIN_GET_README, handleGetReadme);
  ipcMain.handle(PLUGIN_INSTALL, handlePluginInstall);
  ipcMain.handle(PLUGIN_UNINSTALL, handlePluginUninstall);
  ipcMain.handle(MCP_REGISTRY_SEARCH, handleMcpSearch);
  ipcMain.handle(MCP_REGISTRY_BROWSE, handleMcpBrowse);
  ipcMain.handle(MCP_REGISTRY_GET_BY_ID, handleMcpGetById);
  ipcMain.handle(MCP_REGISTRY_GET_INSTALLED, handleMcpGetInstalled);
  ipcMain.handle(MCP_REGISTRY_DIAGNOSE, handleMcpDiagnose);
  ipcMain.handle(MCP_REGISTRY_INSTALL, handleMcpInstall);
  ipcMain.handle(MCP_REGISTRY_INSTALL_CUSTOM, handleMcpInstallCustom);
  ipcMain.handle(MCP_REGISTRY_UNINSTALL, handleMcpUninstall);
  ipcMain.handle(API_KEYS_LIST, handleApiKeysList);
  ipcMain.handle(API_KEYS_SAVE, handleApiKeysSave);
  ipcMain.handle(API_KEYS_DELETE, handleApiKeysDelete);
  ipcMain.handle(API_KEYS_LOOKUP, handleApiKeysLookup);
  ipcMain.handle(API_KEYS_STORAGE_STATUS, handleApiKeysStorageStatus);
  ipcMain.handle(MCP_GITHUB_STARS, handleMcpGitHubStars);
}

export function removeExtensionHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(PLUGIN_GET_ALL);
  ipcMain.removeHandler(PLUGIN_GET_README);
  ipcMain.removeHandler(PLUGIN_INSTALL);
  ipcMain.removeHandler(PLUGIN_UNINSTALL);
  ipcMain.removeHandler(MCP_REGISTRY_SEARCH);
  ipcMain.removeHandler(MCP_REGISTRY_BROWSE);
  ipcMain.removeHandler(MCP_REGISTRY_GET_BY_ID);
  ipcMain.removeHandler(MCP_REGISTRY_GET_INSTALLED);
  ipcMain.removeHandler(MCP_REGISTRY_DIAGNOSE);
  ipcMain.removeHandler(MCP_REGISTRY_INSTALL);
  ipcMain.removeHandler(MCP_REGISTRY_INSTALL_CUSTOM);
  ipcMain.removeHandler(MCP_REGISTRY_UNINSTALL);
  ipcMain.removeHandler(API_KEYS_LIST);
  ipcMain.removeHandler(API_KEYS_SAVE);
  ipcMain.removeHandler(API_KEYS_DELETE);
  ipcMain.removeHandler(API_KEYS_LOOKUP);
  ipcMain.removeHandler(API_KEYS_STORAGE_STATUS);
  ipcMain.removeHandler(MCP_GITHUB_STARS);
}

// ── Service guard ──────────────────────────────────────────────────────────

function getFacade(): ExtensionFacadeService {
  if (!extensionFacade) {
    throw new Error('Extension handlers are not initialized');
  }
  return extensionFacade;
}

// ── Error wrapper ──────────────────────────────────────────────────────────

interface IpcResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function wrapHandler<T>(operation: string, handler: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    const data = await handler();
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[extensions:${operation}] ${message}`);
    return { success: false, error: message };
  }
}

// ── Plugin Handlers ────────────────────────────────────────────────────────

async function handleGetAll(
  event: IpcMainInvokeEvent,
  projectPath?: string,
  forceRefresh?: boolean
): Promise<IpcResult<EnrichedPlugin[]>> {
  return wrapHandler('getAll', async () => {
    const project = typeof projectPath === 'string' ? projectPath : undefined;
    const native = await captureNative?.(event, project, {
      panel: 'plugins',
      scope: project ? 'project' : 'user',
    });
    return getFacade().getEnrichedPlugins(
      project,
      typeof forceRefresh === 'boolean' ? forceRefresh : false,
      await native?.plugins()
    );
  });
}

async function handleGetReadme(
  _event: IpcMainInvokeEvent,
  pluginId?: string
): Promise<IpcResult<string | null>> {
  return wrapHandler('getReadme', () => {
    if (typeof pluginId !== 'string' || !pluginId) {
      throw new Error('pluginId is required');
    }
    return getFacade().getPluginReadme(pluginId);
  });
}

// ── MCP Handlers ───────────────────────────────────────────────────────────

async function handleMcpSearch(
  _event: IpcMainInvokeEvent,
  query?: string,
  limit?: number
): Promise<IpcResult<McpSearchResult>> {
  return wrapHandler('mcpSearch', () =>
    getFacade().searchMcp(
      typeof query === 'string' ? query : '',
      typeof limit === 'number' ? limit : undefined
    )
  );
}

async function handleMcpBrowse(
  _event: IpcMainInvokeEvent,
  cursor?: string,
  limit?: number
): Promise<IpcResult<{ servers: McpCatalogItem[]; nextCursor?: string }>> {
  return wrapHandler('mcpBrowse', () =>
    getFacade().browseMcp(
      typeof cursor === 'string' ? cursor : undefined,
      typeof limit === 'number' ? limit : undefined
    )
  );
}

async function handleMcpGetById(
  _event: IpcMainInvokeEvent,
  registryId?: string
): Promise<IpcResult<McpCatalogItem | null>> {
  return wrapHandler('mcpGetById', () => {
    if (typeof registryId !== 'string' || !registryId) {
      throw new Error('registryId is required');
    }
    return getFacade().getMcpById(registryId);
  });
}

async function handleMcpGetInstalled(
  event: IpcMainInvokeEvent,
  projectPath?: string
): Promise<IpcResult<InstalledMcpEntry[]>> {
  return wrapHandler('mcpGetInstalled', async () => {
    const project = typeof projectPath === 'string' ? projectPath : undefined;
    const native = await captureNative?.(event, project, {
      panel: 'mcp',
      scope: project ? 'project' : 'user',
    });
    return native ? native.mcp() : getFacade().getInstalledMcp(project);
  });
}

function getMcpHealthDiagnostics(): McpHealthDiagnosticsService {
  if (!mcpHealthDiagnostics) {
    throw new Error('MCP health diagnostics not initialized');
  }
  return mcpHealthDiagnostics;
}

async function handleMcpDiagnose(
  event: IpcMainInvokeEvent,
  projectPath?: string
): Promise<IpcResult<McpServerDiagnostic[]>> {
  return wrapHandler('mcpDiagnose', async () => {
    const project = typeof projectPath === 'string' ? projectPath : undefined;
    const native = await captureNative?.(event, project, {
      panel: 'mcp',
      scope: project ? 'project' : 'user',
    });
    return native ? native.diagnose() : getMcpHealthDiagnostics().diagnose(project);
  });
}

// ── Install/Uninstall Handlers ────────────────────────────────────────────

function getPluginInstaller(): PluginInstallService {
  if (!pluginInstaller) {
    throw new Error('Plugin installer not initialized');
  }
  return pluginInstaller;
}

function getMcpInstaller(): McpInstallService {
  if (!mcpInstaller) {
    throw new Error('MCP installer not initialized');
  }
  return mcpInstaller;
}

async function handlePluginInstall(
  event: IpcMainInvokeEvent,
  request?: PluginInstallRequest
): Promise<IpcResult<OperationResult>> {
  return wrapHandler('pluginInstall', async () => {
    if (!request || typeof request.pluginId !== 'string' || !request.pluginId) {
      throw new Error('Invalid install request: pluginId is required');
    }
    if (!VALID_PLUGIN_SCOPES.has(request.scope)) {
      throw new Error(`Invalid scope: "${request.scope}"`);
    }
    const captured = structuredClone(request);
    const native = await captureNative?.(event, captured.projectPath, {
      panel: 'plugins',
      scope: captured.scope,
    });
    const result = await getPluginInstaller().install(captured, native);
    if (result.state === 'success') {
      getFacade().invalidateInstalledCache();
    }
    return result;
  });
}

async function handlePluginUninstall(
  event: IpcMainInvokeEvent,
  pluginId?: string,
  scope?: string,
  projectPath?: string
): Promise<IpcResult<OperationResult>> {
  return wrapHandler('pluginUninstall', async () => {
    if (typeof pluginId !== 'string' || !pluginId) {
      throw new Error('pluginId is required');
    }
    if (scope !== undefined && !isPluginScope(scope)) {
      throw new Error(`Invalid scope: "${scope}"`);
    }
    const native = await captureNative?.(
      event,
      typeof projectPath === 'string' ? projectPath : undefined,
      { panel: 'plugins', scope: scope ?? 'user' }
    );
    const result = await getPluginInstaller().uninstall(
      pluginId,
      typeof scope === 'string' ? scope : undefined,
      typeof projectPath === 'string' ? projectPath : undefined,
      native
    );
    if (result.state === 'success') {
      getFacade().invalidateInstalledCache();
    }
    return result;
  });
}

async function handleMcpInstall(
  event: IpcMainInvokeEvent,
  request?: McpInstallRequest
): Promise<IpcResult<OperationResult>> {
  return wrapHandler('mcpInstall', async () => {
    if (!request || typeof request.registryId !== 'string' || !request.registryId) {
      throw new Error('Invalid install request: registryId is required');
    }
    if (typeof request.serverName !== 'string' || !request.serverName) {
      throw new Error('Invalid install request: serverName is required');
    }
    if (!VALID_MCP_SCOPES.has(request.scope)) {
      throw new Error(`Invalid scope: "${request.scope}"`);
    }
    const captured = structuredClone(request);
    const native = await captureNative?.(event, captured.projectPath, {
      panel: 'mcp',
      scope: captured.scope,
    });
    const result = await getMcpInstaller().install(captured, native);
    if (result.state === 'success') {
      getFacade().invalidateInstalledCache();
    }
    return result;
  });
}

async function handleMcpInstallCustom(
  event: IpcMainInvokeEvent,
  request?: McpCustomInstallRequest
): Promise<IpcResult<OperationResult>> {
  return wrapHandler('mcpInstallCustom', async () => {
    if (!request || typeof request.serverName !== 'string' || !request.serverName) {
      throw new Error('Invalid custom install request: serverName is required');
    }
    if (!request.installSpec) {
      throw new Error('Invalid custom install request: installSpec is required');
    }
    if (!VALID_MCP_SCOPES.has(request.scope)) {
      throw new Error(`Invalid scope: "${request.scope}"`);
    }
    const captured = structuredClone(request);
    const native = await captureNative?.(event, captured.projectPath, {
      panel: 'mcp',
      scope: captured.scope,
    });
    const result = await getMcpInstaller().installCustom(captured, native);
    if (result.state === 'success') {
      getFacade().invalidateInstalledCache();
    }
    return result;
  });
}

async function handleMcpUninstall(
  event: IpcMainInvokeEvent,
  name?: string,
  scope?: string,
  projectPath?: string
): Promise<IpcResult<OperationResult>> {
  return wrapHandler('mcpUninstall', async () => {
    if (typeof name !== 'string' || !name) {
      throw new Error('Server name is required');
    }
    if (scope !== undefined && !isMcpScope(scope)) {
      throw new Error(`Invalid scope: "${scope}"`);
    }
    const native = await captureNative?.(
      event,
      typeof projectPath === 'string' ? projectPath : undefined,
      { panel: 'mcp', scope: scope ?? 'local' }
    );
    const result = await getMcpInstaller().uninstall(
      name,
      typeof scope === 'string' ? scope : undefined,
      typeof projectPath === 'string' ? projectPath : undefined,
      native
    );
    if (result.state === 'success') {
      getFacade().invalidateInstalledCache();
    }
    return result;
  });
}

// ── API Keys Guard ─────────────────────────────────────────────────────────

function getApiKeyService(): ApiKeyService {
  if (!apiKeyService) throw new Error('API key service not initialized');
  return apiKeyService;
}

// ── API Keys Handlers ──────────────────────────────────────────────────────

async function handleApiKeysList(): Promise<IpcResult<ApiKeyEntry[]>> {
  return wrapHandler('apiKeysList', () => getApiKeyService().list());
}

async function handleApiKeysSave(
  _event: IpcMainInvokeEvent,
  request?: ApiKeySaveRequest
): Promise<IpcResult<ApiKeyEntry>> {
  return wrapHandler('apiKeysSave', () => {
    if (!request) throw new Error('Request is required');
    return getApiKeyService().save(request);
  });
}

async function handleApiKeysDelete(
  _event: IpcMainInvokeEvent,
  id?: string
): Promise<IpcResult<void>> {
  return wrapHandler('apiKeysDelete', () => {
    if (typeof id !== 'string' || !id) throw new Error('Key ID is required');
    return getApiKeyService().delete(id);
  });
}

async function handleApiKeysLookup(
  _event: IpcMainInvokeEvent,
  envVarNames?: string[],
  projectPath?: string
): Promise<IpcResult<ApiKeyLookupResult[]>> {
  return wrapHandler('apiKeysLookup', () => {
    if (!Array.isArray(envVarNames)) throw new Error('envVarNames array is required');
    return getApiKeyService().lookup(
      envVarNames,
      typeof projectPath === 'string' ? projectPath : undefined
    );
  });
}

async function handleApiKeysStorageStatus(): Promise<IpcResult<ApiKeyStorageStatus>> {
  return wrapHandler('apiKeysStorageStatus', () => getApiKeyService().getStorageStatus());
}

// ── GitHub Stars Handler ──────────────────────────────────────────────────

async function handleMcpGitHubStars(
  _event: IpcMainInvokeEvent,
  repositoryUrls?: string[]
): Promise<IpcResult<Record<string, number>>> {
  return wrapHandler('mcpGitHubStars', () => {
    if (!Array.isArray(repositoryUrls)) throw new Error('repositoryUrls array is required');
    return starsService.fetchStars(repositoryUrls);
  });
}

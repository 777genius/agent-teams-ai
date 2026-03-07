/**
 * IPC handlers for Extension Store (plugin catalog + MCP registry).
 *
 * Phase 2: read-only plugin catalog (getAll, getReadme).
 * Phase 3: read-only MCP registry (search, browse, getById, getInstalled).
 * Phase 5: install/uninstall mutations.
 */

import { createLogger } from '@shared/utils/logger';
import type {
  EnrichedPlugin,
  InstalledMcpEntry,
  McpCatalogItem,
  McpInstallRequest,
  McpSearchResult,
  OperationResult,
  PluginInstallRequest,
} from '@shared/types/extensions';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import type { ExtensionFacadeService } from '../services/extensions/ExtensionFacadeService';
import type { PluginInstallService } from '../services/extensions/install/PluginInstallService';
import type { McpInstallService } from '../services/extensions/install/McpInstallService';

import {
  MCP_REGISTRY_BROWSE,
  MCP_REGISTRY_GET_BY_ID,
  MCP_REGISTRY_GET_INSTALLED,
  MCP_REGISTRY_INSTALL,
  MCP_REGISTRY_SEARCH,
  MCP_REGISTRY_UNINSTALL,
  PLUGIN_GET_ALL,
  PLUGIN_GET_README,
  PLUGIN_INSTALL,
  PLUGIN_UNINSTALL,
} from '@preload/constants/ipcChannels';

const logger = createLogger('IPC:extensions');

/** Allowed scope values */
const VALID_SCOPES = new Set(['local', 'user', 'project']);

// ── Module state ───────────────────────────────────────────────────────────

let extensionFacade: ExtensionFacadeService | null = null;
let pluginInstaller: PluginInstallService | null = null;
let mcpInstaller: McpInstallService | null = null;

// ── Lifecycle ──────────────────────────────────────────────────────────────

export function initializeExtensionHandlers(
  facade: ExtensionFacadeService,
  pluginInstall?: PluginInstallService,
  mcpInstall?: McpInstallService
): void {
  extensionFacade = facade;
  pluginInstaller = pluginInstall ?? null;
  mcpInstaller = mcpInstall ?? null;
}

export function registerExtensionHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(PLUGIN_GET_ALL, handleGetAll);
  ipcMain.handle(PLUGIN_GET_README, handleGetReadme);
  ipcMain.handle(PLUGIN_INSTALL, handlePluginInstall);
  ipcMain.handle(PLUGIN_UNINSTALL, handlePluginUninstall);
  ipcMain.handle(MCP_REGISTRY_SEARCH, handleMcpSearch);
  ipcMain.handle(MCP_REGISTRY_BROWSE, handleMcpBrowse);
  ipcMain.handle(MCP_REGISTRY_GET_BY_ID, handleMcpGetById);
  ipcMain.handle(MCP_REGISTRY_GET_INSTALLED, handleMcpGetInstalled);
  ipcMain.handle(MCP_REGISTRY_INSTALL, handleMcpInstall);
  ipcMain.handle(MCP_REGISTRY_UNINSTALL, handleMcpUninstall);
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
  ipcMain.removeHandler(MCP_REGISTRY_INSTALL);
  ipcMain.removeHandler(MCP_REGISTRY_UNINSTALL);
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
  _event: IpcMainInvokeEvent,
  projectPath?: string,
  forceRefresh?: boolean
): Promise<IpcResult<EnrichedPlugin[]>> {
  return wrapHandler('getAll', () =>
    getFacade().getEnrichedPlugins(
      typeof projectPath === 'string' ? projectPath : undefined,
      typeof forceRefresh === 'boolean' ? forceRefresh : false
    )
  );
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
  _event: IpcMainInvokeEvent,
  projectPath?: string
): Promise<IpcResult<InstalledMcpEntry[]>> {
  return wrapHandler('mcpGetInstalled', () =>
    getFacade().getInstalledMcp(typeof projectPath === 'string' ? projectPath : undefined)
  );
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
  _event: IpcMainInvokeEvent,
  request?: PluginInstallRequest
): Promise<IpcResult<OperationResult>> {
  return wrapHandler('pluginInstall', () => {
    if (!request || typeof request.pluginId !== 'string' || !request.pluginId) {
      throw new Error('Invalid install request: pluginId is required');
    }
    if (request.scope && !VALID_SCOPES.has(request.scope)) {
      throw new Error(`Invalid scope: "${request.scope}"`);
    }
    return getPluginInstaller().install(request);
  });
}

async function handlePluginUninstall(
  _event: IpcMainInvokeEvent,
  pluginId?: string,
  scope?: string,
  projectPath?: string
): Promise<IpcResult<OperationResult>> {
  return wrapHandler('pluginUninstall', () => {
    if (typeof pluginId !== 'string' || !pluginId) {
      throw new Error('pluginId is required');
    }
    if (scope && !VALID_SCOPES.has(scope)) {
      throw new Error(`Invalid scope: "${scope}"`);
    }
    return getPluginInstaller().uninstall(
      pluginId,
      typeof scope === 'string' ? scope : undefined,
      typeof projectPath === 'string' ? projectPath : undefined
    );
  });
}

async function handleMcpInstall(
  _event: IpcMainInvokeEvent,
  request?: McpInstallRequest
): Promise<IpcResult<OperationResult>> {
  return wrapHandler('mcpInstall', () => {
    if (!request || typeof request.registryId !== 'string' || !request.registryId) {
      throw new Error('Invalid install request: registryId is required');
    }
    if (typeof request.serverName !== 'string' || !request.serverName) {
      throw new Error('Invalid install request: serverName is required');
    }
    if (request.scope && !VALID_SCOPES.has(request.scope)) {
      throw new Error(`Invalid scope: "${request.scope}"`);
    }
    return getMcpInstaller().install(request);
  });
}

async function handleMcpUninstall(
  _event: IpcMainInvokeEvent,
  name?: string,
  scope?: string,
  projectPath?: string
): Promise<IpcResult<OperationResult>> {
  return wrapHandler('mcpUninstall', () => {
    if (typeof name !== 'string' || !name) {
      throw new Error('Server name is required');
    }
    if (scope && !VALID_SCOPES.has(scope)) {
      throw new Error(`Invalid scope: "${scope}"`);
    }
    return getMcpInstaller().uninstall(
      name,
      typeof scope === 'string' ? scope : undefined,
      typeof projectPath === 'string' ? projectPath : undefined
    );
  });
}

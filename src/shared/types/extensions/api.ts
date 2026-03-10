/**
 * Extension Store API contracts — exposed via preload bridge.
 * Both APIs are OPTIONAL in ElectronAPI (Electron-only V1).
 */

import type {
  ApiKeyEntry,
  ApiKeyLookupResult,
  ApiKeySaveRequest,
  ApiKeyStorageStatus,
} from './apikey';
import type { InstallScope, OperationResult } from './common';
import type { EnrichedPlugin, PluginInstallRequest } from './plugin';
import type {
  InstalledMcpEntry,
  McpCatalogItem,
  McpCustomInstallRequest,
  McpInstallRequest,
  McpSearchResult,
} from './mcp';

// ── Plugin API ─────────────────────────────────────────────────────────────

export interface PluginCatalogAPI {
  getAll: (projectPath?: string, forceRefresh?: boolean) => Promise<EnrichedPlugin[]>;
  getReadme: (pluginId: string) => Promise<string | null>;
  install: (request: PluginInstallRequest) => Promise<OperationResult>;
  uninstall: (
    pluginId: string,
    scope?: InstallScope,
    projectPath?: string
  ) => Promise<OperationResult>;
}

// ── MCP API ────────────────────────────────────────────────────────────────

export interface McpCatalogAPI {
  search: (query: string, limit?: number) => Promise<McpSearchResult>;
  browse: (
    cursor?: string,
    limit?: number
  ) => Promise<{ servers: McpCatalogItem[]; nextCursor?: string }>;
  getById: (registryId: string) => Promise<McpCatalogItem | null>;
  getInstalled: (projectPath?: string) => Promise<InstalledMcpEntry[]>;
  install: (request: McpInstallRequest) => Promise<OperationResult>;
  installCustom: (request: McpCustomInstallRequest) => Promise<OperationResult>;
  uninstall: (name: string, scope?: string, projectPath?: string) => Promise<OperationResult>;
  githubStars: (repositoryUrls: string[]) => Promise<Record<string, number>>;
}

// ── API Keys API ──────────────────────────────────────────────────────────

export interface ApiKeysAPI {
  list: () => Promise<ApiKeyEntry[]>;
  save: (request: ApiKeySaveRequest) => Promise<ApiKeyEntry>;
  delete: (id: string) => Promise<void>;
  lookup: (envVarNames: string[]) => Promise<ApiKeyLookupResult[]>;
  getStorageStatus: () => Promise<ApiKeyStorageStatus>;
}

/**
 * Extension Store API contracts — exposed via preload bridge.
 * Both APIs are OPTIONAL in ElectronAPI (Electron-only V1).
 */

import type { InstallScope, OperationResult } from './common';
import type { EnrichedPlugin, PluginInstallRequest } from './plugin';
import type { InstalledMcpEntry, McpCatalogItem, McpInstallRequest, McpSearchResult } from './mcp';

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
  uninstall: (name: string, scope?: string, projectPath?: string) => Promise<OperationResult>;
}

/**
 * Extension Store types — barrel export.
 */

export type { ExtensionOperationState, InstallScope, OperationResult } from './common';

export type {
  EnrichedPlugin,
  InstalledPluginEntry,
  PluginCapability,
  PluginCatalogItem,
  PluginFilters,
  PluginInstallRequest,
  PluginSortField,
} from './plugin';
export { inferCapabilities } from './plugin';

export type {
  InstalledMcpEntry,
  McpCatalogItem,
  McpCustomInstallRequest,
  McpEnvVarDef,
  McpHeaderDef,
  McpHostingType,
  McpHttpInstallSpec,
  McpInstallRequest,
  McpInstallSpec,
  McpSearchResult,
  McpStdioInstallSpec,
  McpToolDef,
} from './mcp';

export type {
  ApiKeyEntry,
  ApiKeyLookupResult,
  ApiKeySaveRequest,
  ApiKeyStorageStatus,
} from './apikey';

export type { ApiKeysAPI, McpCatalogAPI, PluginCatalogAPI } from './api';

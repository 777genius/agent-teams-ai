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
  McpEnvVarDef,
  McpHeaderDef,
  McpHttpInstallSpec,
  McpInstallRequest,
  McpInstallSpec,
  McpSearchResult,
  McpStdioInstallSpec,
  McpToolDef,
} from './mcp';

export type { McpCatalogAPI, PluginCatalogAPI } from './api';

/**
 * Extension Store types — barrel export.
 */

export type { ApiKeysAPI, McpCatalogAPI, PluginCatalogAPI, SkillsCatalogAPI } from './api';
export type {
  ApiKeyEntry,
  ApiKeyLookupResult,
  ApiKeySaveRequest,
  ApiKeyStorageStatus,
} from './apikey';
export type { ExtensionOperationState, InstallScope, OperationResult } from './common';
export type {
  InstalledMcpEntry,
  McpAuthHeaderDef,
  McpCatalogItem,
  McpCustomInstallRequest,
  McpEnvVarDef,
  McpHeaderDef,
  McpHostingType,
  McpHttpInstallSpec,
  McpInstallRequest,
  McpInstallSpec,
  McpSearchResult,
  McpServerDiagnostic,
  McpServerHealthStatus,
  McpStdioInstallSpec,
  McpToolDef,
} from './mcp';
export type {
  EnrichedPlugin,
  InstalledPluginEntry,
  PluginCapability,
  PluginCatalogItem,
  PluginFilters,
  PluginInstallRequest,
  PluginInstallScope,
  PluginSortField,
} from './plugin';
export { inferCapabilities } from './plugin';
export type {
  CreateSkillRequest,
  DeleteSkillRequest,
  SkillCatalogItem,
  SkillDeleteRequest,
  SkillDetail,
  SkillDirectoryFlags,
  SkillDraft,
  SkillDraftFile,
  SkillDraftTemplateInput,
  SkillImportRequest,
  SkillInvocationMode,
  SkillIssueSeverity,
  SkillReviewAction,
  SkillReviewFileChange,
  SkillReviewPreview,
  SkillReviewSummary,
  SkillRootKind,
  SkillSaveResult,
  SkillScope,
  SkillSourceType,
  SkillUpsertRequest,
  SkillValidationIssue,
  SkillWatcherEvent,
  UpdateSkillRequest,
} from './skill';

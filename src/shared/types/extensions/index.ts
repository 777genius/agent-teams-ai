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
  McpAuthHeaderDef,
  McpCatalogItem,
  McpCustomInstallRequest,
  McpServerDiagnostic,
  McpServerHealthStatus,
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
  CreateSkillRequest,
  DeleteSkillRequest,
  SkillCatalogItem,
  SkillDeleteRequest,
  SkillDraft,
  SkillDraftFile,
  SkillDraftTemplateInput,
  SkillDetail,
  SkillDirectoryFlags,
  SkillImportRequest,
  SkillInvocationMode,
  SkillIssueSeverity,
  SkillRootKind,
  SkillReviewAction,
  SkillReviewFileChange,
  SkillReviewPreview,
  SkillReviewSummary,
  SkillSaveResult,
  SkillScope,
  SkillSourceType,
  UpdateSkillRequest,
  SkillUpsertRequest,
  SkillValidationIssue,
  SkillWatcherEvent,
} from './skill';

export type {
  ApiKeyEntry,
  ApiKeyLookupResult,
  ApiKeySaveRequest,
  ApiKeyStorageStatus,
} from './apikey';

export type { ApiKeysAPI, McpCatalogAPI, PluginCatalogAPI, SkillsCatalogAPI } from './api';

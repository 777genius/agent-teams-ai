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
  McpServerDiagnostic,
  McpSearchResult,
} from './mcp';
import type {
  SkillCatalogItem,
  SkillDeleteRequest,
  SkillDetail,
  SkillImportRequest,
  SkillReviewPreview,
  SkillUpsertRequest,
  SkillWatcherEvent,
} from './skill';

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
  diagnose: () => Promise<McpServerDiagnostic[]>;
  install: (request: McpInstallRequest) => Promise<OperationResult>;
  installCustom: (request: McpCustomInstallRequest) => Promise<OperationResult>;
  uninstall: (name: string, scope?: string, projectPath?: string) => Promise<OperationResult>;
  githubStars: (repositoryUrls: string[]) => Promise<Record<string, number>>;
}

// ── Skills API ─────────────────────────────────────────────────────────────

export interface SkillsCatalogAPI {
  list: (projectPath?: string) => Promise<SkillCatalogItem[]>;
  getDetail: (skillId: string, projectPath?: string) => Promise<SkillDetail | null>;
  previewUpsert: (request: SkillUpsertRequest) => Promise<SkillReviewPreview>;
  applyUpsert: (request: SkillUpsertRequest) => Promise<SkillDetail | null>;
  previewImport: (request: SkillImportRequest) => Promise<SkillReviewPreview>;
  applyImport: (request: SkillImportRequest) => Promise<SkillDetail | null>;
  deleteSkill: (request: SkillDeleteRequest) => Promise<void>;
  startWatching: (projectPath?: string) => Promise<string>;
  stopWatching: (watchId: string) => Promise<void>;
  onChanged: (callback: (event: SkillWatcherEvent) => void) => () => void;
}

// ── API Keys API ──────────────────────────────────────────────────────────

export interface ApiKeysAPI {
  list: () => Promise<ApiKeyEntry[]>;
  save: (request: ApiKeySaveRequest) => Promise<ApiKeyEntry>;
  delete: (id: string) => Promise<void>;
  lookup: (envVarNames: string[]) => Promise<ApiKeyLookupResult[]>;
  getStorageStatus: () => Promise<ApiKeyStorageStatus>;
}

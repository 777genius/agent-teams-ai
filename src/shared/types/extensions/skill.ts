/**
 * Skill domain types — local filesystem-backed skill catalog metadata and details.
 */

export type SkillScope = 'user' | 'project';

export type SkillRootKind = 'claude' | 'cursor' | 'agents';

export type SkillSourceType = 'filesystem';

export type SkillInvocationMode = 'auto' | 'manual-only';

export type SkillIssueSeverity = 'warning' | 'error';

export interface SkillDirectoryFlags {
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
}

export interface SkillValidationIssue {
  code:
    | 'missing-frontmatter'
    | 'invalid-frontmatter'
    | 'missing-name'
    | 'missing-description'
    | 'folder-name-mismatch'
    | 'nonstandard-file-name'
    | 'unknown-frontmatter-keys'
    | 'large-skill-file'
    | 'has-scripts'
    | 'allowed-tools-advisory'
    | 'compatibility-advisory'
    | 'duplicate-name';
  message: string;
  severity: SkillIssueSeverity;
}

export interface SkillCatalogItem {
  id: string;
  sourceType: SkillSourceType;
  name: string;
  description: string;
  folderName: string;
  scope: SkillScope;
  rootKind: SkillRootKind;
  projectRoot: string | null;
  discoveryRoot: string;
  skillDir: string;
  skillFile: string;
  license?: string;
  compatibility?: string;
  metadata: Record<string, string>;
  allowedTools?: string;
  invocationMode: SkillInvocationMode;
  flags: SkillDirectoryFlags;
  isValid: boolean;
  issues: SkillValidationIssue[];
  modifiedAt: number;
}

export interface SkillDetail {
  item: SkillCatalogItem;
  body: string;
  rawContent: string;
  rawFrontmatter: string | null;
  referencesFiles: string[];
  scriptFiles: string[];
  assetFiles: string[];
}

export interface SkillDraftFile {
  relativePath: string;
  content: string;
}

export interface SkillDraft {
  rawContent: string;
  files: SkillDraftFile[];
}

export interface SkillDraftTemplateInput {
  name: string;
  description: string;
  invocationMode: SkillInvocationMode;
  license: string;
  compatibility: string;
  whenToUse: string;
  steps: string;
  notes: string;
}

export type SkillReviewAction = 'create' | 'update' | 'delete';

export interface SkillReviewFileChange {
  relativePath: string;
  absolutePath: string;
  action: SkillReviewAction;
  oldContent: string | null;
  newContent: string | null;
  isBinary: boolean;
}

export interface SkillReviewSummary {
  created: number;
  updated: number;
  deleted: number;
  binary: number;
}

export interface SkillReviewPreview {
  planId: string;
  targetSkillDir: string;
  changes: SkillReviewFileChange[];
  warnings: string[];
  summary: SkillReviewSummary;
}

export interface SkillUpsertRequest {
  scope: SkillScope;
  rootKind: SkillRootKind;
  projectPath?: string;
  folderName: string;
  existingSkillId?: string;
  files: SkillDraftFile[];
  reviewPlanId?: string;
}

export interface SkillImportRequest {
  sourceDir: string;
  scope: SkillScope;
  rootKind: SkillRootKind;
  projectPath?: string;
  folderName?: string;
  reviewPlanId?: string;
}

export interface SkillDeleteRequest {
  skillId: string;
  projectPath?: string;
}

export type CreateSkillRequest = SkillUpsertRequest;
export type UpdateSkillRequest = SkillUpsertRequest;
export type ImportSkillRequest = SkillImportRequest;
export type DeleteSkillRequest = SkillDeleteRequest;

export interface SkillSaveResult {
  skillId: string;
  detail: SkillDetail | null;
}

export interface SkillWatcherEvent {
  scope: SkillScope;
  projectPath: string | null;
  path: string;
  type: 'create' | 'change' | 'delete';
}

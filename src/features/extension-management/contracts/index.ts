import type { SkillReviewPreview, SkillRootKind } from '../../../shared/types/extensions';
import type { createClient } from '@uap/management-sdk';

export type ExtensionClient = 'claude' | 'codex' | 'opencode';
export type ExtensionScope = 'user' | 'project';
export interface ExtensionSelection {
  client: ExtensionClient;
  scope: ExtensionScope;
  projectId?: string;
  /** Lookup key for an existing host-known project; native target scope stays user. */
  authoringProject?: string;
  /** Resolve an existing restore point against host-known authoring roots. */
  authoringRootId?: string;
}
export type ManagementClient = ReturnType<typeof createClient>;
export type ManagementSession = Awaited<ReturnType<ManagementClient['session']>>;
export type ManagementCatalog = Awaited<ReturnType<ManagementClient['catalog']>>;
export type ManagementEntry = Awaited<ReturnType<ManagementClient['catalogEntry']>>;
export type ManagementEnvironment = Awaited<ReturnType<ManagementClient['environment']>> & {
  /** App-owned retry handles survive a renderer remount, without minting a new request ID. */
  uncertainApplications?: { plan: ManagementPlan; requestId: string; contextId: string }[];
};
export type ManagementPlan = Awaited<ReturnType<ManagementClient['prepare']>>;
export type ManagementOperation = Awaited<ReturnType<ManagementClient['operation']>>;
export type ManagementChange = Parameters<ManagementClient['prepare']>[0];
export type SkillSource = Parameters<ManagementClient['discoverSkills']>[0];
export type SkillCandidates = Awaited<ReturnType<ManagementClient['discoverSkills']>>;
export type SkillPreview = Awaited<ReturnType<ManagementClient['skills']['preview']>>;
export type LocalSkillChange = Parameters<ManagementClient['skills']['local']['prepare']>[0];
export interface LocalSkillStatus {
  ownership: 'managed' | 'local';
  rootId: string;
  skillName: string;
  alias?: string;
}
export interface SkillCopyCandidate {
  id: string;
  sourceDir: string;
  skillName: string;
}
export interface SkillCopyDestination {
  candidateId: string;
  rootKind: SkillRootKind;
  folderName: string;
}
export type SkillCopyReview = SkillReviewPreview;
export interface ExtensionContext {
  contextId: string;
  selection: ExtensionSelection;
  label: string;
  session: ManagementSession;
}
export interface ExtensionContextRequest {
  contextId: string;
}
export interface ExtensionManagementAPI {
  hostStatus(): Promise<{ available: boolean; reason?: string }>;
  capture(selection: ExtensionSelection): Promise<ExtensionContext>;
  catalog(request: ExtensionContextRequest & { query?: string }): Promise<ManagementCatalog>;
  detail(request: ExtensionContextRequest & { id: string }): Promise<ManagementEntry>;
  discoverSkills(
    request: ExtensionContextRequest & { source: SkillSource }
  ): Promise<SkillCandidates>;
  previewSkill(
    request: ExtensionContextRequest & { catalogId: string; candidateId: string }
  ): Promise<SkillPreview>;
  discardSkillCatalog(request: ExtensionContextRequest & { catalogId: string }): Promise<void>;
  environment(request: ExtensionContextRequest): Promise<ManagementEnvironment>;
  localSkillStatus(
    request: ExtensionContextRequest & { skillPath: string }
  ): Promise<LocalSkillStatus>;
  prepareLocalSkill(
    request: ExtensionContextRequest & { change: LocalSkillChange }
  ): Promise<ManagementPlan>;
  skillCopySources(
    request: ExtensionContextRequest & { alias: string; targetId: string }
  ): Promise<SkillCopyCandidate[]>;
  previewSkillCopy(
    request: ExtensionContextRequest & SkillCopyDestination & { alias: string; targetId: string }
  ): Promise<SkillCopyReview>;
  prepare(
    request: ExtensionContextRequest & { change: ManagementChange; catalogEntryId?: string }
  ): Promise<ManagementPlan>;
  discardPlan(request: ExtensionContextRequest & { planId: string }): Promise<void>;
  apply(
    request: ExtensionContextRequest & { planId: string; requestId: string }
  ): Promise<ManagementOperation>;
  operation(
    request: ExtensionContextRequest & { operationId: string }
  ): Promise<ManagementOperation>;
  cancel(request: ExtensionContextRequest & { operationId: string }): Promise<ManagementOperation>;
}
export const EXTENSION_MANAGEMENT_ROUTE = '/api/extension-management';
export const EXTENSION_MANAGEMENT_METHODS = [
  'hostStatus',
  'capture',
  'catalog',
  'detail',
  'discoverSkills',
  'previewSkill',
  'discardSkillCatalog',
  'environment',
  'localSkillStatus',
  'prepareLocalSkill',
  'skillCopySources',
  'previewSkillCopy',
  'prepare',
  'discardPlan',
  'apply',
  'operation',
  'cancel',
] as const satisfies readonly (keyof ExtensionManagementAPI)[];
export const extensionManagementChannel = (method: keyof ExtensionManagementAPI): string =>
  `extension-management:${method}`;

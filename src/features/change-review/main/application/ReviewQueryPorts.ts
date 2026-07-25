import type { ReviewPathAuthorization } from './ReviewScopeAuthorizationPorts';
import type {
  AgentChangeSet,
  ChangeStats,
  FileChangeWithContent,
  ReviewFileScope,
  SnippetDiff,
  TaskChangeRequestOptions,
  TaskChangeSetV2,
  TeamTaskChangeSummariesResponse,
  TeamTaskChangeSummaryRequest,
} from '@shared/types/review';

export interface ReviewQueryChangesPort {
  getAgentChanges(teamName: string, memberName: string): Promise<AgentChangeSet>;
  getTaskChanges(
    teamName: string,
    taskId: string,
    options?: TaskChangeRequestOptions
  ): Promise<TaskChangeSetV2>;
  getTeamTaskChangeSummaries(
    teamName: string,
    requests: TeamTaskChangeSummaryRequest[]
  ): Promise<TeamTaskChangeSummariesResponse>;
  invalidateTaskChangeSummaries(teamName: string, taskIds: string[]): Promise<void>;
  getChangeStats(teamName: string, memberName: string): Promise<ChangeStats>;
}

export interface ReviewQueryScopePort {
  normalizeIdentity(value: string | undefined): string | undefined;
  resolve(
    value: unknown
  ): Promise<{ scope: ReviewFileScope; authorization: ReviewPathAuthorization }>;
  validateFilePath(
    authorization: ReviewPathAuthorization,
    filePath: unknown,
    options: { requireReviewedFile: boolean }
  ): Promise<string>;
  validateSnippets(authorization: ReviewPathAuthorization, snippets: SnippetDiff[]): Promise<void>;
}

export interface ReviewQueryContentPort {
  getFileContent(
    teamName: string,
    memberName: string,
    filePath: string,
    snippets: SnippetDiff[]
  ): Promise<FileChangeWithContent>;
}

export interface ReviewQuerySnapshotPort {
  register(
    teamName: string,
    filePath: string,
    snippets: SnippetDiff[],
    content: FileChangeWithContent
  ): FileChangeWithContent;
}

export interface ReviewQueryGitLogEntry {
  hash: string;
  timestamp: string;
  message: string;
}

export interface ReviewQueryGitHistoryPort {
  getFileLog(projectPath: string, filePath: string): Promise<ReviewQueryGitLogEntry[]>;
}

export interface ReviewQueryDependencies {
  changes: ReviewQueryChangesPort;
  scope: ReviewQueryScopePort;
  content: ReviewQueryContentPort;
  snapshots: ReviewQuerySnapshotPort;
  gitHistory: ReviewQueryGitHistoryPort;
}

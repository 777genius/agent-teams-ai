import { assertOptionalString, assertSnippetShapes } from '../../core/domain/reviewScopePolicy';

import type { ReviewQueryDependencies, ReviewQueryGitLogEntry } from './ReviewQueryPorts';
import type {
  AgentChangeSet,
  ChangeStats,
  FileChangeWithContent,
  TaskChangeRequestOptions,
  TaskChangeSetV2,
  TeamTaskChangeSummariesResponse,
  TeamTaskChangeSummaryRequest,
} from '@shared/types/review';

export class ReviewQueryApplication {
  constructor(private readonly dependencies: ReviewQueryDependencies) {}

  getAgentChanges(teamName: string, memberName: string): Promise<AgentChangeSet> {
    return this.dependencies.changes.getAgentChanges(teamName, memberName);
  }

  getTaskChanges(
    teamName: string,
    taskId: string,
    options?: TaskChangeRequestOptions
  ): Promise<TaskChangeSetV2> {
    return this.dependencies.changes.getTaskChanges(teamName, taskId, options);
  }

  getTeamTaskChangeSummaries(
    teamName: string,
    requests: TeamTaskChangeSummaryRequest[]
  ): Promise<TeamTaskChangeSummariesResponse> {
    return this.dependencies.changes.getTeamTaskChangeSummaries(teamName, requests);
  }

  invalidateTaskChangeSummaries(teamName: string, taskIds: string[]): Promise<void> {
    return this.dependencies.changes.invalidateTaskChangeSummaries(
      teamName,
      Array.isArray(taskIds) ? taskIds.filter((taskId) => typeof taskId === 'string') : []
    );
  }

  getChangeStats(teamName: string, memberName: string): Promise<ChangeStats> {
    return this.dependencies.changes.getChangeStats(teamName, memberName);
  }

  async getFileContent(
    teamNameValue: unknown,
    memberNameValue: unknown,
    filePathValue: unknown,
    snippetsValue: unknown = []
  ): Promise<FileChangeWithContent> {
    assertOptionalString(memberNameValue, 'memberName');
    assertSnippetShapes(snippetsValue);
    const { scope, authorization } = await this.dependencies.scope.resolve({
      teamName: teamNameValue,
      memberName: this.dependencies.scope.normalizeIdentity(memberNameValue),
    });
    const filePath = await this.dependencies.scope.validateFilePath(authorization, filePathValue, {
      requireReviewedFile: false,
    });
    await this.dependencies.scope.validateSnippets(authorization, snippetsValue);
    const content = await this.dependencies.content.getFileContent(
      scope.teamName,
      scope.memberName ?? '',
      filePath,
      snippetsValue
    );
    return this.dependencies.snapshots.register(scope.teamName, filePath, snippetsValue, content);
  }

  getGitFileLog(projectPath: string, filePath: string): Promise<ReviewQueryGitLogEntry[]> {
    return this.dependencies.gitHistory.getFileLog(projectPath, filePath);
  }
}

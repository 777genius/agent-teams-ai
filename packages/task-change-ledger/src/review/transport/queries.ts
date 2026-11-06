import type { ReviewOriginScope, ReviewRecoveryRead } from './contracts.js';
import type {
  AgentChangeSet,
  ChangeStats,
  TaskChangeRequestOptions,
  TaskChangeSetV2,
  TeamTaskChangeSummariesResponse,
  TeamTaskChangeSummaryRequest,
} from '../../contracts.js';
import {
  assertBoundedReviewValue,
  InvalidReviewTransport,
  parseReviewOriginScope,
} from './validateReviewWriter.js';

export interface ReviewQueryInputMap {
  'recovery.read': { scope: ReviewOriginScope };
  getTaskChanges: { taskId: string; options?: TaskChangeRequestOptions };
  getTaskSummaries: { requests: TeamTaskChangeSummaryRequest[] };
  getAgentChanges: { memberName: string };
  getChangeStats: { memberName: string };
  invalidateSummaries: { taskIds: string[] };
  authorizeWatch: { projectPath: string; filePaths: string[]; scope?: ReviewOriginScope };
  getGitFileLog: { projectPath: string; filePath: string; scope?: ReviewOriginScope };
}
export type ReviewQueryMethod = keyof ReviewQueryInputMap;
export interface ReviewWatchAuthorization {
  kind: 'review-watch-authorization';
  projectPath: string;
  filePaths: string[];
  /** Host-selected partitions and immutable request evidence identity; not caller authority. */
  roots?: { projectPath: string; filePaths: string[] }[];
  authorizationIdentity?: string;
}
export type ReviewQueryValue =
  | ReviewRecoveryRead
  | { kind: 'review-task-changes'; value: TaskChangeSetV2 }
  | { kind: 'review-task-summaries'; value: TeamTaskChangeSummariesResponse }
  | { kind: 'review-agent-changes'; value: AgentChangeSet }
  | { kind: 'review-change-stats'; value: ChangeStats }
  | { kind: 'review-invalidated' }
  | ReviewWatchAuthorization
  | {
      kind: 'review-git-log';
      value: { hash: string; timestamp: string; message: string }[];
    };

const methods = [
  'recovery.read',
  'getTaskChanges',
  'getTaskSummaries',
  'getAgentChanges',
  'getChangeStats',
  'invalidateSummaries',
  'authorizeWatch',
  'getGitFileLog',
] as const satisfies readonly ReviewQueryMethod[];
export function isReviewQueryMethod(method: string): method is ReviewQueryMethod {
  return (methods as readonly string[]).includes(method);
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new InvalidReviewTransport();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new InvalidReviewTransport();
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new InvalidReviewTransport();
  return value;
}
function options(value: unknown): TaskChangeRequestOptions {
  const row = object(value, [
    'owner',
    'status',
    'intervals',
    'since',
    'stateBucket',
    'summaryOnly',
    'forceFresh',
    'retryBackfill',
  ]);
  const result: TaskChangeRequestOptions = {};
  for (const key of ['owner', 'status', 'since'] as const)
    if (row[key] !== undefined) result[key] = text(row[key]);
  if (row.intervals !== undefined)
    result.intervals = list(row.intervals, 10_000).map((value) => {
      const entry = object(value, ['startedAt', 'completedAt']);
      return {
        startedAt: text(entry.startedAt),
        ...(entry.completedAt === undefined ? {} : { completedAt: text(entry.completedAt) }),
      };
    });
  for (const key of ['summaryOnly', 'forceFresh', 'retryBackfill'] as const)
    if (row[key] !== undefined) {
      if (typeof row[key] !== 'boolean') throw new InvalidReviewTransport();
      result[key] = row[key];
    }
  if (row.stateBucket !== undefined) {
    if (!['approved', 'review', 'completed', 'active'].includes(text(row.stateBucket)))
      throw new InvalidReviewTransport();
    result.stateBucket = row.stateBucket as TaskChangeRequestOptions['stateBucket'];
  }
  return result;
}
export function parseReviewQuery<M extends ReviewQueryMethod>(
  method: M,
  value: unknown
): ReviewQueryInputMap[M];
export function parseReviewQuery(
  method: ReviewQueryMethod,
  value: unknown
): ReviewQueryInputMap[ReviewQueryMethod] {
  assertBoundedReviewValue(value);
  switch (method) {
    case 'recovery.read': {
      const row = object(value, ['scope']);
      const scope = parseReviewOriginScope(row.scope);
      if (!scope.taskId && !scope.memberName) throw new InvalidReviewTransport();
      return { scope };
    }
    case 'getTaskChanges': {
      const row = object(value, ['taskId', 'options']);
      return {
        taskId: text(row.taskId),
        ...(row.options === undefined ? {} : { options: options(row.options) }),
      };
    }
    case 'getTaskSummaries': {
      const row = object(value, ['requests']);
      const requests: TeamTaskChangeSummaryRequest[] = list(row.requests, 201).map((value) => {
        const item = object(value, ['taskId', 'options']);
        return {
          taskId: text(item.taskId),
          ...(item.options === undefined ? {} : { options: options(item.options) }),
        };
      });
      return { requests };
    }
    case 'getAgentChanges':
    case 'getChangeStats': {
      const row = object(value, ['memberName']);
      return { memberName: text(row.memberName) };
    }
    case 'invalidateSummaries': {
      const row = object(value, ['taskIds']);
      return { taskIds: list(row.taskIds, 1000).map((value) => text(value)) };
    }
    case 'authorizeWatch': {
      const row = object(value, ['projectPath', 'filePaths', 'scope']);
      return {
        projectPath: text(row.projectPath, 8192),
        ...(row.scope === undefined ? {} : { scope: parseReviewOriginScope(row.scope) }),
        filePaths: list(row.filePaths, 2000).map((value) => text(value, 8192)),
      };
    }
    case 'getGitFileLog': {
      const row = object(value, ['projectPath', 'filePath', 'scope']);
      return {
        projectPath: text(row.projectPath, 8192),
        ...(row.scope === undefined ? {} : { scope: parseReviewOriginScope(row.scope) }),
        filePath: text(row.filePath, 8192),
      };
    }
  }
}

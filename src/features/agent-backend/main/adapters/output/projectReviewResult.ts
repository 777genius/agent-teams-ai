import {
  assertBoundedReviewValue,
  isReviewWriterMethod,
  parseReviewOriginScope,
} from '@agent-teams/task-change-ledger/review-transport';

import { projectReviewRecovery, projectReviewReferences } from './projectReviewRecovery';

import type {
  BackendReviewOperation,
  BackendReviewOperationPayloads,
  BackendReviewValue,
} from '../../../contracts/review';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Host review response');
  return value as Record<string, unknown>;
}
/** Correlate the finite response with the requested method; rich DTOs remain the original writer's DTOs. */
export function projectReviewResult(
  operation: BackendReviewOperation,
  payload: BackendReviewOperationPayloads[BackendReviewOperation],
  value: unknown,
  commandId: string
): BackendReviewValue | null {
  assertBoundedReviewValue(value);
  if (operation === 'review.lookup' && value === null) return null;
  const result = object(value);
  switch (operation) {
    case 'review.recovery.read': {
      if (!('scope' in payload) || !payload.scope) throw new Error('Invalid Host review recovery');
      return projectReviewRecovery(result, payload.scope);
    }
    case 'review.lookup': {
      if (
        result.kind !== 'review-command' ||
        result.commandId !== commandId ||
        !isReviewWriterMethod(result.method) ||
        !['prepared', 'held', 'completed'].includes(String(result.phase)) ||
        result.outcome !== (result.phase === 'completed' ? 'completed' : 'unknown') ||
        typeof result.responseAvailable !== 'boolean' ||
        !('scope' in payload) ||
        !payload.scope
      )
        throw new Error('Invalid Host review lookup');
      const origin = parseReviewOriginScope(result.origin);
      if (
        origin.taskId !== payload.scope.taskId ||
        origin.memberName !== payload.scope.memberName ||
        ('expected' in payload && payload.expected && result.method !== payload.expected.method)
      )
        throw new Error('Invalid Host review lookup');
      if (result.responseAvailable) {
        const response = object(result.response);
        if (
          result.phase !== 'completed' ||
          response.kind !== 'review-writer' ||
          response.method !== result.method ||
          !Object.hasOwn(response, 'result')
        )
          throw new Error('Invalid Host review lookup');
      } else if (result.response !== undefined) throw new Error('Invalid Host review lookup');
      const references = projectReviewReferences(result.references);
      return {
        kind: 'review-command',
        commandId,
        method: result.method,
        origin,
        phase: result.phase as 'prepared' | 'held' | 'completed',
        outcome: result.outcome as 'completed' | 'unknown',
        responseAvailable: result.responseAvailable,
        ...(result.responseAvailable
          ? { response: result.response as Extract<BackendReviewValue, { kind: 'review-writer' }> }
          : {}),
        ...(references === undefined ? {} : { references }),
      };
    }
    case 'review.invoke':
      if (
        result.kind !== 'review-writer' ||
        !('request' in payload) ||
        result.method !== payload.request.method ||
        !Object.hasOwn(result, 'result')
      )
        throw new Error('Invalid Host review response');
      break;
    case 'review.getTaskChanges': {
      const changes = object(result.value);
      if (
        result.kind !== 'review-task-changes' ||
        !('taskId' in payload) ||
        changes.taskId !== payload.taskId ||
        typeof changes.teamName !== 'string' ||
        !Array.isArray(changes.files)
      )
        throw new Error('Invalid Host review response');
      break;
    }
    case 'review.getTaskSummaries': {
      const summary = object(result.value);
      if (
        result.kind !== 'review-task-summaries' ||
        typeof summary.teamName !== 'string' ||
        !Array.isArray(summary.items) ||
        summary.items.length > 201
      )
        throw new Error('Invalid Host review response');
      break;
    }
    case 'review.getAgentChanges':
      if (result.kind !== 'review-agent-changes' || !Array.isArray(object(result.value).files))
        throw new Error('Invalid Host review response');
      break;
    case 'review.getChangeStats':
      if (
        result.kind !== 'review-change-stats' ||
        !result.value ||
        typeof result.value !== 'object' ||
        ['linesAdded', 'linesRemoved', 'filesChanged'].some((key) => {
          const value = object(result.value)[key];
          return typeof value !== 'number' || !Number.isFinite(value) || value < 0;
        }) ||
        (object(result.value).completeness !== undefined &&
          !['complete', 'partial', 'unavailable'].includes(
            String(object(result.value).completeness)
          )) ||
        (object(result.value).warnings !== undefined &&
          (!Array.isArray(object(result.value).warnings) ||
            (object(result.value).warnings as unknown[]).length > 128 ||
            (object(result.value).warnings as unknown[]).some(
              (value) => typeof value !== 'string' || value.length > 8192
            )))
      )
        throw new Error('Invalid Host review response');
      break;
    case 'review.invalidateSummaries':
      if (result.kind !== 'review-invalidated') throw new Error('Invalid Host review response');
      break;
    case 'review.getGitFileLog':
      if (
        result.kind !== 'review-git-log' ||
        !Array.isArray(result.value) ||
        result.value.some((value) => {
          const entry = object(value);
          return ['hash', 'timestamp', 'message'].some((key) => typeof entry[key] !== 'string');
        })
      )
        throw new Error('Invalid Host review response');
      break;
    case 'review.authorizeWatch':
      if (
        result.kind !== 'review-watch-authorization' ||
        typeof result.projectPath !== 'string' ||
        !Array.isArray(result.filePaths) ||
        result.filePaths.length > 2000 ||
        result.filePaths.some((path) => typeof path !== 'string') ||
        (result.authorizationIdentity !== undefined &&
          (typeof result.authorizationIdentity !== 'string' ||
            !/^[a-f0-9]{64}$/.test(result.authorizationIdentity))) ||
        (result.roots !== undefined &&
          (!Array.isArray(result.roots) ||
            result.roots.length > 64 ||
            result.roots.some((value) => {
              const root = object(value);
              return (
                typeof root.projectPath !== 'string' ||
                !Array.isArray(root.filePaths) ||
                root.filePaths.length > 2000 ||
                root.filePaths.some((path) => typeof path !== 'string')
              );
            })))
      )
        throw new Error('Invalid Host review response');
      break;
  }
  if (result.kind === 'review-writer')
    return {
      kind: result.kind,
      method: result.method,
      result: result.result,
    } as BackendReviewValue;
  if (result.kind === 'review-watch-authorization')
    return {
      kind: result.kind,
      projectPath: result.projectPath,
      filePaths: result.filePaths,
      ...(result.roots === undefined
        ? {}
        : {
            roots: (result.roots as { projectPath: string; filePaths: string[] }[]).map((root) => ({
              projectPath: root.projectPath,
              filePaths: [...root.filePaths],
            })),
          }),
      ...(result.authorizationIdentity === undefined
        ? {}
        : { authorizationIdentity: result.authorizationIdentity }),
    } as BackendReviewValue;
  if (result.kind === 'review-invalidated') return { kind: result.kind };
  return { kind: result.kind, value: result.value } as BackendReviewValue;
}

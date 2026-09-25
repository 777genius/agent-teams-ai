import {
  buildReviewDecisionScopeToken,
  reviewChangeSetMatchesScope,
} from '@renderer/utils/reviewDecisionScope';
import { buildTaskChangeSignature } from '@renderer/utils/taskChangeRequest';

import type { ReviewChangeSetLike } from '@renderer/utils/reviewDecisionScope';
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type { ReviewFileScope } from '@shared/types';

export type ReviewDecisionHydrationStatus = 'idle' | 'loading' | 'loaded' | 'error';
export type ReviewDecisionHydrationGuard = 'not-required' | 'pending' | 'ready' | 'error';

export interface ReviewDraftHistoryHydrationState {
  key: string | null;
  status: ReviewDecisionHydrationStatus;
}

export interface ChangeReviewScopeProjection {
  scopeKey: string;
  decisionScopeKey: string;
  decisionScopeToken: string | null;
  decisionHydrationKey: string | null;
  decisionHydrationReady: boolean;
  decisionHydrationFailed: boolean;
  decisionHydrationPending: boolean;
  draftHistoryHydrationReady: boolean;
  draftHistoryHydrationPending: boolean;
  draftHistoryHydrationFailed: boolean;
  reviewScope: ReviewFileScope;
  collapseStorageKey: string;
}

export interface BuildChangeReviewScopeProjectionInput {
  teamName: string;
  mode: 'agent' | 'task';
  memberName?: string;
  taskId?: string;
  taskChangeRequestOptions?: TaskChangeRequestOptions;
  activeChangeSet: ReviewChangeSetLike | null | undefined;
  decisionHydrationScopeKey: string | null;
  decisionHydrationStatus: ReviewDecisionHydrationStatus;
  draftHistoryHydration: ReviewDraftHistoryHydrationState;
}

export function getReviewDecisionHydrationGuard(input: {
  expectedScopeKey: string | null;
  hydratedScopeKey: string | null;
  status: ReviewDecisionHydrationStatus;
}): ReviewDecisionHydrationGuard {
  if (input.expectedScopeKey === null) return 'not-required';
  if (input.hydratedScopeKey !== input.expectedScopeKey) return 'pending';
  if (input.status === 'loaded') return 'ready';
  if (input.status === 'error') return 'error';
  return 'pending';
}

export function buildChangeReviewScopeProjection(
  input: BuildChangeReviewScopeProjectionInput
): ChangeReviewScopeProjection {
  const scopeTarget = input.mode === 'task' ? (input.taskId ?? '') : (input.memberName ?? '');
  const scopeKey = `${input.mode}:${scopeTarget}`;
  const decisionScopeKey = `${input.mode}-${scopeTarget}`;
  const changeSetMatchesScope = reviewChangeSetMatchesScope(input.activeChangeSet, {
    teamName: input.teamName,
    taskId: input.mode === 'task' ? input.taskId : undefined,
    memberName: input.mode === 'agent' ? input.memberName : undefined,
  });
  const decisionScopeToken = changeSetMatchesScope
    ? buildReviewDecisionScopeToken({
        mode: input.mode,
        taskId: input.taskId,
        memberName: input.memberName,
        requestSignature:
          input.mode === 'task'
            ? buildTaskChangeSignature(input.taskChangeRequestOptions ?? {})
            : undefined,
        changeSet: input.activeChangeSet,
      })
    : null;
  const decisionHydrationKey = decisionScopeToken
    ? `${input.teamName}:${decisionScopeKey}:${decisionScopeToken}`
    : null;
  const decisionHydrationGuard = getReviewDecisionHydrationGuard({
    expectedScopeKey: decisionHydrationKey,
    hydratedScopeKey: input.decisionHydrationScopeKey,
    status: input.decisionHydrationStatus,
  });
  const draftHistoryHydrationReady =
    decisionHydrationKey === null ||
    (input.draftHistoryHydration.key === decisionHydrationKey &&
      input.draftHistoryHydration.status === 'loaded');
  const draftHistoryHydrationPending =
    decisionHydrationKey !== null &&
    (input.draftHistoryHydration.key !== decisionHydrationKey ||
      input.draftHistoryHydration.status === 'idle' ||
      input.draftHistoryHydration.status === 'loading');
  const draftHistoryHydrationFailed =
    decisionHydrationKey !== null &&
    input.draftHistoryHydration.key === decisionHydrationKey &&
    input.draftHistoryHydration.status === 'error';

  return {
    scopeKey,
    decisionScopeKey,
    decisionScopeToken,
    decisionHydrationKey,
    decisionHydrationReady: decisionHydrationGuard === 'ready',
    decisionHydrationFailed: decisionHydrationGuard === 'error',
    decisionHydrationPending: decisionHydrationGuard === 'pending',
    draftHistoryHydrationReady,
    draftHistoryHydrationPending,
    draftHistoryHydrationFailed,
    reviewScope: {
      teamName: input.teamName,
      taskId: input.taskId,
      memberName: input.memberName,
    },
    collapseStorageKey: `review:collapsed:${input.teamName}:${decisionScopeKey}`,
  };
}

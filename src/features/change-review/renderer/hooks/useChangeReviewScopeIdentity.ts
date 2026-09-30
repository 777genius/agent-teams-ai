import { useMemo } from 'react';

import {
  buildChangeReviewScopeProjection,
  type BuildChangeReviewScopeProjectionInput,
  type ChangeReviewScopeProjection,
} from '../utils/changeReviewScope';

export function useChangeReviewScopeIdentity({
  activeChangeSet,
  decisionHydrationScopeKey,
  decisionHydrationStatus,
  draftHistoryHydration,
  memberName,
  mode,
  taskChangeRequestOptions,
  taskId,
  teamName,
}: BuildChangeReviewScopeProjectionInput): ChangeReviewScopeProjection {
  const reviewScope = useMemo(
    () => ({ teamName, taskId, memberName }),
    [memberName, taskId, teamName]
  );

  return useMemo(
    () => ({
      ...buildChangeReviewScopeProjection({
        activeChangeSet,
        decisionHydrationScopeKey,
        decisionHydrationStatus,
        draftHistoryHydration,
        memberName,
        mode,
        taskChangeRequestOptions,
        taskId,
        teamName,
      }),
      reviewScope,
    }),
    [
      activeChangeSet,
      decisionHydrationScopeKey,
      decisionHydrationStatus,
      draftHistoryHydration,
      memberName,
      mode,
      reviewScope,
      taskChangeRequestOptions,
      taskId,
      teamName,
    ]
  );
}

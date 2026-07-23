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
  return useMemo(
    () =>
      buildChangeReviewScopeProjection({
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
    [
      activeChangeSet,
      decisionHydrationScopeKey,
      decisionHydrationStatus,
      draftHistoryHydration,
      memberName,
      mode,
      taskChangeRequestOptions,
      taskId,
      teamName,
    ]
  );
}

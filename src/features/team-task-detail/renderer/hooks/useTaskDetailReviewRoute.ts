import { useEffect } from 'react';

import { useStore } from '@renderer/store';
import { isTaskDetailReviewTargetCurrent } from '@renderer/store/team/taskDetailReviewRoute';

import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';

export function useTaskDetailReviewRoute({
  teamName,
  tabId,
  active,
  ready,
  openReview,
}: {
  teamName: string;
  tabId: string | null;
  active: boolean;
  ready: boolean;
  openReview: (
    input: {
      mode: 'task';
      taskId: string;
      initialFilePath?: string;
      taskChangeRequestOptions: TaskChangeRequestOptions;
    },
    isCurrent: () => boolean
  ) => Promise<boolean>;
}): void {
  const request = useStore((state) => state.pendingReviewRequest);
  useEffect(() => {
    const state = useStore.getState();
    if (
      !active ||
      !ready ||
      !request ||
      state.pendingReviewRequest?.status !== 'pending' ||
      !isTaskDetailReviewTargetCurrent(state, request, teamName, tabId)
    )
      return;
    const opening = { ...request, status: 'opening' as const };
    state.setPendingReviewRequest(opening);
    const isCurrent = () => {
      const current = useStore.getState();
      return (
        current.pendingReviewRequest?.status === 'opening' &&
        isTaskDetailReviewTargetCurrent(current, opening, teamName, tabId)
      );
    };
    const finish = (accepted: boolean) => {
      if (isCurrent())
        useStore
          .getState()
          .setPendingReviewRequest(accepted ? null : { ...opening, status: 'blocked' });
    };
    void openReview(
      {
        mode: 'task',
        taskId: request.taskId,
        initialFilePath: request.filePath,
        taskChangeRequestOptions: request.requestOptions,
      },
      isCurrent
    ).then(finish, () => finish(false));
  }, [active, openReview, ready, request, tabId, teamName]);
}

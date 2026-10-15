import { useStore } from '@renderer/store';

import { taskDetailKey } from '../../core';
import { TaskDetailReviewRouteBanner } from '../ui/TaskDetailReviewRouteBanner';

import type { TaskDetailIdentity } from '../../contracts';

/** Keep activation failures actionable inside the originating modal/page. */
export const TaskDetailReviewActivationFeedback = ({
  identity,
  active,
  onAccepted,
}: {
  identity: TaskDetailIdentity;
  active: boolean;
  onAccepted?: () => void;
}): React.JSX.Element | null => {
  const failure = useStore((state) => state.taskDetailReviewActivationFailure);
  const contextId = useStore((state) => state.activeContextId);
  const switching = useStore((state) => state.isContextSwitching);
  if (
    !active ||
    switching ||
    identity.contextId !== contextId ||
    !failure ||
    taskDetailKey(failure.identity) !== taskDetailKey(identity)
  )
    return null;
  return (
    <TaskDetailReviewRouteBanner
      blocked
      retry={() => {
        if (useStore.getState().retryTaskDetailReviewActivationFailure(failure.nonce))
          onAccepted?.();
      }}
      close={() => {
        useStore.getState().closeTaskDetailReviewActivationFailure(failure.nonce);
      }}
    />
  );
};

import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';

import { taskDetailKey } from '../../core';
import { TaskDetailReviewRouteBanner } from '../ui/TaskDetailReviewRouteBanner';

import type { TaskDetailIdentity } from '../../contracts';

export const TaskDetailEditorActivationFeedback = ({
  identity,
  active,
  onAccepted,
}: {
  identity: TaskDetailIdentity;
  active: boolean;
  onAccepted?: () => void;
}): React.JSX.Element | null => {
  const failure = useStore((state) => state.taskDetailEditorActivationFailure);
  const contextId = useStore((state) => state.activeContextId);
  const switching = useStore((state) => state.isContextSwitching);
  const { t } = useAppTranslation('team');
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
      message={t('taskDetail.navigation.editorRefused')}
      retry={() => {
        if (useStore.getState().retryTaskDetailEditorActivationFailure(failure.nonce))
          onAccepted?.();
      }}
      close={() => useStore.getState().closeTaskDetailEditorActivationFailure(failure.nonce)}
    />
  );
};

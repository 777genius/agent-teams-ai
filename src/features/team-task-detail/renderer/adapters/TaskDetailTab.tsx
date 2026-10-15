import { TaskDetailPage } from './TaskDetailPage';

import type { TaskDetailIdentity } from '../../contracts';

export interface TaskDetailTabProps {
  identity: TaskDetailIdentity;
  isActive: boolean;
  isPaneFocused: boolean;
  tabId: string;
}

export const TaskDetailTab = ({
  identity,
  isActive,
  isPaneFocused,
  tabId,
}: TaskDetailTabProps): React.JSX.Element => {
  return (
    <TaskDetailPage
      identity={identity}
      isActive={isActive}
      isPaneFocused={isPaneFocused}
      surfaceId={tabId}
    />
  );
};

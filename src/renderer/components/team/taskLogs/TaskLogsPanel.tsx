import { ExecutionSessionsSection } from './ExecutionSessionsSection';
import { TaskActivitySection } from './TaskActivitySection';
import { TaskLogStreamSection } from './TaskLogStreamSection';
import { isBoardTaskActivityUiEnabled, isBoardTaskExactLogsUiEnabled } from './featureGates';

import type { TeamTaskWithKanban } from '@shared/types';

interface TaskLogsPanelProps {
  teamName: string;
  task: TeamTaskWithKanban;
  taskSince?: string;
  isExecutionRefreshing?: boolean;
  isExecutionPreviewOnline?: boolean;
  onRefreshingChange?: (isRefreshing: boolean) => void;
  showSubagentPreview?: boolean;
  showLeadPreview?: boolean;
  onPreviewOnlineChange?: (isOnline: boolean) => void;
}

export function TaskLogsPanel({
  teamName,
  task,
  taskSince,
  isExecutionRefreshing = false,
  isExecutionPreviewOnline = false,
  onRefreshingChange,
  showSubagentPreview = false,
  showLeadPreview = false,
  onPreviewOnlineChange,
}: TaskLogsPanelProps): React.JSX.Element {
  return (
    <div className="space-y-4">
      {isBoardTaskActivityUiEnabled() ? (
        <TaskActivitySection teamName={teamName} taskId={task.id} />
      ) : null}
      {isBoardTaskExactLogsUiEnabled() ? (
        <TaskLogStreamSection teamName={teamName} taskId={task.id} />
      ) : null}
      <ExecutionSessionsSection
        teamName={teamName}
        taskId={task.id}
        taskOwner={task.owner}
        taskStatus={task.status}
        taskWorkIntervals={task.workIntervals}
        taskSince={taskSince}
        isRefreshing={isExecutionRefreshing}
        isPreviewOnline={isExecutionPreviewOnline}
        onRefreshingChange={onRefreshingChange}
        showSubagentPreview={showSubagentPreview}
        showLeadPreview={showLeadPreview}
        onPreviewOnlineChange={onPreviewOnlineChange}
      />
    </div>
  );
}

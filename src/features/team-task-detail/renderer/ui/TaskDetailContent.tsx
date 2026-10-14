import { TaskGroupChatField } from '@renderer/components/team/dialogs/TaskGroupChatField';

import {
  type TaskDetailFileLinkIntent,
  TaskDetailFileLinkProvider,
} from '../context/TaskDetailFileLinkContext';

import { TaskDetailBody } from './TaskDetailBody';
import { TaskDetailHeader, type TaskDetailHeadingProps } from './TaskDetailHeader';

import type {
  TaskDetailPresentationActions,
  TaskDetailPresentationModel,
} from '../hooks/useTaskDetailPresentation';
import type { TaskDetailSessionController } from '../hooks/useTaskDetailSession';
import type { ReactNode } from 'react';

export interface TaskDetailContentProps {
  actions: TaskDetailPresentationActions;
  headerExtra?: ReactNode;
  model: TaskDetailPresentationModel;
  onDeleteTask?: (taskId: string) => void;
  onOpenInEditor?: (intent: TaskDetailFileLinkIntent) => void;
  onOpenInTaskTab?: () => void | Promise<void>;
  onOwnerChange?: (taskId: string, owner: string | null) => void;
  onViewChanges?: (taskId: string, filePath?: string) => void;
  renderDescription: (content: string) => ReactNode;
  renderHeading: (props: TaskDetailHeadingProps) => ReactNode;
  renderHeader?: (children: ReactNode) => ReactNode;
  sessionController: TaskDetailSessionController;
  showTeamIO?: boolean;
}

export const TaskDetailContent = ({
  actions,
  headerExtra,
  model,
  onDeleteTask,
  onOpenInEditor,
  onOpenInTaskTab,
  onOwnerChange,
  onViewChanges,
  renderDescription,
  renderHeading,
  renderHeader,
  sessionController,
  showTeamIO = true,
}: TaskDetailContentProps): React.JSX.Element => {
  const header = (
    <TaskDetailHeader
      actions={actions}
      headerExtra={headerExtra}
      model={model}
      onDeleteTask={onDeleteTask}
      onOpenInTaskTab={onOpenInTaskTab}
      onOwnerChange={onOwnerChange}
      renderDescription={renderDescription}
      renderHeading={renderHeading}
      sessionController={sessionController}
    />
  );
  return (
    <TaskDetailFileLinkProvider
      contextId={sessionController.identity.contextId}
      taskId={sessionController.identity.taskId}
      teamName={model.teamName}
      projectPath={model.projectPath ?? ''}
      onOpenFile={(intent) => onOpenInEditor?.(intent)}
    >
      <div
        className="flex min-w-0 flex-1 flex-col gap-3"
        data-task-detail-content
        data-task-detail-surface={model.focusCommentId ? 'focused' : 'shared'}
      >
        {renderHeader ? renderHeader(header) : header}
        <TaskGroupChatField
          key={model.currentTask.id}
          teamName={model.teamName}
          value={model.currentTask.groupChatId ?? null}
          disabled={!sessionController.isOwner}
          onChange={actions.updateGroupChat}
        />
        <TaskDetailBody
          actions={actions}
          model={model}
          onOpenInEditor={(filePath) =>
            onOpenInEditor?.({
              ...sessionController.identity,
              projectPath: model.projectPath ?? '',
              filePath,
              line: null,
            })
          }
          onViewChanges={onViewChanges}
          sessionController={sessionController}
          showTeamIO={showTeamIO}
        />
      </div>
    </TaskDetailFileLinkProvider>
  );
};

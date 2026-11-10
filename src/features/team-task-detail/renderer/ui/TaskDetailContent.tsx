import { useAppTranslation } from '@features/localization/renderer';

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
  const { t } = useAppTranslation('team');
  const projectPath = model.currentTask.projectPath ?? model.projectPath ?? '';
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
      projectPath={projectPath}
      onOpenFile={(intent) => onOpenInEditor?.(intent)}
    >
      <div
        className="flex min-w-0 flex-1 flex-col gap-3"
        data-task-detail-content
        data-task-detail-surface={model.focusCommentId ? 'focused' : 'shared'}
      >
        {model.currentTask.status === 'deleted' || model.currentTask.deletedAt ? (
          <p role="status" className="rounded-md border border-border px-3 py-2 text-sm">
            {t('taskDetail.page.deleted')}
          </p>
        ) : null}
        {renderHeader ? renderHeader(header) : header}
        <TaskDetailBody
          actions={actions}
          model={model}
          onOpenInEditor={(filePath) =>
            onOpenInEditor?.({
              ...sessionController.identity,
              projectPath,
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

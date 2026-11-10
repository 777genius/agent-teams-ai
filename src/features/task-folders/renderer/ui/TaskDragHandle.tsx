import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { GripVertical } from 'lucide-react';

import { childKey } from '../../core/domain/folders';
import { taskFolderMoveRequest, useTaskFolderEditingReady } from '../adapters/taskFolderEditing';
import { writeTaskDrag } from '../adapters/treeDropAdapter';
import { panelController } from '../composition';
import { useTaskFolderMode } from '../hooks/useTaskFolderMode';

import type { TaskIdentity } from '../../core/domain/folders';
export const TaskDragHandle = ({
  identity,
  subject,
  className,
  onFocus,
}: {
  identity: TaskIdentity;
  subject: string;
  className?: string;
  onFocus?: React.FocusEventHandler<HTMLButtonElement>;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('common');
  const editingReady = useTaskFolderEditingReady();
  const folderMode = useTaskFolderMode();
  if (!folderMode) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('taskFolders.dragTask')}
          data-testid="sidebar-task-drag-handle"
          disabled={!editingReady}
          draggable={editingReady}
          className={`mr-1 size-5 shrink-0 p-0 align-middle ${editingReady ? 'cursor-grab' : 'cursor-default opacity-50'} ${className ?? ''}`}
          onFocus={onFocus}
          onClick={(event) => {
            event.stopPropagation();
            if (!editingReady) return;
            taskFolderMoveRequest.open(identity);
          }}
          onDragStart={(event) => {
            if (!editingReady) {
              event.preventDefault();
              return;
            }
            writeTaskDrag(event.dataTransfer, identity);
            panelController.begin(childKey({ kind: 'task', identity }));
            const preview = document.createElement('div');
            preview.textContent = subject;
            preview.className = 'fixed left-0 top-0 bg-surface p-2 text-text';
            document.body.appendChild(preview);
            event.dataTransfer.setDragImage(preview, 10, 10);
            setTimeout(() => preview.remove(), 0);
          }}
          onDragEnd={() => panelController.end()}
        >
          <GripVertical className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('taskFolders.dragTask')}</TooltipContent>
    </Tooltip>
  );
};

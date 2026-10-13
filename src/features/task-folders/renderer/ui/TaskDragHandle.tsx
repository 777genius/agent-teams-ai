import { useAppTranslation } from '@features/localization/renderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { GripVertical } from 'lucide-react';

import { childKey } from '../../core/domain/folders';
import { taskFolderMoveRequest, useTaskFolderEditingReady } from '../adapters/taskFolderEditing';
import { writeTaskDrag } from '../adapters/treeDropAdapter';
import { panelController } from '../composition';

import type { TaskIdentity } from '../../core/domain/folders';
export const TaskDragHandle = ({
  identity,
  subject,
}: {
  identity: TaskIdentity;
  subject: string;
}): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const editingReady = useTaskFolderEditingReady();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={editingReady ? 0 : -1}
          aria-label={t('taskFolders.dragTask')}
          aria-disabled={!editingReady}
          data-testid="sidebar-task-drag-handle"
          draggable={editingReady}
          className={`mr-1 inline-flex align-middle ${editingReady ? 'cursor-grab' : 'cursor-default opacity-50'}`}
          onClick={(event) => {
            event.stopPropagation();
            if (!editingReady) return;
            taskFolderMoveRequest.open(identity);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              if (editingReady) taskFolderMoveRequest.open(identity);
            }
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
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('taskFolders.dragTask')}</TooltipContent>
    </Tooltip>
  );
};

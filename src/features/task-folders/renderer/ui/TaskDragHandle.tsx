import { useAppTranslation } from '@features/localization/renderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { GripVertical } from 'lucide-react';

import { childKey } from '../../core/domain/folders';
import { moveRequest } from '../adapters/moveRequest';
import { writeTaskDrag } from '../adapters/treeDropAdapter';
import { folderController, panelController } from '../composition';

import type { TaskIdentity } from '../../core/domain/folders';
export const TaskDragHandle = ({
  identity,
  subject,
}: {
  identity: TaskIdentity;
  subject: string;
}): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          aria-label={t('taskFolders.dragTask')}
          data-testid="sidebar-task-drag-handle"
          draggable
          className="mr-1 inline-flex cursor-grab align-middle"
          onClick={(event) => {
            event.stopPropagation();
            moveRequest.open(identity);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              moveRequest.open(identity);
            }
          }}
          onDragStart={(event) => {
            if (folderController.getSnapshot().status !== 'ready') {
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

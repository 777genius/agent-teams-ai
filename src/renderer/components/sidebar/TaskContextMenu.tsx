import { Fragment, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { taskFolderMoveRequest, useTaskFolderEditingReady } from '@features/task-folders/renderer';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import {
  Archive,
  ArchiveRestore,
  FolderInput,
  Mail,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';

import { buildTaskCardActions, type TaskCardAction } from './taskCardActions';

import type { GlobalTask } from '@shared/types';

export interface TaskContextMenuProps {
  task: GlobalTask;
  isPinned: boolean;
  isArchived: boolean;
  onTogglePin: () => void;
  onToggleArchive: () => void;
  onMarkUnread: () => void;
  onRename: () => void;
  onDelete?: () => void;
  children: React.ReactNode;
}

type TaskContextMenuContentProps = Pick<
  TaskContextMenuProps,
  | 'task'
  | 'isPinned'
  | 'isArchived'
  | 'onTogglePin'
  | 'onToggleArchive'
  | 'onMarkUnread'
  | 'onRename'
  | 'onDelete'
>;

const TaskContextMenuLazyContent = ({
  task,
  isPinned,
  isArchived,
  onTogglePin,
  onToggleArchive,
  onMarkUnread,
  onRename,
  onDelete,
}: TaskContextMenuContentProps): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const taskFolderEditingReady = useTaskFolderEditingReady();
  const actions = buildTaskCardActions({
    isPinned,
    isArchived,
    editingReady: taskFolderEditingReady,
    handlers: {
      onTogglePin,
      onMove: () => taskFolderMoveRequest.open({ teamName: task.teamName, taskId: task.id }),
      onRename,
      onMarkUnread,
      onToggleArchive,
      onDelete,
    },
  });
  const iconFor = (action: TaskCardAction) => {
    if (action.id === 'pin') return isPinned ? PinOff : Pin;
    if (action.id === 'move') return FolderInput;
    if (action.id === 'rename') return Pencil;
    if (action.id === 'markUnread') return Mail;
    if (action.id === 'archive') return isArchived ? ArchiveRestore : Archive;
    return Trash2;
  };

  return (
    <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
      {actions.map((action) => {
        const Icon = iconFor(action);
        return (
          <Fragment key={action.id}>
            {(action.id === 'archive' || action.id === 'delete') && <ContextMenuSeparator />}
            <ContextMenuItem
              disabled={action.disabled}
              onSelect={action.run}
              className={action.destructive ? 'text-red-400 focus:text-red-400' : undefined}
            >
              <Icon className="size-3.5 shrink-0" />
              <span>{t(action.labelKey)}</span>
            </ContextMenuItem>
          </Fragment>
        );
      })}
    </ContextMenuContent>
  );
};

export const TaskContextMenu = ({
  task,
  isPinned,
  isArchived,
  onTogglePin,
  onToggleArchive,
  onMarkUnread,
  onRename,
  onDelete,
  children,
}: TaskContextMenuProps): React.JSX.Element => {
  const [open, setOpen] = useState(false);

  return (
    <ContextMenu onOpenChange={setOpen}>
      <ContextMenuTrigger asChild>
        <div className="w-full">{children}</div>
      </ContextMenuTrigger>
      {open ? (
        <TaskContextMenuLazyContent
          task={task}
          isPinned={isPinned}
          isArchived={isArchived}
          onTogglePin={onTogglePin}
          onToggleArchive={onToggleArchive}
          onMarkUnread={onMarkUnread}
          onRename={onRename}
          onDelete={onDelete}
        />
      ) : null}
    </ContextMenu>
  );
};

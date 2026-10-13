import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { taskFolderMoveRequest, useTaskFolderEditingReady } from '@features/task-folders/renderer';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import { Archive, ArchiveRestore, Mail, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';

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

  return (
    <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
      <ContextMenuItem onSelect={onTogglePin}>
        {isPinned ? (
          <>
            <PinOff className="size-3.5 shrink-0" />
            <span>{t('taskContextMenu.unpin')}</span>
          </>
        ) : (
          <>
            <Pin className="size-3.5 shrink-0" />
            <span>{t('taskContextMenu.pin')}</span>
          </>
        )}
      </ContextMenuItem>

      <ContextMenuItem
        disabled={!taskFolderEditingReady}
        onSelect={() => taskFolderMoveRequest.open({ teamName: task.teamName, taskId: task.id })}
      >
        <span>{t('taskFolders.move')}</span>
      </ContextMenuItem>

      <ContextMenuItem onSelect={onRename}>
        <Pencil className="size-3.5 shrink-0" />
        <span>{t('taskContextMenu.rename')}</span>
      </ContextMenuItem>

      <ContextMenuItem onSelect={onMarkUnread}>
        <Mail className="size-3.5 shrink-0" />
        <span>{t('taskContextMenu.markUnread')}</span>
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={onToggleArchive}>
        {isArchived ? (
          <>
            <ArchiveRestore className="size-3.5 shrink-0" />
            <span>{t('taskContextMenu.unarchive')}</span>
          </>
        ) : (
          <>
            <Archive className="size-3.5 shrink-0" />
            <span>{t('taskContextMenu.archive')}</span>
          </>
        )}
      </ContextMenuItem>

      {onDelete && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onDelete} className="text-red-400 focus:text-red-400">
            <Trash2 className="size-3.5 shrink-0" />
            <span>{t('taskContextMenu.deleteTask')}</span>
          </ContextMenuItem>
        </>
      )}
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

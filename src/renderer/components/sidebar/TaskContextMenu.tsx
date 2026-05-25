import { useAppTranslation } from '@features/localization/renderer';
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

export const TaskContextMenu = ({
  task: _task,
  isPinned,
  isArchived,
  onTogglePin,
  onToggleArchive,
  onMarkUnread,
  onRename,
  onDelete,
  children,
}: TaskContextMenuProps): React.JSX.Element => {
  const { t } = useAppTranslation('common');

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="w-full">{children}</div>
      </ContextMenuTrigger>
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
    </ContextMenu>
  );
};

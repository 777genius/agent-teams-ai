import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import { Archive, ArchiveRestore, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';

import type { GlobalTask } from '@shared/types';

export interface TaskContextMenuProps {
  task: GlobalTask;
  isPinned: boolean;
  isArchived: boolean;
  onTogglePin: () => void;
  onToggleArchive: () => void;
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
  onRename,
  onDelete,
  children,
}: TaskContextMenuProps): React.JSX.Element => {
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
              <span>Unpin</span>
            </>
          ) : (
            <>
              <Pin className="size-3.5 shrink-0" />
              <span>Pin</span>
            </>
          )}
        </ContextMenuItem>

        <ContextMenuItem onSelect={onRename}>
          <Pencil className="size-3.5 shrink-0" />
          <span>Rename</span>
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={onToggleArchive}>
          {isArchived ? (
            <>
              <ArchiveRestore className="size-3.5 shrink-0" />
              <span>Unarchive</span>
            </>
          ) : (
            <>
              <Archive className="size-3.5 shrink-0" />
              <span>Archive</span>
            </>
          )}
        </ContextMenuItem>

        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={onDelete}
              className="text-red-400 focus:text-red-400"
            >
              <Trash2 className="size-3.5 shrink-0" />
              <span>Delete task</span>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
};

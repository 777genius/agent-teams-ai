export type TaskCardActionId =
  | 'pin'
  | 'move'
  | 'rename'
  | 'markUnread'
  | 'archive'
  | 'delete'
  | 'restore';
export type TaskCardActionLabelKey =
  | 'taskContextMenu.pin'
  | 'taskContextMenu.unpin'
  | 'taskFolders.move'
  | 'taskContextMenu.rename'
  | 'taskContextMenu.markUnread'
  | 'taskContextMenu.archive'
  | 'taskContextMenu.unarchive'
  | 'taskContextMenu.deleteTask'
  | 'taskContextMenu.restoreTask';

export interface TaskCardActionHandlers {
  onTogglePin(): void;
  onMove(): void;
  onRename(): void;
  onMarkUnread(): void;
  onToggleArchive(): void;
  onDelete?(): void;
  onRestore?(): void;
}

export interface TaskCardAction {
  id: TaskCardActionId;
  labelKey: TaskCardActionLabelKey;
  run(): void;
  restoreFocus: boolean;
  destructive?: boolean;
  disabled?: boolean;
}

export function buildTaskCardActions({
  isPinned,
  isArchived,
  isDeleted = false,
  editingReady = true,
  handlers,
  includeDelete = true,
}: {
  isPinned: boolean;
  isArchived: boolean;
  isDeleted?: boolean;
  editingReady?: boolean;
  handlers: TaskCardActionHandlers;
  includeDelete?: boolean;
}): TaskCardAction[] {
  if (isDeleted) {
    return handlers.onRestore
      ? [
          {
            id: 'restore',
            labelKey: 'taskContextMenu.restoreTask',
            run: handlers.onRestore,
            restoreFocus: true,
          },
        ]
      : [];
  }
  const actions: TaskCardAction[] = [
    {
      id: 'pin',
      labelKey: isPinned ? 'taskContextMenu.unpin' : 'taskContextMenu.pin',
      run: handlers.onTogglePin,
      restoreFocus: true,
    },
    {
      id: 'move',
      labelKey: 'taskFolders.move',
      run: handlers.onMove,
      restoreFocus: false,
      disabled: !editingReady,
    },
    {
      id: 'rename',
      labelKey: 'taskContextMenu.rename',
      run: handlers.onRename,
      restoreFocus: false,
    },
    {
      id: 'markUnread',
      labelKey: 'taskContextMenu.markUnread',
      run: handlers.onMarkUnread,
      restoreFocus: true,
    },
    {
      id: 'archive',
      labelKey: isArchived ? 'taskContextMenu.unarchive' : 'taskContextMenu.archive',
      run: handlers.onToggleArchive,
      restoreFocus: true,
    },
  ];
  if (includeDelete && handlers.onDelete) {
    actions.push({
      id: 'delete',
      labelKey: 'taskContextMenu.deleteTask',
      run: handlers.onDelete,
      restoreFocus: false,
      destructive: true,
    });
  }
  return actions;
}

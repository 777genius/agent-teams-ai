/**
 * Radix-based context menu for the editor file tree.
 *
 * Wraps children via ContextMenu.Trigger asChild. Uses event delegation
 * with `data-editor-path` / `data-editor-type` attributes on tree items
 * to determine the right-clicked target.
 */

import React, { useCallback, useRef, useState } from 'react';

import * as ContextMenu from '@radix-ui/react-context-menu';
import {
  ClipboardCopy,
  FilePlus,
  FolderOpen,
  FolderPlus,
  ListTodo,
  MessageSquare,
  Pencil,
  Trash2,
} from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

interface TargetEntry {
  path: string;
  isDir: boolean;
  isSensitive: boolean;
}

interface EditorContextMenuProps {
  children: React.ReactNode;
  projectPath: string | null;
  onNewFile: (parentDir: string) => void;
  onNewFolder: (parentDir: string) => void;
  onDelete: (path: string) => void;
  onRename: (path: string) => void;
  /** Trigger "Create Task" with a file mention (files only, not directories) */
  onCreateTask?: (filePath: string) => void;
  /** Trigger "Write Teammate" with a file mention (files only, not directories) */
  onSendMessage?: (filePath: string) => void;
}

// =============================================================================
// Component
// =============================================================================

export const EditorContextMenu = ({
  children,
  projectPath,
  onNewFile,
  onNewFolder,
  onDelete,
  onRename,
  onCreateTask,
  onSendMessage,
}: EditorContextMenuProps): React.ReactElement => {
  const [target, setTarget] = useState<TargetEntry | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    // Walk up from target to find the nearest element with data-editor-path
    let el = e.target as HTMLElement | null;
    while (el && el !== e.currentTarget) {
      const path = el.getAttribute('data-editor-path');
      if (path) {
        const type = el.getAttribute('data-editor-type');
        const sensitive = el.getAttribute('data-editor-sensitive');
        setTarget({
          path,
          isDir: type === 'directory',
          isSensitive: sensitive === 'true',
        });
        return;
      }
      el = el.parentElement;
    }
    // Clicked on empty area — still show menu but with limited options
    setTarget(null);
  }, []);

  const parentDir = target
    ? target.isDir
      ? target.path
      : target.path.substring(0, target.path.lastIndexOf('/'))
    : null;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div ref={triggerRef} onContextMenu={handleContextMenu} className="h-full">
          {children}
        </div>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-[180px] rounded-md border border-border-emphasis bg-surface-overlay p-1 shadow-lg animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95">
          {parentDir && (
            <>
              <ContextMenu.Item
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-text outline-none hover:bg-surface-raised focus:bg-surface-raised"
                onSelect={() => onNewFile(parentDir)}
              >
                <FilePlus className="size-3.5 text-text-muted" />
                New File
              </ContextMenu.Item>

              <ContextMenu.Item
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-text outline-none hover:bg-surface-raised focus:bg-surface-raised"
                onSelect={() => onNewFolder(parentDir)}
              >
                <FolderPlus className="size-3.5 text-text-muted" />
                New Folder
              </ContextMenu.Item>

              <ContextMenu.Separator className="my-1 h-px bg-border" />
            </>
          )}

          {target && (
            <>
              <ContextMenu.Item
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-text outline-none hover:bg-surface-raised focus:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
                disabled={target.isSensitive}
                onSelect={() => onRename(target.path)}
              >
                <Pencil className="size-3.5 text-text-muted" />
                Rename
              </ContextMenu.Item>

              <ContextMenu.Item
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-red-400 outline-none hover:bg-surface-raised focus:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
                disabled={target.isSensitive}
                onSelect={() => onDelete(target.path)}
              >
                <Trash2 className="size-3.5" />
                Delete
              </ContextMenu.Item>

              <ContextMenu.Separator className="my-1 h-px bg-border" />
            </>
          )}

          {target && (
            <>
              <ContextMenu.Item
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-text outline-none hover:bg-surface-raised focus:bg-surface-raised"
                onSelect={() => void navigator.clipboard.writeText(target.path)}
              >
                <ClipboardCopy className="size-3.5 text-text-muted" />
                Copy Path
              </ContextMenu.Item>

              {projectPath && target.path.startsWith(projectPath) && (
                <ContextMenu.Item
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-text outline-none hover:bg-surface-raised focus:bg-surface-raised"
                  onSelect={() => {
                    const relative = target.path.slice(projectPath.length + 1);
                    void navigator.clipboard.writeText(relative);
                  }}
                >
                  <ClipboardCopy className="size-3.5 text-text-muted" />
                  Copy Relative Path
                </ContextMenu.Item>
              )}

              <ContextMenu.Separator className="my-1 h-px bg-border" />

              <ContextMenu.Item
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-text outline-none hover:bg-surface-raised focus:bg-surface-raised"
                onSelect={() => {
                  void window.electronAPI.showInFolder(target.path);
                }}
              >
                <FolderOpen className="size-3.5 text-text-muted" />
                Reveal in Finder
              </ContextMenu.Item>
            </>
          )}

          {/* Team actions — file only */}
          {target && !target.isDir && (onCreateTask || onSendMessage) && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-border" />
              {onSendMessage && (
                <ContextMenu.Item
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-text outline-none hover:bg-surface-raised focus:bg-surface-raised"
                  onSelect={() => onSendMessage(target.path)}
                >
                  <MessageSquare className="size-3.5 text-text-muted" />
                  Write Teammate
                </ContextMenu.Item>
              )}
              {onCreateTask && (
                <ContextMenu.Item
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-text outline-none hover:bg-surface-raised focus:bg-surface-raised"
                  onSelect={() => onCreateTask(target.path)}
                >
                  <ListTodo className="size-3.5 text-text-muted" />
                  Create Task
                </ContextMenu.Item>
              )}
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
};

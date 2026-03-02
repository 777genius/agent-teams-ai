/**
 * Editor file tree — virtualized with @tanstack/react-virtual.
 *
 * Renders project files with file-type icons, sensitive-file lock icons,
 * directory expand/collapse, context menu, inline file creation, and drag & drop.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { useStore } from '@renderer/store';
import { sortTreeNodes } from '@renderer/utils/fileTreeBuilder';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Lock } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { EditorContextMenu } from './EditorContextMenu';
import { FileIcon } from './FileIcon';
import { GitStatusBadge } from './GitStatusBadge';
import { NewFileDialog } from './NewFileDialog';

import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import type { TreeNode } from '@renderer/utils/fileTreeBuilder';
import type { FileTreeEntry, GitFileStatusType } from '@shared/types/editor';

// =============================================================================
// Types
// =============================================================================

interface EditorFileTreeProps {
  selectedFilePath: string | null;
  onFileSelect: (filePath: string) => void;
  /** Trigger "Create Task" with a file mention from context menu */
  onCreateTask?: (filePath: string) => void;
  /** Trigger "Write Teammate" with a file mention from context menu */
  onSendMessage?: (filePath: string) => void;
}

interface NewItemState {
  parentDir: string;
  type: 'file' | 'directory';
}

/** Flat item for virtualization */
interface FlatTreeItem {
  node: TreeNode<FileTreeEntry>;
  depth: number;
  isExpanded: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const ITEM_HEIGHT = 28;
const INDENT_PX = 12;
const MAX_DEPTH = 12;
const AUTO_EXPAND_DELAY_MS = 500;

// =============================================================================
// Component
// =============================================================================

// Render counter for debugging — tracks how often the tree re-renders
let fileTreeRenderCount = 0;

export const EditorFileTree = ({
  selectedFilePath,
  onFileSelect,
  onCreateTask,
  onSendMessage,
}: EditorFileTreeProps): React.ReactElement => {
  fileTreeRenderCount++;
  if (fileTreeRenderCount % 5 === 0) {
    console.debug(`[perf] EditorFileTree render #${fileTreeRenderCount}`);
  }
  // Data selectors — grouped with useShallow to prevent unnecessary re-renders
  const { fileTree, expandedDirs, loading, error, gitFiles, projectPath } = useStore(
    useShallow((s) => ({
      fileTree: s.editorFileTree,
      expandedDirs: s.editorExpandedDirs,
      loading: s.editorFileTreeLoading,
      error: s.editorFileTreeError,
      gitFiles: s.editorGitFiles,
      projectPath: s.editorProjectPath,
    }))
  );

  // Actions — stable references in Zustand, no grouping needed
  const expandDirectory = useStore((s) => s.expandDirectory);
  const collapseDirectory = useStore((s) => s.collapseDirectory);
  const createFileInTree = useStore((s) => s.createFileInTree);
  const createDirInTree = useStore((s) => s.createDirInTree);
  const deleteFileFromTree = useStore((s) => s.deleteFileFromTree);
  const moveFileInTree = useStore((s) => s.moveFileInTree);
  const renameFileInTree = useStore((s) => s.renameFileInTree);
  const openFile = useStore((s) => s.openFile);

  const [newItemState, setNewItemState] = useState<NewItemState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [deleteConfirmPath, setDeleteConfirmPath] = useState<string | null>(null);
  const [draggedItem, setDraggedItem] = useState<FlatTreeItem | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Defer DnD initialization — mount tree without drag/drop first, enable after idle
  const [dndReady, setDndReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => setDndReady(true));
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Cleanup auto-expand timer on unmount
  useEffect(() => {
    return () => {
      if (autoExpandTimerRef.current) clearTimeout(autoExpandTimerRef.current);
    };
  }, []);

  // DnD sensors — 5px distance to prevent accidental drags
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Convert hierarchical FileTreeEntry[] → TreeNode[] (respects entry.type)
  const treeNodes = useMemo(() => {
    if (!fileTree) return [];
    const t0 = performance.now();
    const nodes = sortTreeNodes(convertEntriesToNodes(fileTree));
    const ms = performance.now() - t0;
    if (ms > 2) console.debug(`[perf] treeNodes: ${ms.toFixed(1)}ms, nodes=${nodes.length}`);
    return nodes;
  }, [fileTree]);

  // Flatten tree into visible items list for virtualization
  // expandedDirs is keyed by absolute path, and node.fullPath = entry.path (absolute)
  const flatItems = useMemo(() => {
    const t0 = performance.now();
    const items: FlatTreeItem[] = [];
    flattenVisible(treeNodes, expandedDirs, items, 0);
    const ms = performance.now() - t0;
    if (ms > 2) console.debug(`[perf] flatItems: ${ms.toFixed(1)}ms, items=${items.length}`);
    return items;
  }, [treeNodes, expandedDirs]);

  // Lookup: fullPath → FlatTreeItem (for drag start)
  const flatItemsByPath = useMemo(() => {
    const map = new Map<string, FlatTreeItem>();
    for (const item of flatItems) {
      map.set(item.node.fullPath, item);
    }
    return map;
  }, [flatItems]);

  // Compute insertion index for inline new-item input
  const newItemInsert = useMemo(() => {
    if (!newItemState) return null;
    const { parentDir } = newItemState;

    const parentIdx = flatItems.findIndex((fi) => fi.node.fullPath === parentDir);

    if (parentIdx === -1) {
      // parentDir is the project root (not a node in flatItems) — insert at top
      return { index: 0, depth: 0 };
    }

    // Insert right after the parent directory node (top of its children)
    return { index: parentIdx + 1, depth: flatItems[parentIdx].depth + 1 };
  }, [newItemState, flatItems]);

  // Virtual scrolling — reduced overscan during initial mount, increase during drag
  const virtualizer = useVirtualizer({
    count: flatItems.length + (newItemInsert ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: !dndReady ? 3 : draggedItem ? 20 : 10,
  });

  // Scroll to file when selectedFilePath changes (e.g. from revealFileInEditor)
  useEffect(() => {
    if (!selectedFilePath) return;
    const idx = flatItems.findIndex((fi) => fi.node.fullPath === selectedFilePath);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: 'center' });
    }
  }, [selectedFilePath, flatItems, virtualizer]);

  // Git status lookup: absolute path → status type
  const gitStatusMap = useMemo(() => {
    const t0 = performance.now();
    const map = new Map<string, GitFileStatusType>();
    if (!gitFiles.length || !projectPath) return map;
    for (const file of gitFiles) {
      const absPath = projectPath.endsWith('/')
        ? `${projectPath}${file.path}`
        : `${projectPath}/${file.path}`;
      map.set(absPath, file.status);
    }
    const ms = performance.now() - t0;
    if (ms > 2) console.debug(`[perf] gitStatusMap: ${ms.toFixed(1)}ms, files=${gitFiles.length}`);
    return map;
  }, [gitFiles, projectPath]);

  // Active node path for selection highlight (fullPath = absolute path)
  const activeNodePath = selectedFilePath;

  const handleNodeClick = useCallback(
    (node: TreeNode<FileTreeEntry>) => {
      if (!node.data) return;
      if (node.data.isSensitive) return;
      if (node.isFile) {
        onFileSelect(node.data.path);
      } else {
        // fullPath = absolute path = entry.path
        if (expandedDirs[node.fullPath]) {
          collapseDirectory(node.fullPath);
        } else {
          void expandDirectory(node.fullPath);
        }
      }
    },
    [onFileSelect, expandedDirs, expandDirectory, collapseDirectory]
  );

  // Context menu handlers — expand parent directory so the input appears inline
  const handleNewFile = useCallback(
    (parentDir: string) => {
      if (parentDir !== projectPath && !expandedDirs[parentDir]) {
        void expandDirectory(parentDir);
      }
      setNewItemState({ parentDir, type: 'file' });
    },
    [projectPath, expandedDirs, expandDirectory]
  );

  const handleNewFolder = useCallback(
    (parentDir: string) => {
      if (parentDir !== projectPath && !expandedDirs[parentDir]) {
        void expandDirectory(parentDir);
      }
      setNewItemState({ parentDir, type: 'directory' });
    },
    [projectPath, expandedDirs, expandDirectory]
  );

  const handleDelete = useCallback((path: string) => {
    setDeleteConfirmPath(path);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirmPath) return;
    await deleteFileFromTree(deleteConfirmPath);
    setDeleteConfirmPath(null);
  }, [deleteConfirmPath, deleteFileFromTree]);

  const handleCancelDelete = useCallback(() => {
    setDeleteConfirmPath(null);
  }, []);

  const handleRename = useCallback((path: string) => {
    setRenamingPath(path);
  }, []);

  const handleRenameSubmit = useCallback(
    async (newName: string) => {
      if (!renamingPath) return;
      await renameFileInTree(renamingPath, newName);
      setRenamingPath(null);
    },
    [renamingPath, renameFileInTree]
  );

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const handleNewItemSubmit = useCallback(
    async (name: string) => {
      if (!newItemState) return;
      if (newItemState.type === 'file') {
        const filePath = await createFileInTree(newItemState.parentDir, name);
        if (filePath) openFile(filePath);
      } else {
        await createDirInTree(newItemState.parentDir, name);
      }
      setNewItemState(null);
    },
    [newItemState, createFileInTree, createDirInTree, openFile]
  );

  const handleNewItemCancel = useCallback(() => {
    setNewItemState(null);
  }, []);

  // ─── Drag & Drop handlers ──────────────────────────────────────────────────

  const clearAutoExpandTimer = useCallback(() => {
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = String(event.active.id);
      const item = flatItemsByPath.get(id);
      if (item) setDraggedItem(item);
    },
    [flatItemsByPath]
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { over } = event;
      if (!over || !draggedItem) {
        setDropTargetPath(null);
        clearAutoExpandTimer();
        return;
      }

      const overId = String(over.id);
      let targetDir: string | null = null;

      if (overId === 'root-drop-zone') {
        targetDir = projectPath;
      } else if (overId.startsWith('drop:')) {
        // Directory drop target
        targetDir = overId.slice(5);
      } else {
        // File — drop into its parent directory
        const item = flatItemsByPath.get(overId);
        if (item) {
          const p = item.node.fullPath;
          targetDir = p.substring(0, p.lastIndexOf('/'));
        }
      }

      if (targetDir !== dropTargetPath) {
        setDropTargetPath(targetDir);
        clearAutoExpandTimer();

        // Auto-expand collapsed folders after 500ms hover
        if (targetDir && targetDir !== projectPath && !expandedDirs[targetDir]) {
          autoExpandTimerRef.current = setTimeout(() => {
            void expandDirectory(targetDir);
          }, AUTO_EXPAND_DELAY_MS);
        }
      }
    },
    [
      draggedItem,
      dropTargetPath,
      projectPath,
      flatItemsByPath,
      expandedDirs,
      expandDirectory,
      clearAutoExpandTimer,
    ]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      clearAutoExpandTimer();
      const sourcePath = draggedItem?.node.fullPath;

      if (!sourcePath || !dropTargetPath || !event.over) {
        setDraggedItem(null);
        setDropTargetPath(null);
        return;
      }

      const destDir = dropTargetPath;
      const sourceParent = sourcePath.substring(0, sourcePath.lastIndexOf('/'));

      // Validation: same folder = no-op
      if (sourceParent === destDir) {
        setDraggedItem(null);
        setDropTargetPath(null);
        return;
      }

      // Validation: parent → child prevention
      if (destDir.startsWith(sourcePath + '/') || destDir === sourcePath) {
        setDraggedItem(null);
        setDropTargetPath(null);
        return;
      }

      // Validation: sensitive files
      if (draggedItem?.node.data?.isSensitive) {
        setDraggedItem(null);
        setDropTargetPath(null);
        return;
      }

      void moveFileInTree(sourcePath, destDir);

      setDraggedItem(null);
      setDropTargetPath(null);
    },
    [draggedItem, dropTargetPath, moveFileInTree, clearAutoExpandTimer]
  );

  const handleDragCancel = useCallback(() => {
    clearAutoExpandTimer();
    setDraggedItem(null);
    setDropTargetPath(null);
  }, [clearAutoExpandTimer]);

  // ─── Early returns ─────────────────────────────────────────────────────────

  if (error) {
    return <div className="p-3 text-xs text-red-400">Failed to load files: {error}</div>;
  }

  if (loading && !fileTree) {
    return <div className="p-3 text-xs text-text-muted">Loading files...</div>;
  }

  if (treeNodes.length === 0) {
    return <div className="p-3 text-xs text-text-muted">No files found</div>;
  }

  return (
    <EditorContextMenu
      projectPath={projectPath}
      onNewFile={handleNewFile}
      onNewFolder={handleNewFolder}
      onDelete={handleDelete}
      onRename={handleRename}
      onCreateTask={onCreateTask}
      onSendMessage={onSendMessage}
    >
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        autoScroll={{ threshold: { x: 0, y: 0.15 } }}
      >
        <RootDropZone
          ref={scrollRef}
          projectPath={projectPath}
          isDropTarget={dropTargetPath === projectPath}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const { index } = virtualItem;

              // Render inline new-item input at the correct tree position
              if (index === newItemInsert?.index) {
                return (
                  <div
                    key="__new-item-input__"
                    style={{
                      position: 'absolute',
                      top: `${virtualItem.start}px`,
                      left: 0,
                      width: '100%',
                      height: `${virtualItem.size}px`,
                      paddingLeft: `${Math.min(newItemInsert.depth, MAX_DEPTH) * INDENT_PX}px`,
                    }}
                  >
                    <NewFileDialog
                      type={newItemState!.type}
                      parentDir={newItemState!.parentDir}
                      onSubmit={handleNewItemSubmit}
                      onCancel={handleNewItemCancel}
                    />
                  </div>
                );
              }

              // Adjust index for items after the insertion point
              const flatIdx = newItemInsert && index > newItemInsert.index ? index - 1 : index;
              const item = flatItems[flatIdx];

              return (
                <div
                  key={item.node.fullPath}
                  style={{
                    position: 'absolute',
                    top: `${virtualItem.start}px`,
                    left: 0,
                    width: '100%',
                    height: `${virtualItem.size}px`,
                  }}
                >
                  <DraggableTreeItem
                    item={item}
                    activeNodePath={activeNodePath}
                    gitStatus={gitStatusMap.get(item.node.fullPath)}
                    dropTargetPath={dropTargetPath}
                    isDragActive={!!draggedItem}
                    onClick={handleNodeClick}
                    isRenaming={renamingPath === item.node.fullPath}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={handleRenameCancel}
                  />
                </div>
              );
            })}
          </div>
          {/* Spacer at bottom — drop here to move to project root */}
          {draggedItem && (
            <div className="h-16 w-full shrink-0" aria-label="Drop here for project root" />
          )}
        </RootDropZone>
        <DragOverlay dropAnimation={null}>
          {draggedItem && <DragOverlayFileItem item={draggedItem} />}
        </DragOverlay>
      </DndContext>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteConfirmPath} onOpenChange={(open) => !open && handleCancelDelete()}>
        <DialogContent className="w-96 max-w-96">
          <DialogHeader>
            <DialogTitle className="text-sm">Move to Trash</DialogTitle>
            <DialogDescription>
              Move &ldquo;{deleteConfirmPath?.split('/').pop() ?? ''}&rdquo; to Trash?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={handleCancelDelete}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void handleConfirmDelete()}>
              Move to Trash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </EditorContextMenu>
  );
};

// =============================================================================
// Root drop zone (drop files to project root)
// =============================================================================

const RootDropZone = React.forwardRef<
  HTMLDivElement,
  { projectPath: string | null; isDropTarget: boolean; children: React.ReactNode }
>(({ projectPath, isDropTarget, children }, ref) => {
  const { setNodeRef } = useDroppable({
    id: 'root-drop-zone',
    data: { isRoot: true, path: projectPath },
  });

  // Combine forwarded ref with droppable ref
  const combinedRef = useCallback(
    (el: HTMLDivElement | null) => {
      setNodeRef(el);
      if (typeof ref === 'function') ref(el);
      // eslint-disable-next-line no-param-reassign -- combining forwarded ref with droppable ref
      else if (ref) ref.current = el;
    },
    [ref, setNodeRef]
  );

  return (
    <div
      ref={combinedRef}
      className={`scrollbar-thin h-full overflow-y-auto transition-colors ${
        isDropTarget ? 'bg-blue-400/5 ring-1 ring-inset ring-blue-400/30' : ''
      }`}
      role="tree"
    >
      {children}
    </div>
  );
});

RootDropZone.displayName = 'RootDropZone';

// =============================================================================
// Draggable + droppable tree item
// =============================================================================

interface DraggableTreeItemProps {
  item: FlatTreeItem;
  activeNodePath: string | null;
  gitStatus?: GitFileStatusType;
  dropTargetPath: string | null;
  isDragActive: boolean;
  onClick: (node: TreeNode<FileTreeEntry>) => void;
  isRenaming?: boolean;
  onRenameSubmit?: (newName: string) => void;
  onRenameCancel?: () => void;
}

/* eslint-disable react/jsx-props-no-spreading -- dnd-kit requires prop spreading for drag attributes, listeners, and data attributes */
const DraggableTreeItem = React.memo(
  ({
    item,
    activeNodePath,
    gitStatus,
    dropTargetPath,
    isDragActive,
    onClick,
    isRenaming,
    onRenameSubmit,
    onRenameCancel,
  }: DraggableTreeItemProps): React.ReactElement => {
    const { node, depth, isExpanded } = item;
    const isSelected = activeNodePath === node.fullPath;
    const visualDepth = Math.min(depth, MAX_DEPTH);
    const isSensitive = node.data?.isSensitive;

    // Draggable setup
    const {
      attributes,
      listeners,
      setNodeRef: setDragRef,
      isDragging,
    } = useDraggable({
      id: node.fullPath,
      data: { node, depth },
      disabled: !!isSensitive,
    });

    // Droppable setup — only directories are drop targets
    const { setNodeRef: setDropRef } = useDroppable({
      id: 'drop:' + node.fullPath,
      data: { node },
      disabled: node.isFile,
    });

    // Combine refs
    const ref = useCallback(
      (el: HTMLDivElement | null) => {
        setDragRef(el);
        if (!node.isFile) setDropRef(el);
      },
      [setDragRef, setDropRef, node.isFile]
    );

    // Visual: highlight drop target directory and its visible children
    const isDropTarget = !node.isFile && dropTargetPath === node.fullPath;
    const isInsideDropTarget =
      dropTargetPath != null && node.fullPath.startsWith(dropTargetPath + '/');

    const dataAttrs: Record<string, string> = {};
    if (node.data) {
      dataAttrs['data-editor-path'] = node.data.path;
      dataAttrs['data-editor-type'] = node.data.type;
      if (node.data.isSensitive) dataAttrs['data-editor-sensitive'] = 'true';
    }

    const handleClick = (): void => {
      if (!isDragActive) onClick(node);
    };
    const handleKeyDown = (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    };

    // Render icon
    let icon: React.ReactNode;
    if (node.data?.isSensitive) {
      icon = <Lock className="size-3.5 shrink-0 text-yellow-500" />;
    } else if (node.isFile) {
      icon = <FileIcon fileName={node.name} className="size-3.5" />;
    } else if (isExpanded) {
      icon = <FolderOpen className="size-3.5 shrink-0 text-text-muted" />;
    } else {
      icon = <Folder className="size-3.5 shrink-0 text-text-muted" />;
    }

    return (
      <div
        ref={ref}
        {...attributes}
        {...listeners}
        role="treeitem"
        aria-selected={node.isFile ? isSelected : undefined}
        aria-expanded={!node.isFile ? isExpanded : undefined}
        className={`flex h-full cursor-pointer select-none items-center gap-1 truncate px-2 text-xs transition-colors hover:bg-surface-raised ${
          isSelected ? 'bg-surface-raised text-text' : 'text-text-secondary'
        } ${isDragging ? 'opacity-30' : ''} ${
          isDropTarget ? 'rounded bg-blue-400/10 ring-2 ring-blue-400/50' : ''
        } ${isInsideDropTarget && !isDropTarget ? 'border-l-2 border-l-blue-400/40 bg-blue-400/5' : ''}`}
        style={{ paddingLeft: `${visualDepth * INDENT_PX + 8}px` }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        title={node.data?.path ?? node.fullPath}
        {...dataAttrs}
      >
        {!node.isFile &&
          (isExpanded ? (
            <ChevronDown className="size-3 shrink-0 text-text-muted" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-text-muted" />
          ))}
        {icon}
        {isRenaming ? (
          <InlineRenameInput
            initialName={node.name}
            onSubmit={onRenameSubmit!}
            onCancel={onRenameCancel!}
          />
        ) : (
          <span className="truncate">{node.name}</span>
        )}
        {!isRenaming && gitStatus && <GitStatusBadge status={gitStatus} />}
      </div>
    );
  }
);

DraggableTreeItem.displayName = 'DraggableTreeItem';
/* eslint-enable react/jsx-props-no-spreading -- re-enable after DraggableTreeItem component */

// =============================================================================
// Drag overlay ghost
// =============================================================================

const DragOverlayFileItem = ({ item }: { item: FlatTreeItem }): React.ReactElement => {
  const { node } = item;

  let icon: React.ReactNode;
  if (node.isFile) {
    icon = <FileIcon fileName={node.name} className="size-3.5" />;
  } else {
    icon = <FolderOpen className="size-3.5 text-text-muted" />;
  }

  return (
    <div className="flex items-center gap-1.5 rounded border border-border-emphasis bg-surface-overlay px-3 py-1 text-xs text-text shadow-lg">
      {icon}
      <span className="truncate">{node.name}</span>
    </div>
  );
};

// =============================================================================
// Inline rename input
// =============================================================================

const InlineRenameInput = ({
  initialName,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  onSubmit: (newName: string) => void;
  onCancel: () => void;
}): React.ReactElement => {
  const [value, setValue] = useState(initialName);
  const submitted = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select on mount (delayed to survive Radix/DnD focus interference)
  useEffect(() => {
    const timer = setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const dotIdx = initialName.lastIndexOf('.');
      if (dotIdx > 0) {
        input.setSelectionRange(0, dotIdx);
      } else {
        input.select();
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [initialName]);

  // Click-outside → submit (replaces unreliable onBlur)
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent): void => {
      if (inputRef.current && !inputRef.current.contains(e.target as Node)) {
        doSubmit();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', handlePointerDown, true);
    }, 150);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doSubmit reads value via ref pattern
  }, []);

  const doSubmit = (): void => {
    if (submitted.current) return;
    submitted.current = true;
    const trimmed = inputRef.current?.value.trim() ?? '';
    if (trimmed && trimmed !== initialName) {
      onSubmit(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doSubmit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
        e.stopPropagation();
      }}
      onBlur={() => requestAnimationFrame(() => inputRef.current?.focus())}
      onClick={(e) => e.stopPropagation()}
      className="min-w-0 flex-1 rounded border border-blue-400/50 bg-surface px-1 py-0 text-xs text-text outline-none focus:ring-1 focus:ring-blue-400/50"
    />
  );
};

// =============================================================================
// Helpers
// =============================================================================

/** Convert hierarchical FileTreeEntry[] into TreeNode[] using entry.type for classification */
function convertEntriesToNodes(entries: FileTreeEntry[]): TreeNode<FileTreeEntry>[] {
  return entries.map((entry) => ({
    name: entry.name,
    fullPath: entry.path, // absolute path — matches expandedDirs keys
    isFile: entry.type === 'file',
    data: entry,
    children: entry.children ? convertEntriesToNodes(entry.children) : [],
  }));
}

/** Flatten tree into visible items list (DFS, respecting expanded state) */
function flattenVisible(
  nodes: TreeNode<FileTreeEntry>[],
  expandedPaths: Record<string, boolean>,
  result: FlatTreeItem[],
  depth: number
): void {
  for (const node of nodes) {
    const isExpanded = !node.isFile && expandedPaths[node.fullPath] === true;
    result.push({ node, depth, isExpanded });
    if (isExpanded && node.children.length > 0) {
      flattenVisible(node.children, expandedPaths, result, depth + 1);
    }
  }
}

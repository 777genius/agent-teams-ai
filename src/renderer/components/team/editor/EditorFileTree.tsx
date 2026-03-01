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
import { useStore } from '@renderer/store';
import { sortTreeNodes } from '@renderer/utils/fileTreeBuilder';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Lock } from 'lucide-react';

import { EditorContextMenu } from './EditorContextMenu';
import { getFileIcon } from './fileIcons';
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

export const EditorFileTree = ({
  selectedFilePath,
  onFileSelect,
}: EditorFileTreeProps): React.ReactElement => {
  const fileTree = useStore((s) => s.editorFileTree);
  const expandedDirs = useStore((s) => s.editorExpandedDirs);
  const expandDirectory = useStore((s) => s.expandDirectory);
  const collapseDirectory = useStore((s) => s.collapseDirectory);
  const loading = useStore((s) => s.editorFileTreeLoading);
  const error = useStore((s) => s.editorFileTreeError);
  const createFileInTree = useStore((s) => s.createFileInTree);
  const createDirInTree = useStore((s) => s.createDirInTree);
  const deleteFileFromTree = useStore((s) => s.deleteFileFromTree);
  const moveFileInTree = useStore((s) => s.moveFileInTree);
  const openFile = useStore((s) => s.openFile);
  const gitFiles = useStore((s) => s.editorGitFiles);
  const projectPath = useStore((s) => s.editorProjectPath);

  const [newItemState, setNewItemState] = useState<NewItemState | null>(null);
  const [draggedItem, setDraggedItem] = useState<FlatTreeItem | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
    return sortTreeNodes(convertEntriesToNodes(fileTree));
  }, [fileTree]);

  // Flatten tree into visible items list for virtualization
  // expandedDirs is keyed by absolute path, and node.fullPath = entry.path (absolute)
  const flatItems = useMemo(() => {
    const items: FlatTreeItem[] = [];
    flattenVisible(treeNodes, expandedDirs, items, 0);
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

  // Virtual scrolling — increase overscan during drag for more drop targets
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: draggedItem ? 20 : 10,
  });

  // Git status lookup: absolute path → status type
  const gitStatusMap = useMemo(() => {
    const map = new Map<string, GitFileStatusType>();
    if (!gitFiles.length || !projectPath) return map;
    for (const file of gitFiles) {
      const absPath = projectPath.endsWith('/')
        ? `${projectPath}${file.path}`
        : `${projectPath}/${file.path}`;
      map.set(absPath, file.status);
    }
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

  // Context menu handlers
  const handleNewFile = useCallback((parentDir: string) => {
    setNewItemState({ parentDir, type: 'file' });
  }, []);

  const handleNewFolder = useCallback((parentDir: string) => {
    setNewItemState({ parentDir, type: 'directory' });
  }, []);

  const handleDelete = useCallback(
    async (path: string) => {
      const fileName = path.split('/').pop() ?? path;
      const confirmed = window.confirm(`Move "${fileName}" to Trash?`);
      if (!confirmed) return;
      await deleteFileFromTree(path);
    },
    [deleteFileFromTree]
  );

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
      onNewFile={handleNewFile}
      onNewFolder={handleNewFolder}
      onDelete={handleDelete}
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
              const item = flatItems[virtualItem.index];
              return (
                <DraggableTreeItem
                  key={item.node.fullPath}
                  item={item}
                  activeNodePath={activeNodePath}
                  gitStatusMap={gitStatusMap}
                  dropTargetPath={dropTargetPath}
                  isDragActive={!!draggedItem}
                  onClick={handleNodeClick}
                  style={{
                    position: 'absolute',
                    top: `${virtualItem.start}px`,
                    left: 0,
                    width: '100%',
                    height: `${virtualItem.size}px`,
                  }}
                />
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
      {newItemState && (
        <NewFileDialog
          type={newItemState.type}
          parentDir={newItemState.parentDir}
          onSubmit={handleNewItemSubmit}
          onCancel={handleNewItemCancel}
        />
      )}
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
      className={`h-full overflow-y-auto transition-colors ${
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
  gitStatusMap: Map<string, GitFileStatusType>;
  dropTargetPath: string | null;
  isDragActive: boolean;
  onClick: (node: TreeNode<FileTreeEntry>) => void;
  style: React.CSSProperties;
}

/* eslint-disable react/jsx-props-no-spreading -- dnd-kit requires prop spreading for drag attributes, listeners, and data attributes */
const DraggableTreeItem = React.memo(
  ({
    item,
    activeNodePath,
    gitStatusMap,
    dropTargetPath,
    isDragActive,
    onClick,
    style,
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

    // Visual: highlight drop target directory
    const isDropTarget = !node.isFile && dropTargetPath === node.fullPath;

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
      const fileIcon = getFileIcon(node.name);
      const FileIcon = fileIcon.icon;
      icon = <FileIcon className="size-3.5 shrink-0" style={{ color: fileIcon.color }} />;
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
        className={`flex cursor-pointer select-none items-center gap-1 truncate px-2 text-xs transition-colors hover:bg-surface-raised ${
          isSelected ? 'bg-surface-raised text-text' : 'text-text-secondary'
        } ${isDragging ? 'opacity-30' : ''} ${
          isDropTarget ? 'rounded bg-blue-400/10 ring-2 ring-blue-400/50' : ''
        }`}
        style={{
          ...style,
          paddingLeft: `${visualDepth * INDENT_PX + 8}px`,
          display: 'flex',
          alignItems: 'center',
        }}
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
        <span className="truncate">{node.name}</span>
        {node.data && gitStatusMap.has(node.data.path) && (
          <GitStatusBadge status={gitStatusMap.get(node.data.path)!} />
        )}
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
    const fileIcon = getFileIcon(node.name);
    const FileIcon = fileIcon.icon;
    icon = <FileIcon className="size-3.5" style={{ color: fileIcon.color }} />;
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

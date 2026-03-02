import { useCallback, useEffect, useMemo, useState } from 'react';

import { FileIcon } from '@renderer/components/team/editor/FileIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { getFileHunkCount } from '@renderer/store/slices/changeReviewSlice';
import { buildTree, sortTreeNodes } from '@renderer/utils/fileTreeBuilder';
import {
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  Eye,
  Folder,
  FolderOpen,
  X as XIcon,
} from 'lucide-react';

import type { TreeNode } from '@renderer/utils/fileTreeBuilder';
import type { HunkDecision } from '@shared/types';
import type { FileChangeSummary } from '@shared/types/review';

interface ReviewFileTreeProps {
  files: FileChangeSummary[];
  selectedFilePath: string | null;
  onSelectFile: (filePath: string) => void;
  viewedSet?: Set<string>;
  onMarkViewed?: (filePath: string) => void;
  onUnmarkViewed?: (filePath: string) => void;
  activeFilePath?: string;
}

type FileStatus = 'pending' | 'accepted' | 'rejected' | 'mixed';

function getFileStatus(
  file: FileChangeSummary,
  hunkDecisions: Record<string, HunkDecision>,
  fileDecisions: Record<string, HunkDecision>,
  fileChunkCounts: Record<string, number>
): FileStatus {
  // File-level decision takes priority (set by Accept All / Reject All)
  const fileDec = fileDecisions[file.filePath];
  if (fileDec === 'accepted') return 'accepted';
  if (fileDec === 'rejected') return 'rejected';

  const count = getFileHunkCount(file.filePath, file.snippets.length, fileChunkCounts);
  if (count === 0) return 'pending';

  const decisions: HunkDecision[] = [];
  for (let i = 0; i < count; i++) {
    const key = `${file.filePath}:${i}`;
    decisions.push(hunkDecisions[key] ?? 'pending');
  }

  const allAccepted = decisions.every((d) => d === 'accepted');
  const allRejected = decisions.every((d) => d === 'rejected');
  const allPending = decisions.every((d) => d === 'pending');

  if (allPending) return 'pending';
  if (allAccepted) return 'accepted';
  if (allRejected) return 'rejected';
  return 'mixed';
}

const statusLabels: Record<FileStatus, string> = {
  accepted: 'All changes accepted',
  rejected: 'All changes rejected',
  mixed: 'Partially reviewed',
  pending: 'Pending review',
};

const FileStatusIcon = ({ status }: { status: FileStatus }): JSX.Element => {
  const icon = (() => {
    switch (status) {
      case 'accepted':
        return <Check className="size-3 shrink-0 text-green-400" />;
      case 'rejected':
        return <XIcon className="size-3 shrink-0 text-red-400" />;
      case 'mixed':
        return <CircleDot className="size-3 shrink-0 text-yellow-400" />;
      case 'pending':
      default:
        return <Circle className="size-3 shrink-0 text-zinc-500" />;
    }
  })();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">{icon}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{statusLabels[status]}</TooltipContent>
    </Tooltip>
  );
};

const TreeItem = ({
  node,
  selectedFilePath,
  activeFilePath,
  onSelectFile,
  depth,
  hunkDecisions,
  fileDecisions,
  fileChunkCounts,
  viewedSet,
  collapsedFolders,
  onToggleFolder,
}: {
  node: TreeNode<FileChangeSummary>;
  selectedFilePath: string | null;
  activeFilePath?: string;
  onSelectFile: (filePath: string) => void;
  depth: number;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  fileChunkCounts: Record<string, number>;
  viewedSet?: Set<string>;
  collapsedFolders: Set<string>;
  onToggleFolder: (fullPath: string) => void;
}): JSX.Element => {
  if (node.isFile && node.data) {
    const isSelected = node.data.filePath === selectedFilePath;
    const isActive = node.data.filePath === activeFilePath && !isSelected;
    const status = getFileStatus(node.data, hunkDecisions, fileDecisions, fileChunkCounts);
    return (
      <button
        data-tree-file={node.data.filePath}
        onClick={() => onSelectFile(node.data!.filePath)}
        className={cn(
          'flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors',
          isSelected
            ? 'bg-blue-500/20 text-blue-300'
            : isActive
              ? 'border-l-2 border-blue-400 text-text'
              : 'text-text-secondary hover:bg-surface-raised hover:text-text'
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <FileStatusIcon status={status} />
        <FileIcon fileName={node.name} className="size-3.5" />
        {viewedSet && viewedSet.has(node.data.filePath) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <Eye className="size-3 shrink-0 text-blue-400" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">Viewed</TooltipContent>
          </Tooltip>
        )}
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            status === 'rejected' && 'text-text-muted line-through'
          )}
        >
          {node.name}
        </span>
        <span className="ml-1 flex shrink-0 items-center gap-1">
          {node.data.linesAdded > 0 && (
            <span className="text-green-400">+{node.data.linesAdded}</span>
          )}
          {node.data.linesRemoved > 0 && (
            <span className="text-red-400">-{node.data.linesRemoved}</span>
          )}
        </span>
      </button>
    );
  }

  const isOpen = !collapsedFolders.has(node.fullPath);
  const FolderIcon = isOpen ? FolderOpen : Folder;

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleFolder(node.fullPath)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-xs text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
      >
        <ChevronRight
          size={12}
          className={cn('shrink-0 transition-transform duration-150', isOpen && 'rotate-90')}
        />
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
      {isOpen &&
        sortTreeNodes(node.children).map((child) => (
          <TreeItem
            key={child.fullPath}
            node={child}
            selectedFilePath={selectedFilePath}
            activeFilePath={activeFilePath}
            onSelectFile={onSelectFile}
            depth={depth + 1}
            hunkDecisions={hunkDecisions}
            fileDecisions={fileDecisions}
            fileChunkCounts={fileChunkCounts}
            viewedSet={viewedSet}
            collapsedFolders={collapsedFolders}
            onToggleFolder={onToggleFolder}
          />
        ))}
    </div>
  );
};

function applyExpandAncestors(prev: Set<string>, ancestors: string[]): Set<string> {
  const collapsedAncestors = ancestors.filter((a) => prev.has(a));
  if (collapsedAncestors.length === 0) return prev;
  const next = new Set(prev);
  for (const a of collapsedAncestors) {
    next.delete(a);
  }
  return next;
}

function getAncestorFolderPaths(tree: TreeNode<FileChangeSummary>[], filePath: string): string[] {
  const paths: string[] = [];

  function walk(nodes: TreeNode<FileChangeSummary>[], ancestors: string[]): boolean {
    for (const node of nodes) {
      if (node.isFile && node.data?.filePath === filePath) {
        paths.push(...ancestors);
        return true;
      }
      if (!node.isFile) {
        if (walk(node.children, [...ancestors, node.fullPath])) return true;
      }
    }
    return false;
  }

  walk(tree, []);
  return paths;
}

export const ReviewFileTree = ({
  files,
  selectedFilePath,
  onSelectFile,
  viewedSet,
  activeFilePath,
}: ReviewFileTreeProps): JSX.Element => {
  const hunkDecisions = useStore((state) => state.hunkDecisions);
  const fileDecisions = useStore((state) => state.fileDecisions);
  const fileChunkCounts = useStore((state) => state.fileChunkCounts);
  const tree = useMemo(() => buildTree(files, (f) => f.relativePath), [files]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());

  const toggleFolder = useCallback((fullPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) {
        next.delete(fullPath);
      } else {
        next.add(fullPath);
      }
      return next;
    });
  }, []);

  // Auto-expand parent folders when a file is selected or becomes active
  useEffect(() => {
    const targetPath = selectedFilePath ?? activeFilePath;
    if (!targetPath) return;

    const ancestors = getAncestorFolderPaths(tree, targetPath);
    if (ancestors.length === 0) return;

    queueMicrotask(() => {
      setCollapsedFolders((prev) => applyExpandAncestors(prev, ancestors));
    });
  }, [selectedFilePath, activeFilePath, tree]);

  // Auto-scroll tree to active file when scroll-spy updates
  useEffect(() => {
    if (!activeFilePath) return;

    const btn = document.querySelector<HTMLElement>(
      `[data-tree-file="${CSS.escape(activeFilePath)}"]`
    );
    if (btn) {
      btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeFilePath]);

  if (files.length === 0) {
    return <div className="p-4 text-center text-xs text-text-muted">No changed files</div>;
  }

  return (
    <div className="py-1">
      {sortTreeNodes(tree).map((node) => (
        <TreeItem
          key={node.fullPath}
          node={node}
          selectedFilePath={selectedFilePath}
          activeFilePath={activeFilePath}
          onSelectFile={onSelectFile}
          depth={0}
          hunkDecisions={hunkDecisions}
          fileDecisions={fileDecisions}
          fileChunkCounts={fileChunkCounts}
          viewedSet={viewedSet}
          collapsedFolders={collapsedFolders}
          onToggleFolder={toggleFolder}
        />
      ))}
    </div>
  );
};

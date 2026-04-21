import { type JSX, useCallback, useEffect, useMemo, useState } from 'react';

import { FileIcon } from '@renderer/components/team/editor/FileIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { getFileHunkCount } from '@renderer/store/slices/changeReviewSlice';
import { buildTree, sortTreeNodes } from '@renderer/utils/fileTreeBuilder';
import { buildHunkDecisionKey, getFileReviewKey } from '@renderer/utils/reviewKey';
import {
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  Eye,
  Folder,
  FolderOpen,
  Search,
  X as XIcon,
} from 'lucide-react';

import type { TreeNode } from '@renderer/utils/fileTreeBuilder';
import type { HunkDecision } from '@shared/types';
import type { FileChangeWithContent } from '@shared/types';
import type { FileChangeSummary } from '@shared/types/review';

interface ReviewFileTreeProps {
  files: FileChangeSummary[];
  fileContents?: Record<string, FileChangeWithContent>;
  pathChangeLabels?: Record<
    string,
    { kind: 'deleted' } | { kind: 'moved' | 'renamed'; direction: 'from' | 'to'; otherPath: string }
  >;
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
  const reviewKey = getFileReviewKey(file);
  const fileDec = fileDecisions[reviewKey] ?? fileDecisions[file.filePath];
  if (fileDec === 'accepted') return 'accepted';
  if (fileDec === 'rejected') return 'rejected';

  const count = getFileHunkCount(file.filePath, file.snippets.length, fileChunkCounts);
  if (count === 0) return 'pending';

  const decisions: HunkDecision[] = [];
  for (let i = 0; i < count; i++) {
    const key = buildHunkDecisionKey(reviewKey, i);
    decisions.push(hunkDecisions[key] ?? hunkDecisions[`${file.filePath}:${i}`] ?? 'pending');
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
  pathChangeLabels,
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
  pathChangeLabels?: ReviewFileTreeProps['pathChangeLabels'];
}): JSX.Element => {
  if (node.isFile && node.data) {
    const isSelected = node.data.filePath === selectedFilePath;
    const isActive = node.data.filePath === activeFilePath && !isSelected;
    const status = getFileStatus(node.data, hunkDecisions, fileDecisions, fileChunkCounts);
    const label = pathChangeLabels?.[node.data.filePath];
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
        {node.data.isNewFile && (
          <span className="shrink-0 rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
            new
          </span>
        )}
        {label?.kind === 'deleted' && (
          <span className="shrink-0 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
            deleted
          </span>
        )}
        {label && label.kind !== 'deleted' && (
          <span className="shrink-0 rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] font-medium text-purple-300">
            {label.kind}
          </span>
        )}
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
            pathChangeLabels={pathChangeLabels}
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
  pathChangeLabels,
  selectedFilePath,
  onSelectFile,
  viewedSet,
  activeFilePath,
}: ReviewFileTreeProps): JSX.Element => {
  const hunkDecisions = useStore((state) => state.hunkDecisions);
  const fileDecisions = useStore((state) => state.fileDecisions);
  const fileChunkCounts = useStore((state) => state.fileChunkCounts);
  const [query, setQuery] = useState('');
  const [filterUnresolved, setFilterUnresolved] = useState(false);
  const [filterRejected, setFilterRejected] = useState(false);
  const [filterNew, setFilterNew] = useState(false);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredFiles = useMemo(() => {
    const hasAnyFilter =
      filterUnresolved || filterRejected || filterNew || normalizedQuery.length > 0;
    if (!hasAnyFilter) return files;

    const matchesQuery = (f: FileChangeSummary): boolean => {
      if (!normalizedQuery) return true;
      const name = f.relativePath.split(/[\\/]/).pop() ?? f.relativePath;
      return (
        f.relativePath.toLowerCase().includes(normalizedQuery) ||
        f.filePath.toLowerCase().includes(normalizedQuery) ||
        name.toLowerCase().includes(normalizedQuery)
      );
    };

    const hasAnyRejected = (f: FileChangeSummary): boolean => {
      const reviewKey = getFileReviewKey(f);
      if (fileDecisions[reviewKey] === 'rejected' || fileDecisions[f.filePath] === 'rejected') {
        return true;
      }
      const count = getFileHunkCount(f.filePath, f.snippets.length, fileChunkCounts);
      for (let i = 0; i < count; i++) {
        if (
          hunkDecisions[buildHunkDecisionKey(reviewKey, i)] === 'rejected' ||
          hunkDecisions[`${f.filePath}:${i}`] === 'rejected'
        ) {
          return true;
        }
      }
      return false;
    };

    return files.filter((f) => {
      if (!matchesQuery(f)) return false;

      if (filterNew && !f.isNewFile) return false;

      if (filterUnresolved) {
        const status = getFileStatus(f, hunkDecisions, fileDecisions, fileChunkCounts);
        if (!(status === 'pending' || status === 'mixed')) return false;
      }

      if (filterRejected && !hasAnyRejected(f)) return false;

      return true;
    });
  }, [
    files,
    normalizedQuery,
    filterUnresolved,
    filterRejected,
    filterNew,
    hunkDecisions,
    fileDecisions,
    fileChunkCounts,
  ]);

  const tree = useMemo(() => buildTree(filteredFiles, (f) => f.relativePath), [filteredFiles]);
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
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            className="h-8 w-full rounded border border-border bg-surface px-7 text-xs text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setFilterUnresolved((v) => !v)}
            className={cn(
              'rounded px-2 py-1 text-[11px] font-medium transition-colors',
              filterUnresolved
                ? 'bg-blue-500/20 text-blue-300'
                : 'bg-surface-raised text-text-muted hover:text-text'
            )}
          >
            Unresolved
          </button>
          <button
            type="button"
            onClick={() => setFilterRejected((v) => !v)}
            className={cn(
              'rounded px-2 py-1 text-[11px] font-medium transition-colors',
              filterRejected
                ? 'bg-red-500/20 text-red-300'
                : 'bg-surface-raised text-text-muted hover:text-text'
            )}
          >
            Rejected
          </button>
          <button
            type="button"
            onClick={() => setFilterNew((v) => !v)}
            className={cn(
              'rounded px-2 py-1 text-[11px] font-medium transition-colors',
              filterNew
                ? 'bg-green-500/20 text-green-300'
                : 'bg-surface-raised text-text-muted hover:text-text'
            )}
          >
            New
          </button>
          {(filterUnresolved || filterRejected || filterNew || normalizedQuery.length > 0) && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setFilterUnresolved(false);
                setFilterRejected(false);
                setFilterNew(false);
              }}
              className="ml-auto rounded px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {filteredFiles.length === 0 ? (
        <div className="flex-1 p-4 text-center text-xs text-text-muted">No matching files</div>
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
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
              pathChangeLabels={pathChangeLabels}
            />
          ))}
        </div>
      )}
    </div>
  );
};

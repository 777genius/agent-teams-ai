/**
 * Generic file tree component with render-props for customization.
 *
 * Used by EditorFileTree (FileTreeEntry) and ReviewFileTree (FileChangeSummary).
 * ARIA: role="tree", role="treeitem", aria-expanded, role="group".
 */

import React, { useCallback } from 'react';

import { ChevronDown, ChevronRight } from 'lucide-react';

import type { TreeNode } from '@renderer/utils/fileTreeBuilder';

// =============================================================================
// Types
// =============================================================================

interface FileTreeProps<T> {
  nodes: TreeNode<T>[];
  activeNodePath: string | null;
  onNodeClick: (node: TreeNode<T>) => void;
  expandedPaths: Record<string, boolean>;
  onToggleExpand: (fullPath: string) => void;
  renderLeafNode?: (node: TreeNode<T>, isSelected: boolean, depth: number) => React.ReactNode;
  renderFolderLabel?: (node: TreeNode<T>, isOpen: boolean, depth: number) => React.ReactNode;
  renderNodeIcon?: (node: TreeNode<T>) => React.ReactNode;
  /** Optional data attributes placed on each <li> for event delegation (e.g. context menu) */
  getNodeDataAttrs?: (node: TreeNode<T>) => Record<string, string>;
  maxDepth?: number;
}

const MAX_VISUAL_DEPTH = 12;
const INDENT_PX = 12;

// =============================================================================
// Component
// =============================================================================

export const FileTree = <T,>(props: Readonly<FileTreeProps<T>>): React.ReactElement => {
  const { nodes, maxDepth = MAX_VISUAL_DEPTH } = props;

  return (
    <ul role="tree" className="select-none text-sm">
      {nodes.map((node) => (
        <TreeItem key={node.fullPath} node={node} depth={0} maxDepth={maxDepth} {...props} />
      ))}
    </ul>
  );
};

// =============================================================================
// TreeItem (recursive)
// =============================================================================

interface TreeItemProps<T> extends FileTreeProps<T> {
  node: TreeNode<T>;
  depth: number;
}

const TreeItemInner = <T,>({
  node,
  depth,
  activeNodePath,
  onNodeClick,
  expandedPaths,
  onToggleExpand,
  renderLeafNode,
  renderFolderLabel,
  renderNodeIcon,
  getNodeDataAttrs,
  maxDepth = MAX_VISUAL_DEPTH,
  nodes: _nodes,
  ...rest
}: Readonly<TreeItemProps<T>>): React.ReactElement => {
  const visualDepth = Math.min(depth, maxDepth);
  const isSelected = activeNodePath === node.fullPath;
  const dataAttrs = getNodeDataAttrs?.(node);

  const handleClick = useCallback(() => {
    if (node.isFile) {
      onNodeClick(node);
    } else {
      onToggleExpand(node.fullPath);
    }
  }, [node, onNodeClick, onToggleExpand]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    },
    [handleClick]
  );

  // Leaf node (file)
  if (node.isFile) {
    if (renderLeafNode) {
      return (
        // eslint-disable-next-line react/jsx-props-no-spreading -- data attributes from getNodeDataAttrs require spreading
        <li role="treeitem" aria-selected={isSelected} {...dataAttrs}>
          {renderLeafNode(node, isSelected, visualDepth)}
        </li>
      );
    }

    return (
      <li
        role="treeitem"
        aria-selected={isSelected}
        className={`flex cursor-pointer items-center gap-1 truncate px-2 py-0.5 hover:bg-surface-raised ${
          isSelected ? 'bg-surface-raised text-text' : 'text-text-secondary'
        }`}
        style={{ paddingLeft: `${visualDepth * INDENT_PX + 8}px` }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        title={node.fullPath}
        // eslint-disable-next-line react/jsx-props-no-spreading -- data attributes from getNodeDataAttrs require spreading
        {...dataAttrs}
      >
        {renderNodeIcon?.(node)}
        <span className="truncate">{node.name}</span>
      </li>
    );
  }

  // Folder node
  const isExpanded = expandedPaths[node.fullPath] === true;

  return (
    // eslint-disable-next-line react/jsx-props-no-spreading -- data attributes from getNodeDataAttrs require spreading
    <li role="treeitem" aria-expanded={isExpanded} aria-selected={isSelected} {...dataAttrs}>
      {renderFolderLabel ? (
        renderFolderLabel(node, isExpanded, visualDepth)
      ) : (
        <div
          className="flex cursor-pointer items-center gap-1 truncate px-2 py-0.5 text-text-secondary hover:bg-surface-raised"
          style={{ paddingLeft: `${visualDepth * INDENT_PX + 8}px` }}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          role="button"
          tabIndex={0}
          title={depth >= maxDepth ? node.fullPath : undefined}
        >
          {isExpanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-text-muted" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-text-muted" />
          )}
          {renderNodeIcon?.(node)}
          <span className="truncate">{node.name}</span>
        </div>
      )}
      {isExpanded && node.children.length > 0 && (
        <ul role="group">
          {node.children.map((child) => (
            <TreeItemInner
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              activeNodePath={activeNodePath}
              onNodeClick={onNodeClick}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
              renderLeafNode={renderLeafNode}
              renderFolderLabel={renderFolderLabel}
              renderNodeIcon={renderNodeIcon}
              getNodeDataAttrs={getNodeDataAttrs}
              maxDepth={maxDepth}
              nodes={[]}
              {...rest}
            />
          ))}
        </ul>
      )}
    </li>
  );
};

const TreeItem = React.memo(TreeItemInner) as typeof TreeItemInner;

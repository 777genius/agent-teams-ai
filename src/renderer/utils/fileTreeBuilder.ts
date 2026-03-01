/**
 * Generic tree builder — converts a flat list of items with paths
 * into a hierarchical tree structure with single-child directory collapsing.
 *
 * Used by ReviewFileTree (FileChangeSummary) and EditorFileTree (FileTreeEntry).
 */

export interface TreeNode<T> {
  name: string;
  fullPath: string;
  isFile: boolean;
  data?: T;
  children: TreeNode<T>[];
}

/**
 * Build a hierarchical tree from a flat list of items.
 *
 * @param items - Flat list of items (files/entries)
 * @param getPath - Extract relative path from item (using '/' separator)
 * @param options.collapse - Merge single-child intermediate directories (default: true)
 */
export function buildTree<T>(
  items: T[],
  getPath: (item: T) => string,
  options?: { collapse?: boolean }
): TreeNode<T>[] {
  const root: TreeNode<T> = { name: '', fullPath: '', isFile: false, children: [] };

  for (const item of items) {
    const parts = getPath(item).split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const fullPath = parts.slice(0, i + 1).join('/');

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          fullPath,
          isFile: isLast,
          data: isLast ? item : undefined,
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    }
  }

  if (options?.collapse === false) {
    return root.children;
  }

  // Collapse children individually — root itself has empty name and must not participate
  return root.children.map(collapseTree);
}

/** Merge single-child intermediate directories: a/ → b/ → c becomes a/b/c */
function collapseTree<T>(node: TreeNode<T>): TreeNode<T> {
  const collapsed: TreeNode<T> = { ...node, children: node.children.map(collapseTree) };
  if (!collapsed.isFile && collapsed.children.length === 1 && !collapsed.children[0].isFile) {
    const child = collapsed.children[0];
    return {
      ...child,
      name: `${collapsed.name}/${child.name}`,
      children: child.children,
    };
  }
  return collapsed;
}

/** Sort tree nodes: directories first, then alphabetical */
export function sortTreeNodes<T>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  return [...nodes].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

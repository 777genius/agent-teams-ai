import { describe, expect, it } from 'vitest';

import { buildTree, sortTreeNodes } from '@renderer/utils/fileTreeBuilder';

import type { TreeNode } from '@renderer/utils/fileTreeBuilder';

interface TestItem {
  path: string;
  size: number;
}

const getPath = (item: TestItem) => item.path;

describe('buildTree', () => {
  it('builds a flat list of files into a tree', () => {
    const items: TestItem[] = [
      { path: 'src/main.ts', size: 100 },
      { path: 'src/utils.ts', size: 50 },
      { path: 'README.md', size: 30 },
    ];

    const tree = buildTree(items, getPath);

    expect(tree).toHaveLength(2);

    const src = tree.find((n) => n.name === 'src');
    expect(src).toBeDefined();
    expect(src!.isFile).toBe(false);
    expect(src!.children).toHaveLength(2);

    const readme = tree.find((n) => n.name === 'README.md');
    expect(readme).toBeDefined();
    expect(readme!.isFile).toBe(true);
    expect(readme!.data).toEqual({ path: 'README.md', size: 30 });
  });

  it('collapses single-child intermediate directories by default', () => {
    const items: TestItem[] = [{ path: 'a/b/c/file.ts', size: 10 }];

    const tree = buildTree(items, getPath);

    // a/b/c collapsed into one node
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('a/b/c');
    expect(tree[0].isFile).toBe(false);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].name).toBe('file.ts');
    expect(tree[0].children[0].isFile).toBe(true);
  });

  it('does not collapse when collapse=false', () => {
    const items: TestItem[] = [{ path: 'a/b/file.ts', size: 10 }];

    const tree = buildTree(items, getPath, { collapse: false });

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('a');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].name).toBe('b');
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].name).toBe('file.ts');
  });

  it('does not collapse directories with multiple children', () => {
    const items: TestItem[] = [
      { path: 'src/a/file1.ts', size: 10 },
      { path: 'src/b/file2.ts', size: 20 },
    ];

    const tree = buildTree(items, getPath);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('src');
    expect(tree[0].children).toHaveLength(2);
    // Each child is collapsed: a/ → file1.ts, b/ → file2.ts
    expect(tree[0].children.map((c) => c.name).sort()).toEqual(['a', 'b']);
  });

  it('preserves data only on leaf nodes', () => {
    const items: TestItem[] = [
      { path: 'src/index.ts', size: 100 },
      { path: 'src/utils/helper.ts', size: 50 },
    ];

    const tree = buildTree(items, getPath);
    const src = tree[0];

    expect(src.data).toBeUndefined();
    const indexFile = src.children.find((c) => c.name === 'index.ts');
    expect(indexFile!.data).toEqual({ path: 'src/index.ts', size: 100 });
  });

  it('handles empty input', () => {
    const tree = buildTree([], getPath);
    expect(tree).toEqual([]);
  });

  it('handles single file at root level', () => {
    const items: TestItem[] = [{ path: 'file.ts', size: 10 }];
    const tree = buildTree(items, getPath);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('file.ts');
    expect(tree[0].isFile).toBe(true);
    expect(tree[0].children).toHaveLength(0);
  });

  it('handles deeply nested paths', () => {
    const items: TestItem[] = [{ path: 'a/b/c/d/e/f.ts', size: 1 }];
    const tree = buildTree(items, getPath);

    // Collapsed: a/b/c/d/e → f.ts
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('a/b/c/d/e');
    expect(tree[0].children[0].name).toBe('f.ts');
  });

  it('sets correct fullPath for all nodes', () => {
    const items: TestItem[] = [
      { path: 'src/components/Button.tsx', size: 100 },
      { path: 'src/components/Input.tsx', size: 80 },
    ];

    const tree = buildTree(items, getPath, { collapse: false });

    const src = tree[0];
    expect(src.fullPath).toBe('src');
    const components = src.children[0];
    expect(components.fullPath).toBe('src/components');
    const button = components.children.find((c) => c.name === 'Button.tsx');
    expect(button!.fullPath).toBe('src/components/Button.tsx');
  });
});

describe('sortTreeNodes', () => {
  it('sorts directories before files', () => {
    const nodes: TreeNode<TestItem>[] = [
      { name: 'beta.ts', fullPath: 'beta.ts', isFile: true, children: [] },
      { name: 'src', fullPath: 'src', isFile: false, children: [] },
      { name: 'alpha.ts', fullPath: 'alpha.ts', isFile: true, children: [] },
      { name: 'lib', fullPath: 'lib', isFile: false, children: [] },
    ];

    const sorted = sortTreeNodes(nodes);
    const dirs = sorted.filter((n) => !n.isFile);
    const files = sorted.filter((n) => n.isFile);

    // Directories come first
    expect(dirs.map((n) => n.name)).toEqual(['lib', 'src']);
    // Files come after
    expect(files.map((n) => n.name)).toEqual(['alpha.ts', 'beta.ts']);
    // Combined order
    expect(sorted.slice(0, 2).every((n) => !n.isFile)).toBe(true);
    expect(sorted.slice(2).every((n) => n.isFile)).toBe(true);
  });

  it('sorts alphabetically within same type', () => {
    const nodes: TreeNode<TestItem>[] = [
      { name: 'zebra.ts', fullPath: 'zebra.ts', isFile: true, children: [] },
      { name: 'alpha.ts', fullPath: 'alpha.ts', isFile: true, children: [] },
      { name: 'mid.ts', fullPath: 'mid.ts', isFile: true, children: [] },
    ];

    const sorted = sortTreeNodes(nodes);

    expect(sorted.map((n) => n.name)).toEqual(['alpha.ts', 'mid.ts', 'zebra.ts']);
  });

  it('does not mutate the original array', () => {
    const nodes: TreeNode<TestItem>[] = [
      { name: 'b.ts', fullPath: 'b.ts', isFile: true, children: [] },
      { name: 'a.ts', fullPath: 'a.ts', isFile: true, children: [] },
    ];

    const sorted = sortTreeNodes(nodes);

    expect(sorted).not.toBe(nodes);
    expect(nodes[0].name).toBe('b.ts');
  });

  it('handles empty array', () => {
    expect(sortTreeNodes([])).toEqual([]);
  });
});

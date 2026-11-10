/**
 * Type definitions for DirectoryTree components.
 */

export interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  tokens?: number;
  firstSeenInGroup?: string;
  children: Map<string, TreeNode>;
}

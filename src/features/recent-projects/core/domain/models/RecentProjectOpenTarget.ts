export type RecentProjectOpenTarget =
  | { type: 'existing-worktree'; repositoryId: string; worktreeId: string }
  | { type: 'synthetic-path'; path: string };

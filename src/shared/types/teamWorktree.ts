export type TeamWorktreeGitBlockReason =
  | 'invalid_project_path'
  | 'not_git_repo'
  | 'missing_head'
  | 'git_unavailable'
  | 'git_error';

export interface TeamWorktreeGitStatus {
  projectPath: string;
  isGitRepo: boolean;
  hasHead: boolean;
  canUseWorktrees: boolean;
  rootPath?: string;
  branch?: string;
  reason?: TeamWorktreeGitBlockReason;
  message?: string;
}

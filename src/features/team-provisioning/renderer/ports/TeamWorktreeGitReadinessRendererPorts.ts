import type { TeamWorktreeGitStatus } from '@shared/types';

export interface TeamWorktreeGitReadinessRendererPorts {
  getStatus(projectPath: string): Promise<TeamWorktreeGitStatus>;
  initialize(projectPath: string): Promise<TeamWorktreeGitStatus>;
  createInitialCommit(projectPath: string): Promise<TeamWorktreeGitStatus>;
}

export type DashboardProviderId = 'anthropic' | 'codex' | 'gemini';

export type DashboardRecentProjectSource = 'claude' | 'codex' | 'mixed';

export type DashboardRecentProjectOpenTarget =
  | { type: 'existing-worktree'; repositoryId: string; worktreeId: string }
  | { type: 'synthetic-path'; path: string };

export interface DashboardRecentProject {
  id: string;
  name: string;
  primaryPath: string;
  associatedPaths: string[];
  mostRecentActivity: number;
  providerIds: DashboardProviderId[];
  source: DashboardRecentProjectSource;
  openTarget: DashboardRecentProjectOpenTarget;
  primaryBranch?: string;
}

export interface DashboardRecentProjectsPayload {
  projects: DashboardRecentProject[];
  degraded: boolean;
}

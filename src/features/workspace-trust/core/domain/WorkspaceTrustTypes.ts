export type WorkspaceTrustProvider = 'claude' | 'anthropic' | 'codex' | 'gemini' | 'opencode';

export type WorkspaceTrustWorkspaceSource =
  | 'team-root'
  | 'member-worktree'
  | 'member-cwd'
  | 'git-root';

export type WorkspaceTrustNonPersistableReason =
  | 'home_directory'
  | 'filesystem_root'
  | 'unavailable';

export interface WorkspaceTrustWorkspace {
  id: string;
  displayCwd: string;
  cwd: string;
  realCwd: string;
  configKeyCwd: string;
  gitRootConfigKey?: string;
  comparisonKey: string;
  source: WorkspaceTrustWorkspaceSource;
  memberId?: string;
  persistable: boolean;
  nonPersistableReason?: WorkspaceTrustNonPersistableReason;
}

export interface WorkspaceTrustFeatureFlags {
  enabled: boolean;
  claudePty: boolean;
  codexArgs: boolean;
  retry: boolean;
  fileLock: boolean;
}

export type WorkspaceTrustLaunchArgTargetSurface =
  | 'primary_provider_args'
  | 'cross_provider_member_args'
  | 'provider_facts_probe'
  | 'default_model_probe';

export type WorkspaceTrustLaunchArgDialect =
  | 'codex-native-config-override'
  | 'claude-codex-runtime-settings'
  | 'codex-direct-cli-config';

export interface WorkspaceTrustLaunchArgPatch {
  id: string;
  owner: 'workspace-trust';
  targetProvider: WorkspaceTrustProvider;
  targetSurface: WorkspaceTrustLaunchArgTargetSurface;
  dialect: WorkspaceTrustLaunchArgDialect;
  args: string[];
  dedupeKey: string;
  sourceWorkspaceIds: string[];
  reason: string;
}

export type WorkspaceTrustExecutionStatus = 'ok' | 'soft_failed' | 'blocked' | 'cancelled';

export interface WorkspaceTrustDiagnosticStrategyResult {
  id: string;
  provider: WorkspaceTrustProvider;
  status: WorkspaceTrustExecutionStatus | 'skipped';
  workspaceIds: string[];
  matchedRuleIds?: string[];
  actions?: string[];
  evidence?: string[];
  elapsedMs?: number;
  errorCode?: string;
  errorMessage?: string;
  rawTail?: string;
}

export interface WorkspaceTrustDiagnosticsManifest {
  attempt: number;
  featureFlags: WorkspaceTrustFeatureFlags;
  strategyResults: WorkspaceTrustDiagnosticStrategyResult[];
  omittedCounts?: Record<string, number>;
}

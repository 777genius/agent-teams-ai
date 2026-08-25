export type TeamProviderId = 'anthropic' | 'codex' | 'gemini' | 'opencode';
export type TeamProviderBackendId =
  | 'auto'
  | 'adapter'
  | 'api'
  | 'cli-sdk'
  | 'codex-native'
  | 'opencode-cli';
export type TeamEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type TeamFastMode = 'inherit' | 'on' | 'off';
export type TeamProvisioningModelVerificationMode = 'compatibility' | 'deep';

export interface TeamProvisioningMemberInput {
  name: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  cwd?: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: TeamEffort;
  fastMode?: TeamFastMode;
}

export interface TeamLaunchRequest {
  teamName: string;
  cwd: string;
  prompt?: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: TeamEffort;
  fastMode?: TeamFastMode;
  limitContext?: boolean;
  clearContext?: boolean;
  skipPermissions?: boolean;
  worktree?: string;
  extraCliArgs?: string;
  allowExperimentalLocalModels?: boolean;
}

export interface TeamCreateRequest extends TeamLaunchRequest {
  displayName?: string;
  description?: string;
  color?: string;
  members: TeamProvisioningMemberInput[];
}

export interface TeamLaunchResponse {
  runId: string;
  launchStatus?: 'started' | 'already_launching' | 'already_running';
  alreadyLaunching?: boolean;
  alreadyRunning?: boolean;
}

export type TeamCreateResponse = TeamLaunchResponse;

export interface TeamProvisioningModelCheckRequest {
  providerId: TeamProviderId;
  model: string;
  effort?: TeamEffort;
}

export interface TeamProvisioningPrepareIssue {
  providerId?: TeamProviderId;
  modelId?: string;
  scope: 'provider' | 'model';
  severity: 'blocking' | 'warning';
  code: string;
  message: string;
  experimentalOverrideAvailable?: boolean;
}

export interface TeamProvisioningSupportDiagnostic {
  id: string;
  providerId: TeamProviderId;
  kind: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  summary: string;
  copyText: string;
  createdAt: string;
}

export interface TeamProvisioningPrepareResult {
  ready: boolean;
  message: string;
  details?: string[];
  warnings?: string[];
  issues?: TeamProvisioningPrepareIssue[];
  supportDiagnostics?: TeamProvisioningSupportDiagnostic[];
}

export interface TeamLaunchDiagnosticItem {
  id: string;
  memberName?: string;
  severity: 'info' | 'warning' | 'error';
  code:
    | 'spawn_accepted'
    | 'runtime_process_detected'
    | 'runtime_process_candidate'
    | 'tmux_shell_only'
    | 'runtime_not_found'
    | 'permission_pending'
    | 'bootstrap_confirmed'
    | 'bootstrap_stalled'
    | 'workspace_trust_preflight'
    | 'stale_runtime_event_rejected'
    | 'process_table_unavailable';
  label: string;
  detail?: string;
  observedAt: string;
}

export interface TeamProvisioningProgress {
  runId: string;
  teamName: string;
  state:
    | 'validating'
    | 'spawning'
    | 'configuring'
    | 'assembling'
    | 'finalizing'
    | 'verifying'
    | 'ready'
    | 'disconnected'
    | 'failed'
    | 'cancelled';
  message: string;
  messageSeverity?: 'error' | 'warning';
  startedAt: string;
  updatedAt: string;
  pid?: number;
  error?: string;
  warnings?: string[];
  cliLogsTail?: string;
  assistantOutput?: string;
  configReady?: boolean;
  launchDiagnostics?: TeamLaunchDiagnosticItem[];
}

export interface TeamLaunchFailureDiagnosticsFile {
  label: string;
  path: string;
  content?: string;
  issue?: string;
}

export interface TeamLaunchFailureDiagnosticsBundle {
  teamName: string;
  runId?: string;
  latestPath: string;
  artifactDirectory?: string;
  manifestPath?: string;
  classification?: {
    code?: string;
    confidence?: number;
    evidence?: string[];
  } | null;
  bootstrapTransportBreadcrumb?: {
    lastTransportStage?: string | null;
    submitRejected?: boolean;
    retryable?: boolean | null;
    noStdinWarning?: boolean;
    bootstrapSubmitted?: boolean;
    evidence?: string[];
  } | null;
  files: TeamLaunchFailureDiagnosticsFile[];
}

export interface ProviderModelLaunchIdentity {
  providerId: TeamProviderId;
  providerBackendId: TeamProviderBackendId | null;
  selectedModel: string | null;
  selectedEffort: TeamEffort | null;
  selectedFastMode?: TeamFastMode | null;
}

export interface ValidatedTeamLaunchInput {
  payload: Partial<TeamLaunchRequest>;
  teamName: string;
  cwd: string;
  explicitProviderId: TeamProviderId | undefined;
  defaultProviderId: TeamProviderId;
  explicitProviderBackendId: string | undefined;
}

export type TeamLaunchMode = 'draft' | 'existing';

export interface ValidatedProvisioningPrepareInput {
  cwd: string | undefined;
  providerId: TeamProviderId | undefined;
  providerIds: TeamProviderId[] | undefined;
  selectedModels: string[] | undefined;
  limitContext: boolean | undefined;
  modelVerificationMode: TeamProvisioningModelVerificationMode | undefined;
  selectedModelChecks: TeamProvisioningModelCheckRequest[] | undefined;
}

export type InputValidation<T> = { valid: true; value: T } | { valid: false; error: string };

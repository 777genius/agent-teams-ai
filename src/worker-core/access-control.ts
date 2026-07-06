import { isAbsolute, resolve, sep } from "node:path";

export enum AccessBoundary {
  ReadOnly = "read_only",
  IsolatedWorkspaceWrite = "isolated_workspace_write",
  ProjectScopedControl = "project_scoped_control",
  DangerFullAccess = "danger_full_access",
}

export function isAccessBoundary(value: unknown): value is AccessBoundary {
  return typeof value === "string" &&
    (Object.values(AccessBoundary) as readonly string[]).includes(value);
}

export function parseAccessBoundary(
  value: unknown,
  fieldName = "accessBoundary",
): AccessBoundary {
  if (isAccessBoundary(value)) return value;
  throw new Error(`${fieldName}_invalid`);
}

export enum ProjectOperation {
  ReadPath = "read_path",
  WritePath = "write_path",
  CreateJob = "create_job",
  StartWorker = "start_worker",
  StopWorker = "stop_worker",
  CreateWorktree = "create_worktree",
  WriteReviewMarker = "write_review_marker",
  IntegrateCommit = "integrate_commit",
  PushBranch = "push_branch",
  UseAccount = "use_account",
  UseTool = "use_tool",
}

export enum ProjectToolCapability {
  ReadOnlyDiagnostics = "read_only_diagnostics",
  RawShell = "raw_shell",
  WorkspaceEdit = "workspace_edit",
  ProjectControlBroker = "project_control_broker",
  AccountSession = "account_session",
  Network = "network",
}

export enum AccessDecisionReason {
  Allowed = "allowed",
  DangerFullAccess = "danger_full_access",
  BoundaryReadOnly = "boundary_read_only",
  BoundaryInsufficient = "boundary_insufficient",
  MissingProjectScope = "missing_project_scope",
  InvalidPath = "invalid_path",
  PathOutsideScope = "path_outside_scope",
  RegistryRawWriteDenied = "registry_raw_write_denied",
  AuthPathDenied = "auth_path_denied",
  GitInternalPathDenied = "git_internal_path_denied",
  DockerSocketDenied = "docker_socket_denied",
  JobPrefixDenied = "job_prefix_denied",
  TmuxPrefixDenied = "tmux_prefix_denied",
  BranchDenied = "branch_denied",
  RemoteDenied = "remote_denied",
  ForcePushDenied = "force_push_denied",
  AccountDenied = "account_denied",
  ToolDenied = "tool_denied",
  CannotEnforceAccessBoundary = "cannot_enforce_access_boundary",
}

export enum LaunchPlanStatus {
  Ready = "ready",
  Blocked = "blocked",
}

export enum FilesystemPolicyMode {
  ReadOnly = "read_only",
  IsolatedWorkspaceWrite = "isolated_workspace_write",
  ProjectScopedWrite = "project_scoped_write",
  Unrestricted = "unrestricted",
}

export enum NetworkAccessMode {
  Disabled = "disabled",
  Restricted = "restricted",
  Unrestricted = "unrestricted",
}

export function isNetworkAccessMode(value: unknown): value is NetworkAccessMode {
  return typeof value === "string" &&
    (Object.values(NetworkAccessMode) as readonly string[]).includes(value);
}

export function parseNetworkAccessMode(
  value: unknown,
  fieldName = "networkAccess",
): NetworkAccessMode {
  if (isNetworkAccessMode(value)) return value;
  throw new Error(`${fieldName}_invalid`);
}

export enum RawShellAccessMode {
  Disabled = "disabled",
  Sandboxed = "sandboxed",
  Unrestricted = "unrestricted",
}

export type ProjectAccessScope = {
  readonly projectId: string;
  readonly projectSlug?: string;
  readonly readRoots?: readonly string[];
  readonly observedWorkspaceRoots?: readonly string[];
  readonly consumedOutputLedgerRoots?: readonly string[];
  readonly isolatedWorkspaceRoot?: string;
  readonly workspaceRoots?: readonly string[];
  readonly worktreeRoots?: readonly string[];
  readonly registryRoot?: string;
  readonly authRoot?: string;
  readonly deniedRoots?: readonly string[];
  readonly jobIdPrefixes?: readonly string[];
  readonly tmuxSessionPrefixes?: readonly string[];
  readonly allowedBranches?: readonly string[];
  readonly allowedGitRemotes?: readonly string[];
  readonly allowedAccountIds?: readonly string[];
  readonly allowForcePush?: boolean;
};

export type AccessPolicyContext = {
  readonly boundary: AccessBoundary;
  readonly scope?: ProjectAccessScope;
};

export type ProjectPathAccessRequest = {
  readonly path: string;
  readonly realPath?: string;
};

export type ProjectJobAccessRequest = {
  readonly jobId: string;
  readonly registryRoot?: string;
  readonly workspacePath?: string;
  readonly realWorkspacePath?: string;
  readonly tmuxSession?: string;
};

export type ProjectWorktreeAccessRequest = {
  readonly path: string;
  readonly sourceWorkspacePath?: string;
  readonly realSourceWorkspacePath?: string;
  readonly baseBranch?: string;
  readonly sourceRef?: string;
  readonly newBranch?: string;
};

export type ProjectGitAccessRequest = {
  readonly workspacePath?: string;
  readonly realWorkspacePath?: string;
  readonly branch: string;
  readonly remote?: string;
  readonly force?: boolean;
  readonly commitSha?: string;
};

export type ProjectAccountAccessRequest = {
  readonly accountId: string;
};

export type ProjectToolAccessRequest = {
  readonly tool: ProjectToolCapability;
};

export type ProjectOperationRequest =
  | ({ readonly operation: ProjectOperation.ReadPath } & ProjectPathAccessRequest)
  | ({ readonly operation: ProjectOperation.WritePath } & ProjectPathAccessRequest)
  | ({ readonly operation: ProjectOperation.CreateJob } & ProjectJobAccessRequest)
  | ({ readonly operation: ProjectOperation.StartWorker } & ProjectJobAccessRequest)
  | ({ readonly operation: ProjectOperation.StopWorker } & ProjectJobAccessRequest)
  | ({
      readonly operation: ProjectOperation.CreateWorktree;
    } & ProjectWorktreeAccessRequest)
  | ({
      readonly operation: ProjectOperation.WriteReviewMarker;
    } & ProjectJobAccessRequest)
  | ({
      readonly operation: ProjectOperation.IntegrateCommit;
    } & ProjectGitAccessRequest)
  | ({ readonly operation: ProjectOperation.PushBranch } & ProjectGitAccessRequest)
  | ({ readonly operation: ProjectOperation.UseAccount } & ProjectAccountAccessRequest)
  | ({ readonly operation: ProjectOperation.UseTool } & ProjectToolAccessRequest);

export type PolicyDecision = {
  readonly allowed: boolean;
  readonly boundary: AccessBoundary;
  readonly operation: ProjectOperation;
  readonly reason: AccessDecisionReason;
  readonly projectId?: string;
  readonly evidence: readonly string[];
};

export type FilesystemPolicy = {
  readonly mode: FilesystemPolicyMode;
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly deniedRoots: readonly string[];
};

export type ToolManifest = {
  readonly rawShell: RawShellAccessMode;
  readonly capabilities: readonly ProjectToolCapability[];
};

export type EnvironmentPolicy = {
  readonly isolateHome: boolean;
  readonly isolateTemp: boolean;
  readonly exposeAuthRoot: boolean;
};

export type CommandPolicy = {
  readonly validateCommands: boolean;
  readonly deniedExecutableNames: readonly string[];
  readonly deniedGitSubcommands: readonly string[];
  readonly deniedPathPrefixes: readonly string[];
  readonly deniedInlineCodeExecutables: readonly string[];
  readonly deniedScriptExecutables: readonly string[];
};

export enum CommandValidationDecisionReason {
  Allowed = "allowed",
  ValidationDisabled = "validation_disabled",
  EmptyCommand = "empty_command",
  DeniedExecutable = "denied_executable",
  DeniedGitSubcommand = "denied_git_subcommand",
  DeniedPathPrefix = "denied_path_prefix",
  InlineCodeDenied = "inline_code_denied",
  ScriptInterpreterDenied = "script_interpreter_denied",
}

export type CommandValidationDecision = {
  readonly allowed: boolean;
  readonly reason: CommandValidationDecisionReason;
  readonly executableName?: string;
  readonly evidence: readonly string[];
};

export type BrokerTokenScope = {
  readonly projectId: string;
  readonly boundary: AccessBoundary.ProjectScopedControl;
  readonly jobIdPrefixes: readonly string[];
  readonly registryRoot?: string;
};

export type LaunchAdapterCapabilities = {
  readonly canEnforceFilesystemPolicy: boolean;
  readonly canIsolateHome: boolean;
  readonly canIsolateTemp: boolean;
  readonly canDisableRawShell: boolean;
  readonly canBrokerProjectControl: boolean;
  readonly canRestrictNetwork: boolean;
};

export type LaunchPlanInput = AccessPolicyContext & {
  readonly adapter: LaunchAdapterCapabilities;
  readonly allowDangerFullAccess?: boolean;
  readonly networkAccess?: NetworkAccessMode.Disabled | NetworkAccessMode.Restricted;
};

export type LaunchPlan =
  | {
      readonly status: LaunchPlanStatus.Ready;
      readonly boundary: AccessBoundary;
      readonly projectId?: string;
      readonly filesystemPolicy: FilesystemPolicy;
      readonly toolManifest: ToolManifest;
      readonly environmentPolicy: EnvironmentPolicy;
      readonly networkPolicy: { readonly mode: NetworkAccessMode };
      readonly commandPolicy: CommandPolicy;
      readonly brokerTokenScope?: BrokerTokenScope;
    }
  | {
      readonly status: LaunchPlanStatus.Blocked;
      readonly boundary: AccessBoundary;
      readonly reason: AccessDecisionReason;
      readonly evidence: readonly string[];
    };

export interface AccessPolicyService {
  decide(request: ProjectOperationRequest): PolicyDecision;
  canReadPath(request: ProjectPathAccessRequest): PolicyDecision;
  canWritePath(request: ProjectPathAccessRequest): PolicyDecision;
  canCreateJob(request: ProjectJobAccessRequest): PolicyDecision;
  canStartWorker(request: ProjectJobAccessRequest): PolicyDecision;
  canStopWorker(request: ProjectJobAccessRequest): PolicyDecision;
  canCreateWorktree(request: ProjectWorktreeAccessRequest): PolicyDecision;
  canWriteReviewMarker(request: ProjectJobAccessRequest): PolicyDecision;
  canIntegrateCommit(request: ProjectGitAccessRequest): PolicyDecision;
  canPushBranch(request: ProjectGitAccessRequest): PolicyDecision;
  canUseAccount(request: ProjectAccountAccessRequest): PolicyDecision;
  canUseTool(request: ProjectToolAccessRequest): PolicyDecision;
}

export function createAccessPolicyService(
  context: AccessPolicyContext,
): AccessPolicyService {
  return new DefaultAccessPolicyService(context);
}

export function buildLaunchPlan(input: LaunchPlanInput): LaunchPlan {
  const scope = input.scope;
  if (input.boundary !== AccessBoundary.DangerFullAccess && !scope) {
    return blockedLaunch(input, AccessDecisionReason.MissingProjectScope, [
      "project scope is required for non-danger access boundaries",
    ]);
  }
  if (
    input.boundary === AccessBoundary.DangerFullAccess &&
    input.allowDangerFullAccess !== true
  ) {
    return blockedLaunch(input, AccessDecisionReason.CannotEnforceAccessBoundary, [
      "danger_full_access must be explicitly acknowledged",
    ]);
  }
  const enforcementBlocker = launchEnforcementBlocker(input);
  if (enforcementBlocker) return enforcementBlocker;

  const filesystemPolicy = filesystemPolicyFor(input.boundary, scope);
  const toolManifest = toolManifestFor(input.boundary);
  const networkMode = input.boundary === AccessBoundary.DangerFullAccess
    ? NetworkAccessMode.Unrestricted
    : input.networkAccess ?? NetworkAccessMode.Disabled;
  return {
    status: LaunchPlanStatus.Ready,
    boundary: input.boundary,
    ...(scope ? { projectId: scope.projectId } : {}),
    filesystemPolicy,
    toolManifest,
    environmentPolicy: {
      isolateHome: input.boundary !== AccessBoundary.DangerFullAccess,
      isolateTemp: input.boundary !== AccessBoundary.DangerFullAccess,
      exposeAuthRoot: false,
    },
    networkPolicy: { mode: networkMode },
    commandPolicy: {
      validateCommands: input.boundary !== AccessBoundary.DangerFullAccess,
      deniedExecutableNames: [
        "docker",
        "docker-compose",
        "podman",
        "sudo",
        "su",
        "ssh",
        "scp",
        "rsync",
        "tmux",
      ],
      deniedGitSubcommands: ["push"],
      deniedPathPrefixes: scope?.registryRoot ? [normalizePath(scope.registryRoot)] : [],
      deniedInlineCodeExecutables: ["python", "python3", "node"],
      deniedScriptExecutables: ["sh", "bash", "zsh"],
    },
    ...(input.boundary === AccessBoundary.ProjectScopedControl && scope
      ? {
          brokerTokenScope: {
            projectId: scope.projectId,
            boundary: AccessBoundary.ProjectScopedControl,
            jobIdPrefixes: scope.jobIdPrefixes ?? [],
            ...(scope.registryRoot ? { registryRoot: normalizePath(scope.registryRoot) } : {}),
          },
        }
      : {}),
  };
}

export function validateCommandAgainstPolicy(input: {
  readonly command: readonly string[] | string;
  readonly policy: CommandPolicy;
}): CommandValidationDecision {
  if (!input.policy.validateCommands) {
    return commandAllowed(CommandValidationDecisionReason.ValidationDisabled);
  }
  const args = typeof input.command === "string"
    ? simpleCommandTokens(input.command)
    : input.command;
  if (args.length === 0 || !args[0]?.trim()) {
    return commandDenied(CommandValidationDecisionReason.EmptyCommand);
  }
  const executableName = executableBaseName(args[0] as string);
  if (input.policy.deniedExecutableNames.includes(executableName)) {
    return commandDenied(CommandValidationDecisionReason.DeniedExecutable, {
      executableName,
      evidence: [`${executableName} is denied by command policy`],
    });
  }
  if (
    executableName === "git" &&
    input.policy.deniedGitSubcommands.includes(args[1] ?? "")
  ) {
    return commandDenied(CommandValidationDecisionReason.DeniedGitSubcommand, {
      executableName,
      evidence: [`git ${args[1] ?? ""} is denied by command policy`],
    });
  }
  if (
    input.policy.deniedInlineCodeExecutables.includes(executableName) &&
    (args[1] === "-c" || args[1] === "-e")
  ) {
    return commandDenied(CommandValidationDecisionReason.InlineCodeDenied, {
      executableName,
      evidence: [`${executableName} inline code execution is denied`],
    });
  }
  if (
    input.policy.deniedScriptExecutables.includes(executableName) &&
    args.length > 1
  ) {
    return commandDenied(CommandValidationDecisionReason.ScriptInterpreterDenied, {
      executableName,
      evidence: [`${executableName} script execution is denied`],
    });
  }
  const commandText = args.join(" ");
  const deniedPath = input.policy.deniedPathPrefixes.find((prefix) =>
    commandText.includes(prefix)
  );
  if (deniedPath) {
    return commandDenied(CommandValidationDecisionReason.DeniedPathPrefix, {
      executableName,
      evidence: [`command references denied path prefix ${deniedPath}`],
    });
  }
  return commandAllowed(CommandValidationDecisionReason.Allowed, executableName);
}

class DefaultAccessPolicyService implements AccessPolicyService {
  constructor(private readonly context: AccessPolicyContext) {}

  decide(request: ProjectOperationRequest): PolicyDecision {
    switch (request.operation) {
      case ProjectOperation.ReadPath:
        return this.canReadPath(request);
      case ProjectOperation.WritePath:
        return this.canWritePath(request);
      case ProjectOperation.CreateJob:
        return this.canCreateJob(request);
      case ProjectOperation.StartWorker:
        return this.canStartWorker(request);
      case ProjectOperation.StopWorker:
        return this.canStopWorker(request);
      case ProjectOperation.CreateWorktree:
        return this.canCreateWorktree(request);
      case ProjectOperation.WriteReviewMarker:
        return this.canWriteReviewMarker(request);
      case ProjectOperation.IntegrateCommit:
        return this.canIntegrateCommit(request);
      case ProjectOperation.PushBranch:
        return this.canPushBranch(request);
      case ProjectOperation.UseAccount:
        return this.canUseAccount(request);
      case ProjectOperation.UseTool:
        return this.canUseTool(request);
    }
  }

  canReadPath(request: ProjectPathAccessRequest): PolicyDecision {
    return this.pathDecision(ProjectOperation.ReadPath, request, readRootsFor(this.scope()));
  }

  canWritePath(request: ProjectPathAccessRequest): PolicyDecision {
    const boundary = this.context.boundary;
    if (boundary === AccessBoundary.ReadOnly) {
      return this.deny(ProjectOperation.WritePath, AccessDecisionReason.BoundaryReadOnly);
    }
    if (boundary === AccessBoundary.DangerFullAccess) {
      return this.allow(ProjectOperation.WritePath, AccessDecisionReason.DangerFullAccess);
    }
    return this.pathDecision(
      ProjectOperation.WritePath,
      request,
      writeRootsForWorkspaceBoundary(boundary, this.scope()),
      { denyRegistryRawWrite: true },
    );
  }

  canCreateJob(request: ProjectJobAccessRequest): PolicyDecision {
    return this.projectControlJobDecision(ProjectOperation.CreateJob, request);
  }

  canStartWorker(request: ProjectJobAccessRequest): PolicyDecision {
    return this.projectControlJobDecision(ProjectOperation.StartWorker, request);
  }

  canStopWorker(request: ProjectJobAccessRequest): PolicyDecision {
    return this.projectControlJobDecision(ProjectOperation.StopWorker, request);
  }

  canCreateWorktree(request: ProjectWorktreeAccessRequest): PolicyDecision {
    if (this.context.boundary === AccessBoundary.DangerFullAccess) {
      return this.allow(
        ProjectOperation.CreateWorktree,
        AccessDecisionReason.DangerFullAccess,
      );
    }
    if (this.context.boundary !== AccessBoundary.ProjectScopedControl) {
      return this.deny(
        ProjectOperation.CreateWorktree,
        AccessDecisionReason.BoundaryInsufficient,
      );
    }
    const scope = this.scope();
    if (!scope) {
      return this.deny(
        ProjectOperation.CreateWorktree,
        AccessDecisionReason.MissingProjectScope,
      );
    }
    for (const branch of [
      request.baseBranch,
      request.sourceRef,
      request.newBranch,
    ]) {
      if (!branch) continue;
      const branchDecision = this.worktreeBaseBranchDecision(
        ProjectOperation.CreateWorktree,
        {
          ...(request.sourceWorkspacePath
            ? { workspacePath: request.sourceWorkspacePath }
            : {}),
          branch,
        },
      );
      if (!branchDecision.allowed) return branchDecision;
    }
    if (
      request.sourceWorkspacePath &&
      !pathInsideAnyRoot(request.sourceWorkspacePath, scopedWorkspaceRoots(scope))
    ) {
      return this.deny(
        ProjectOperation.CreateWorktree,
        AccessDecisionReason.PathOutsideScope,
        ["source workspace is outside project workspace roots"],
      );
    }
    if (
      request.realSourceWorkspacePath &&
      !pathInsideAnyRoot(request.realSourceWorkspacePath, scopedWorkspaceRoots(scope))
    ) {
      return this.deny(
        ProjectOperation.CreateWorktree,
        AccessDecisionReason.PathOutsideScope,
        ["source workspace real path is outside project workspace roots"],
      );
    }
    return this.pathDecision(
      ProjectOperation.CreateWorktree,
      { path: request.path },
      this.scope()?.worktreeRoots ?? [],
    );
  }

  canWriteReviewMarker(request: ProjectJobAccessRequest): PolicyDecision {
    return this.projectControlJobDecision(ProjectOperation.WriteReviewMarker, request);
  }

  canIntegrateCommit(request: ProjectGitAccessRequest): PolicyDecision {
    return this.branchDecision(ProjectOperation.IntegrateCommit, request);
  }

  canPushBranch(request: ProjectGitAccessRequest): PolicyDecision {
    return this.branchDecision(ProjectOperation.PushBranch, request);
  }

  canUseAccount(request: ProjectAccountAccessRequest): PolicyDecision {
    if (this.context.boundary === AccessBoundary.DangerFullAccess) {
      return this.allow(ProjectOperation.UseAccount, AccessDecisionReason.DangerFullAccess);
    }
    const scope = this.scope();
    if (!scope) {
      return this.deny(ProjectOperation.UseAccount, AccessDecisionReason.MissingProjectScope);
    }
    const allowed = scope.allowedAccountIds ?? [];
    if (allowed.length > 0 && !allowed.includes(request.accountId)) {
      return this.deny(ProjectOperation.UseAccount, AccessDecisionReason.AccountDenied, [
        `account ${request.accountId} is outside project account scope`,
      ]);
    }
    return this.allow(ProjectOperation.UseAccount);
  }

  canUseTool(request: ProjectToolAccessRequest): PolicyDecision {
    if (this.context.boundary === AccessBoundary.DangerFullAccess) {
      return this.allow(ProjectOperation.UseTool, AccessDecisionReason.DangerFullAccess);
    }
    const allowed = toolManifestFor(this.context.boundary).capabilities;
    if (!allowed.includes(request.tool)) {
      return this.deny(ProjectOperation.UseTool, AccessDecisionReason.ToolDenied, [
        `${request.tool} is not available for ${this.context.boundary}`,
      ]);
    }
    return this.allow(ProjectOperation.UseTool);
  }

  private projectControlJobDecision(
    operation: ProjectOperation,
    request: ProjectJobAccessRequest,
  ): PolicyDecision {
    if (this.context.boundary === AccessBoundary.DangerFullAccess) {
      return this.allow(operation, AccessDecisionReason.DangerFullAccess);
    }
    if (this.context.boundary !== AccessBoundary.ProjectScopedControl) {
      return this.deny(operation, AccessDecisionReason.BoundaryInsufficient);
    }
    const scope = this.scope();
    if (!scope) return this.deny(operation, AccessDecisionReason.MissingProjectScope);
    if (!matchesAnyPrefix(request.jobId, scope.jobIdPrefixes ?? [])) {
      return this.deny(operation, AccessDecisionReason.JobPrefixDenied, [
        `job ${request.jobId} does not match project job prefixes`,
      ]);
    }
    if (
      request.registryRoot &&
      scope.registryRoot &&
      normalizePath(request.registryRoot) !== normalizePath(scope.registryRoot)
    ) {
      return this.deny(operation, AccessDecisionReason.PathOutsideScope, [
        "registry root differs from project registry root",
      ]);
    }
    if (
      request.workspacePath &&
      !pathInsideAnyRoot(request.workspacePath, scopedWorkspaceRoots(scope))
    ) {
      return this.deny(operation, AccessDecisionReason.PathOutsideScope, [
        "worker workspace is outside project workspace roots",
      ]);
    }
    if (
      request.realWorkspacePath &&
      !pathInsideAnyRoot(request.realWorkspacePath, scopedWorkspaceRoots(scope))
    ) {
      return this.deny(operation, AccessDecisionReason.PathOutsideScope, [
        "worker workspace real path is outside project workspace roots",
      ]);
    }
    if (
      request.tmuxSession &&
      !matchesAnyPrefix(request.tmuxSession, scope.tmuxSessionPrefixes ?? [])
    ) {
      return this.deny(operation, AccessDecisionReason.TmuxPrefixDenied, [
        `tmux session ${request.tmuxSession} does not match project prefixes`,
      ]);
    }
    return this.allow(operation);
  }

  private worktreeBaseBranchDecision(
    operation: ProjectOperation,
    request: ProjectGitAccessRequest,
  ): PolicyDecision {
    const scope = this.scope();
    const remoteTracking = parseRemoteTrackingBranch(request.branch);
    if (!remoteTracking || !scope) return this.branchDecision(operation, request);
    if (
      scope.allowedGitRemotes &&
      !matchesAnyPattern(remoteTracking.remote, scope.allowedGitRemotes) &&
      remoteTracking.branch !== "main"
    ) {
      return this.branchDecision(operation, request);
    }
    const remoteAllowed = scope.allowedGitRemotes
      ? matchesAnyPattern(remoteTracking.remote, scope.allowedGitRemotes)
      : remoteTracking.remote === "origin";
    if (!remoteAllowed) {
      return this.deny(operation, AccessDecisionReason.RemoteDenied, [
        `remote ${remoteTracking.remote} is outside project remote scope`,
      ]);
    }
    const branchAllowed = scope.allowedBranches
      ? matchesAnyPattern(remoteTracking.branch, scope.allowedBranches)
      : remoteTracking.branch === "main";
    if (!branchAllowed) {
      return this.deny(operation, AccessDecisionReason.BranchDenied, [
        `branch ${remoteTracking.branch} is outside project branch scope`,
      ]);
    }
    return this.allow(operation);
  }

  private branchDecision(
    operation: ProjectOperation,
    request: ProjectGitAccessRequest,
  ): PolicyDecision {
    if (this.context.boundary === AccessBoundary.DangerFullAccess) {
      return this.allow(operation, AccessDecisionReason.DangerFullAccess);
    }
    if (this.context.boundary !== AccessBoundary.ProjectScopedControl) {
      return this.deny(operation, AccessDecisionReason.BoundaryInsufficient);
    }
    const scope = this.scope();
    if (!scope) return this.deny(operation, AccessDecisionReason.MissingProjectScope);
    if (
      request.workspacePath &&
      !pathInsideAnyRoot(request.workspacePath, scopedWorkspaceRoots(scope))
    ) {
      return this.deny(operation, AccessDecisionReason.PathOutsideScope, [
        "git workspace is outside project workspace roots",
      ]);
    }
    if (
      request.realWorkspacePath &&
      !pathInsideAnyRoot(request.realWorkspacePath, scopedWorkspaceRoots(scope))
    ) {
      return this.deny(operation, AccessDecisionReason.PathOutsideScope, [
        "git workspace real path is outside project workspace roots",
      ]);
    }
    if (request.force === true && scope.allowForcePush !== true) {
      return this.deny(operation, AccessDecisionReason.ForcePushDenied);
    }
    if (!matchesAnyPattern(request.branch, scope.allowedBranches ?? [])) {
      return this.deny(operation, AccessDecisionReason.BranchDenied, [
        `branch ${request.branch} is outside project branch scope`,
      ]);
    }
    if (
      request.remote &&
      !matchesAnyPattern(request.remote, scope.allowedGitRemotes ?? [])
    ) {
      return this.deny(operation, AccessDecisionReason.RemoteDenied, [
        `remote ${request.remote} is outside project remote scope`,
      ]);
    }
    return this.allow(operation);
  }

  private pathDecision(
    operation: ProjectOperation,
    request: ProjectPathAccessRequest,
    roots: readonly string[],
    options: { readonly denyRegistryRawWrite?: boolean } = {},
  ): PolicyDecision {
    if (this.context.boundary === AccessBoundary.DangerFullAccess) {
      return this.allow(operation, AccessDecisionReason.DangerFullAccess);
    }
    const scope = this.scope();
    if (!scope) return this.deny(operation, AccessDecisionReason.MissingProjectScope);
    const candidate = normalizePathOrNull(request.path);
    const realCandidate = request.realPath ? normalizePathOrNull(request.realPath) : undefined;
    if (!candidate || request.realPath && !realCandidate) {
      return this.deny(operation, AccessDecisionReason.InvalidPath);
    }
    const sensitive = sensitivePathDecision({
      operation,
      path: candidate,
      scope,
      denyRegistryRawWrite: options.denyRegistryRawWrite === true,
    });
    if (sensitive) return this.deny(operation, sensitive.reason, sensitive.evidence);
    const normalizedRoots = roots.map(normalizePath).filter(Boolean);
    if (
      !pathInsideAnyRoot(candidate, normalizedRoots) ||
      realCandidate && !pathInsideAnyRoot(realCandidate, normalizedRoots)
    ) {
      return this.deny(operation, AccessDecisionReason.PathOutsideScope);
    }
    return this.allow(operation);
  }

  private scope(): ProjectAccessScope | undefined {
    return this.context.scope;
  }

  private allow(
    operation: ProjectOperation,
    reason = AccessDecisionReason.Allowed,
    evidence: readonly string[] = [],
  ): PolicyDecision {
    return {
      allowed: true,
      boundary: this.context.boundary,
      operation,
      reason,
      ...(this.context.scope ? { projectId: this.context.scope.projectId } : {}),
      evidence,
    };
  }

  private deny(
    operation: ProjectOperation,
    reason: AccessDecisionReason,
    evidence: readonly string[] = [],
  ): PolicyDecision {
    return {
      allowed: false,
      boundary: this.context.boundary,
      operation,
      reason,
      ...(this.context.scope ? { projectId: this.context.scope.projectId } : {}),
      evidence,
    };
  }
}

function launchEnforcementBlocker(input: LaunchPlanInput): LaunchPlan | null {
  if (input.boundary === AccessBoundary.DangerFullAccess) return null;
  const missing: string[] = [];
  if (!input.adapter.canEnforceFilesystemPolicy) {
    missing.push("filesystem policy enforcement is unavailable");
  }
  if (!input.adapter.canIsolateHome) missing.push("HOME isolation is unavailable");
  if (!input.adapter.canIsolateTemp) missing.push("temporary directory isolation is unavailable");
  if (!input.adapter.canRestrictNetwork) {
    missing.push("network restriction is unavailable");
  }
  if (
    input.boundary === AccessBoundary.ReadOnly &&
    !input.adapter.canDisableRawShell
  ) {
    missing.push("raw shell cannot be disabled for read-only runs");
  }
  if (
    input.boundary === AccessBoundary.ProjectScopedControl &&
    !input.adapter.canBrokerProjectControl
  ) {
    missing.push("project control broker is unavailable");
  }
  if (
    input.boundary === AccessBoundary.ProjectScopedControl &&
    !input.adapter.canDisableRawShell
  ) {
    missing.push("raw shell cannot be disabled for project-scoped control");
  }
  return missing.length
    ? blockedLaunch(input, AccessDecisionReason.CannotEnforceAccessBoundary, missing)
    : null;
}

function blockedLaunch(
  input: Pick<LaunchPlanInput, "boundary">,
  reason: AccessDecisionReason,
  evidence: readonly string[],
): LaunchPlan {
  return {
    status: LaunchPlanStatus.Blocked,
    boundary: input.boundary,
    reason,
    evidence,
  };
}

function commandAllowed(
  reason: CommandValidationDecisionReason,
  executableName?: string,
): CommandValidationDecision {
  return {
    allowed: true,
    reason,
    ...(executableName ? { executableName } : {}),
    evidence: [],
  };
}

function commandDenied(
  reason: CommandValidationDecisionReason,
  options: {
    readonly executableName?: string;
    readonly evidence?: readonly string[];
  } = {},
): CommandValidationDecision {
  return {
    allowed: false,
    reason,
    ...(options.executableName ? { executableName: options.executableName } : {}),
    evidence: options.evidence ?? [],
  };
}

function executableBaseName(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? value;
}

function simpleCommandTokens(command: string): readonly string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function filesystemPolicyFor(
  boundary: AccessBoundary,
  scope: ProjectAccessScope | undefined,
): FilesystemPolicy {
  if (boundary === AccessBoundary.DangerFullAccess) {
    return {
      mode: FilesystemPolicyMode.Unrestricted,
      readRoots: [],
      writeRoots: [],
      deniedRoots: [],
    };
  }
  return {
    mode: boundary === AccessBoundary.ReadOnly
      ? FilesystemPolicyMode.ReadOnly
      : boundary === AccessBoundary.IsolatedWorkspaceWrite
      ? FilesystemPolicyMode.IsolatedWorkspaceWrite
      : FilesystemPolicyMode.ProjectScopedWrite,
    readRoots: readRootsFor(scope).map(normalizePath),
    writeRoots: boundary === AccessBoundary.ReadOnly
      ? []
      : writeRootsForWorkspaceBoundary(boundary, scope).map(normalizePath),
    deniedRoots: deniedRootsFor(scope).map(normalizePath),
  };
}

function toolManifestFor(boundary: AccessBoundary): ToolManifest {
  switch (boundary) {
    case AccessBoundary.ReadOnly:
      return {
        rawShell: RawShellAccessMode.Disabled,
        capabilities: [ProjectToolCapability.ReadOnlyDiagnostics],
      };
    case AccessBoundary.IsolatedWorkspaceWrite:
      return {
        rawShell: RawShellAccessMode.Sandboxed,
        capabilities: [
          ProjectToolCapability.ReadOnlyDiagnostics,
          ProjectToolCapability.RawShell,
          ProjectToolCapability.WorkspaceEdit,
          ProjectToolCapability.AccountSession,
        ],
      };
    case AccessBoundary.ProjectScopedControl:
      return {
        rawShell: RawShellAccessMode.Disabled,
        capabilities: [
          ProjectToolCapability.ReadOnlyDiagnostics,
          ProjectToolCapability.ProjectControlBroker,
          ProjectToolCapability.AccountSession,
        ],
      };
    case AccessBoundary.DangerFullAccess:
      return {
        rawShell: RawShellAccessMode.Unrestricted,
        capabilities: Object.values(ProjectToolCapability),
      };
  }
}

function readRootsFor(scope: ProjectAccessScope | undefined): readonly string[] {
  if (!scope) return [];
  return uniqueStrings([
    ...(scope.readRoots ?? []),
    ...scopedWorkspaceRoots(scope),
    ...(scope.registryRoot ? [scope.registryRoot] : []),
  ]);
}

function writeRootsForWorkspaceBoundary(
  boundary: AccessBoundary,
  scope: ProjectAccessScope | undefined,
): readonly string[] {
  if (!scope || boundary === AccessBoundary.ReadOnly) return [];
  if (boundary === AccessBoundary.IsolatedWorkspaceWrite) {
    return uniqueStrings([
      ...(scope.isolatedWorkspaceRoot ? [scope.isolatedWorkspaceRoot] : []),
      ...(scope.workspaceRoots ?? []),
    ]);
  }
  if (boundary === AccessBoundary.ProjectScopedControl) {
    return uniqueStrings(scopedWorkspaceRoots(scope));
  }
  return [];
}

function scopedWorkspaceRoots(scope: ProjectAccessScope): readonly string[] {
  return uniqueStrings([
    ...(scope.workspaceRoots ?? []),
    ...(scope.worktreeRoots ?? []),
    ...(scope.isolatedWorkspaceRoot ? [scope.isolatedWorkspaceRoot] : []),
  ]);
}

function deniedRootsFor(scope: ProjectAccessScope | undefined): readonly string[] {
  return uniqueStrings([
    ...(scope?.deniedRoots ?? []),
    ...(scope?.authRoot ? [scope.authRoot] : []),
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/var/lib/docker.sock",
  ]);
}

function sensitivePathDecision(input: {
  readonly operation: ProjectOperation;
  readonly path: string;
  readonly scope: ProjectAccessScope;
  readonly denyRegistryRawWrite: boolean;
}): { readonly reason: AccessDecisionReason; readonly evidence: readonly string[] } | null {
  if (pathInsideAnyRoot(input.path, deniedRootsFor(input.scope))) {
    return {
      reason: dockerSocketPath(input.path)
        ? AccessDecisionReason.DockerSocketDenied
        : AccessDecisionReason.AuthPathDenied,
      evidence: ["path is in a denied root"],
    };
  }
  if (hasPathSegment(input.path, ".git")) {
    return {
      reason: AccessDecisionReason.GitInternalPathDenied,
      evidence: ["direct .git internals access is not allowed"],
    };
  }
  if (
    input.denyRegistryRawWrite &&
    input.scope.registryRoot &&
    pathInside(input.path, input.scope.registryRoot)
  ) {
    return {
      reason: AccessDecisionReason.RegistryRawWriteDenied,
      evidence: ["registry writes must go through project control broker operations"],
    };
  }
  return null;
}

function normalizePathOrNull(path: string): string | null {
  if (!path.trim() || !isAbsolute(path)) return null;
  return normalizePath(path);
}

function normalizePath(path: string): string {
  return stripTrailingSeparator(resolve(path));
}

function pathInsideAnyRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => pathInside(path, root));
}

function pathInside(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}${sep}`)
  );
}

function stripTrailingSeparator(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

function hasPathSegment(path: string, segment: string): boolean {
  return normalizePath(path).split(/[\\/]+/).includes(segment);
}

function dockerSocketPath(path: string): boolean {
  return normalizePath(path).endsWith(`${sep}docker.sock`);
}

function matchesAnyPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.length > 0 && prefixes.some((prefix) => value.startsWith(prefix));
}

function matchesAnyPattern(value: string, patterns: readonly string[]): boolean {
  return patterns.length > 0 && patterns.some((pattern) => {
    if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
    return value === pattern;
  });
}

function parseRemoteTrackingBranch(
  value: string,
): { readonly remote: string; readonly branch: string } | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return {
    remote: value.slice(0, slash),
    branch: value.slice(slash + 1),
  };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

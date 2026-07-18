import { describe, expect, it } from "vitest";

import {
  AccessBoundary,
  AccessDecisionReason,
  CommandValidationDecisionReason,
  FilesystemPolicyMode,
  LaunchPlanStatus,
  NetworkAccessMode,
  ProjectOperation,
  ProjectToolCapability,
  RawShellAccessMode,
  buildLaunchPlan,
  createAccessPolicyService,
  validateCommandAgainstPolicy,
  type LaunchAdapterCapabilities,
  type ProjectAccessScope,
} from "../index";

const adapter: LaunchAdapterCapabilities = {
  canEnforceFilesystemPolicy: true,
  canIsolateHome: true,
  canIsolateTemp: true,
  canDisableRawShell: true,
  canBrokerProjectControl: true,
  canRestrictNetwork: true,
};

describe("project access control", () => {
  it("keeps the public boundary enum values stable", () => {
    expect(Object.values(AccessBoundary)).toEqual([
      "read_only",
      "isolated_workspace_write",
      "project_scoped_control",
      "danger_full_access",
    ]);
  });

  it("allows read-only diagnostics but denies writes and worker control", () => {
    const policy = createAccessPolicyService({
      boundary: AccessBoundary.ReadOnly,
      scope: scope(),
    });

    expect(policy.canReadPath({ path: "/work/infinity-context/README.md" }))
      .toMatchObject({ allowed: true });
    expect(policy.canWritePath({ path: "/work/infinity-context/README.md" }))
      .toMatchObject({
        allowed: false,
        reason: AccessDecisionReason.BoundaryReadOnly,
      });
    expect(policy.canStartWorker({
      jobId: "infinity-context-child-v1",
      workspacePath: "/work/infinity-context-child",
      tmuxSession: "infinity-context-child-v1",
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.BoundaryInsufficient,
    });
  });

  it("allows isolated workspace writes but blocks registry, auth, git internals and child workers", () => {
    const policy = createAccessPolicyService({
      boundary: AccessBoundary.IsolatedWorkspaceWrite,
      scope: scope(),
    });

    expect(policy.canWritePath({ path: "/work/infinity-context/src/index.ts" }))
      .toMatchObject({ allowed: true });
    expect(policy.canWritePath({ path: "/work/infinity-context-other/src/index.ts" }))
      .toMatchObject({
        allowed: false,
        reason: AccessDecisionReason.PathOutsideScope,
      });
    expect(policy.canWritePath({
      path: "/work/infinity-context/link-outside",
      realPath: "/tmp/outside-target",
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.PathOutsideScope,
    });
    expect(policy.canWritePath({
      path: "/work/infinity-context/.git/config",
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.GitInternalPathDenied,
    });
    expect(policy.canWritePath({
      path: "/var/data/worker-jobs/registry/infinity-context-job/job.json",
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.RegistryRawWriteDenied,
    });
    expect(policy.canReadPath({
      path: "/var/data/codex-home/live-codex-auth/account-a/auth.json",
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.AuthPathDenied,
    });
    expect(policy.canWritePath({ path: "/var/run/docker.sock" })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.DockerSocketDenied,
    });
    expect(policy.canCreateJob({ jobId: "infinity-context-child-v1" }))
      .toMatchObject({
        allowed: false,
        reason: AccessDecisionReason.BoundaryInsufficient,
      });
  });

  it("allows project-scoped broker operations only inside project prefixes and roots", () => {
    const policy = createAccessPolicyService({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
    });

    expect(policy.canCreateJob({
      jobId: "infinity-context-followup-v1",
      registryRoot: "/var/data/worker-jobs/registry",
      workspacePath: "/work/infinity-context-followup",
      tmuxSession: "infinity-context-followup-v1",
    })).toMatchObject({ allowed: true });
    expect(policy.canCreateJob({ jobId: "quanta-followup-v1" })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.JobPrefixDenied,
    });
    expect(policy.canStartWorker({
      jobId: "infinity-context-followup-v1",
      tmuxSession: "quanta-followup-v1",
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.TmuxPrefixDenied,
    });
    expect(policy.canCreateWorktree({
      path: "/work/infinity-context-lane-a",
      baseBranch: "main",
    })).toMatchObject({ allowed: true });
    expect(policy.canCreateWorktree({
      path: "/work/infinity-context-lane-a",
      baseBranch: "origin/main",
    })).toMatchObject({ allowed: true });
    expect(policy.canCreateWorktree({
      path: "/work/infinity-context-lane-a",
      sourceRef: "main",
      newBranch: "refactor/infinity-lane-a",
    })).toMatchObject({ allowed: true });
    expect(policy.canCreateWorktree({
      path: "/work/infinity-context-lane-a",
      sourceRef: "main",
      newBranch: "feature/private",
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.BranchDenied,
    });
    expect(policy.canCreateWorktree({
      path: "/work/infinity-context-lane-a",
      baseBranch: "upstream/main",
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.RemoteDenied,
    });
    expect(policy.canCreateWorktree({
      path: "/work/infinity-context-lane-a",
      baseBranch: "release/private",
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.BranchDenied,
    });
  });

  it("keeps project-scoped control on broker tools and denies raw shell", () => {
    const policy = createAccessPolicyService({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
    });

    expect(policy.canUseTool({
      tool: ProjectToolCapability.ProjectControlBroker,
    })).toMatchObject({ allowed: true });
    expect(policy.canUseTool({ tool: ProjectToolCapability.RawShell })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.ToolDenied,
    });
  });

  it("guards git integration and push by branch, remote and force rules", () => {
    const policy = createAccessPolicyService({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
    });

    expect(policy.canPushBranch({
      branch: "main",
      remote: "origin",
    })).toMatchObject({ allowed: true });
    expect(policy.canPushBranch({
      branch: "feature/out-of-scope",
      remote: "origin",
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.BranchDenied,
    });
    expect(policy.canPushBranch({
      branch: "main",
      remote: "fork",
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.RemoteDenied,
    });
    expect(policy.canPushBranch({
      branch: "main",
      remote: "origin",
      force: true,
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.ForcePushDenied,
    });
    expect(policy.canPushBranch({
      branch: "main",
      remote: "origin",
      force: true,
      expectedRemoteCommit: "1".repeat(40),
      expectedLocalCommit: "2".repeat(40),
      confirmExternalRewriteRecovery: true,
    })).toMatchObject({ allowed: true });
    expect(policy.canPushBranch({
      branch: "main",
      remote: "origin",
      force: true,
      expectedRemoteCommit: "1".repeat(40),
      expectedLocalCommit: "2".repeat(40),
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.ForcePushDenied,
    });
    expect(policy.canPushBranch({
      branch: "main",
      remote: "origin",
      force: true,
      expectedRemoteCommit: "short",
      expectedLocalCommit: "2".repeat(40),
      confirmExternalRewriteRecovery: true,
    })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.ForcePushDenied,
    });
  });

  it("limits account use to the configured project account scope", () => {
    const policy = createAccessPolicyService({
      boundary: AccessBoundary.IsolatedWorkspaceWrite,
      scope: scope(),
    });

    expect(policy.canUseAccount({ accountId: "account-a" })).toMatchObject({
      allowed: true,
    });
    expect(policy.canUseAccount({ accountId: "account-z" })).toMatchObject({
      allowed: false,
      reason: AccessDecisionReason.AccountDenied,
    });
  });

  it("fails launch plans closed when the adapter cannot enforce the boundary", () => {
    const plan = buildLaunchPlan({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
      adapter: {
        ...adapter,
        canBrokerProjectControl: false,
      },
    });

    expect(plan).toMatchObject({
      status: LaunchPlanStatus.Blocked,
      reason: AccessDecisionReason.CannotEnforceAccessBoundary,
    });
  });

  it("fails read-only launch closed when raw shell or network restriction cannot be enforced", () => {
    expect(buildLaunchPlan({
      boundary: AccessBoundary.ReadOnly,
      scope: scope(),
      adapter: {
        ...adapter,
        canDisableRawShell: false,
      },
    })).toMatchObject({
      status: LaunchPlanStatus.Blocked,
      reason: AccessDecisionReason.CannotEnforceAccessBoundary,
    });
    expect(buildLaunchPlan({
      boundary: AccessBoundary.ReadOnly,
      scope: scope(),
      adapter: {
        ...adapter,
        canRestrictNetwork: false,
      },
    })).toMatchObject({
      status: LaunchPlanStatus.Blocked,
      reason: AccessDecisionReason.CannotEnforceAccessBoundary,
    });
  });

  it("builds a project-scoped launch plan with broker control and no raw shell", () => {
    const plan = buildLaunchPlan({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
      adapter,
      networkAccess: NetworkAccessMode.Restricted,
    });

    expect(plan).toMatchObject({
      status: LaunchPlanStatus.Ready,
      filesystemPolicy: {
        mode: FilesystemPolicyMode.ProjectScopedWrite,
      },
      toolManifest: {
        rawShell: RawShellAccessMode.Disabled,
        capabilities: expect.arrayContaining([
          ProjectToolCapability.ProjectControlBroker,
        ]),
      },
      networkPolicy: { mode: NetworkAccessMode.Restricted },
      brokerTokenScope: {
        projectId: "infinity-context",
        boundary: AccessBoundary.ProjectScopedControl,
      },
      commandPolicy: {
        validateCommands: true,
        deniedGitSubcommands: ["push"],
        deniedExecutableNames: expect.arrayContaining(["docker", "tmux", "ssh"]),
      },
    });
  });

  it("validates risky shell commands as a secondary fail-closed layer", () => {
    const plan = buildLaunchPlan({
      boundary: AccessBoundary.IsolatedWorkspaceWrite,
      scope: scope(),
      adapter,
      networkAccess: NetworkAccessMode.Restricted,
    });
    if (plan.status !== LaunchPlanStatus.Ready) {
      throw new Error("expected ready plan");
    }

    expect(validateCommandAgainstPolicy({
      command: ["git", "status"],
      policy: plan.commandPolicy,
    })).toMatchObject({
      allowed: true,
      reason: CommandValidationDecisionReason.Allowed,
    });
    expect(validateCommandAgainstPolicy({
      command: ["git", "push", "origin", "main"],
      policy: plan.commandPolicy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.DeniedGitSubcommand,
    });
    expect(validateCommandAgainstPolicy({
      command: ["/usr/bin/git", "push", "origin", "main"],
      policy: plan.commandPolicy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.DeniedGitSubcommand,
    });
    expect(validateCommandAgainstPolicy({
      command: ["tmux", "new-session"],
      policy: plan.commandPolicy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.DeniedExecutable,
    });
    expect(validateCommandAgainstPolicy({
      command: "python -c print(1)",
      policy: plan.commandPolicy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.InlineCodeDenied,
    });
    expect(validateCommandAgainstPolicy({
      command: ["sh", "script.sh"],
      policy: plan.commandPolicy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.ScriptInterpreterDenied,
    });
    expect(validateCommandAgainstPolicy({
      command: ["node", "-e", "console.log(1)"],
      policy: plan.commandPolicy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.InlineCodeDenied,
    });
    expect(validateCommandAgainstPolicy({
      command: [
        "python3",
        "write.py",
        "/var/data/worker-jobs/registry/infinity-context/job.json",
      ],
      policy: plan.commandPolicy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.DeniedPathPrefix,
    });
  });

  it("requires an explicit acknowledgement before building danger full access", () => {
    expect(buildLaunchPlan({
      boundary: AccessBoundary.DangerFullAccess,
      adapter,
    })).toMatchObject({
      status: LaunchPlanStatus.Blocked,
      reason: AccessDecisionReason.CannotEnforceAccessBoundary,
    });

    expect(buildLaunchPlan({
      boundary: AccessBoundary.DangerFullAccess,
      adapter,
      allowDangerFullAccess: true,
    })).toMatchObject({
      status: LaunchPlanStatus.Ready,
      toolManifest: { rawShell: RawShellAccessMode.Unrestricted },
      networkPolicy: { mode: NetworkAccessMode.Unrestricted },
    });
  });

  it("exposes a generic decide entrypoint for broker callers", () => {
    const policy = createAccessPolicyService({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
    });

    expect(policy.decide({
      operation: ProjectOperation.WriteReviewMarker,
      jobId: "infinity-context-review-v1",
    })).toMatchObject({ allowed: true });
  });
});

function scope(): ProjectAccessScope {
  return {
    projectId: "infinity-context",
    projectSlug: "example/infinity-context",
    readRoots: ["/work/infinity-context"],
    isolatedWorkspaceRoot: "/work/infinity-context",
    workspaceRoots: ["/work/infinity-context"],
    worktreeRoots: ["/work/infinity-context-followup", "/work/infinity-context-lane-a"],
    registryRoot: "/var/data/worker-jobs/registry",
    authRoot: "/var/data/codex-home/live-codex-auth",
    deniedRoots: ["/secrets"],
    jobIdPrefixes: ["infinity-context-"],
    tmuxSessionPrefixes: ["infinity-context-"],
    allowedBranches: ["main", "refactor/infinity-*"],
    allowedGitRemotes: ["origin"],
    allowedAccountIds: ["account-a", "account-b"],
  };
}

import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  LaunchPlanStatus,
  NetworkAccessMode,
  RunEventProviderKind,
  buildControlledAgentLaunchPlan,
} from "../../index";
import {
  ControlledAgentLaunchBlockReason,
  type ControlledAgentProviderEnforcementCapabilities,
  ControlledAgentToolName,
  projectScopedControllerToolNames,
} from "../index";

describe("controlled-agent launch plan", () => {
  it("builds a project-scoped broker-only launch plan when provider enforcement is strong", () => {
    const plan = buildControlledAgentLaunchPlan({
      controllerJobId: "infinity-context-controller-v1",
      sessionId: "session-1",
      stateDir: "/tmp/controller-state",
      boundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: projectScope(),
      provider: providerCaps({ canDisableRawShell: true }),
      networkAccess: NetworkAccessMode.Restricted,
      now: new Date("2026-07-05T10:00:00.000Z"),
    });

    expect(plan.status).toBe(LaunchPlanStatus.Ready);
    if (plan.status !== LaunchPlanStatus.Ready) throw new Error("expected ready");
    expect(plan.session).toMatchObject({
      schemaVersion: 1,
      sessionId: "session-1",
      stateDir: "/tmp/controller-state",
      status: "planned",
      identity: {
        controllerJobId: "infinity-context-controller-v1",
        projectId: "infinity-context",
        providerKind: RunEventProviderKind.Codex,
      },
    });
    expect(plan.session.toolSurface.allowedTools.map((tool) => tool.name)).toEqual(
      projectScopedControllerToolNames(),
    );
    expect(plan.session.toolSurface.deniedRawCapabilities).toContain("raw_shell");
    expect(plan.session.toolSurface.deniedRawCapabilities).toContain(
      "direct_registry_write",
    );
    expect(plan.commandPolicy.validateCommands).toBe(true);
    expect(plan.environmentPolicy.exposeAuthRoot).toBe(false);
    expect(plan.networkPolicy.mode).toBe(NetworkAccessMode.Restricted);
  });

  it("fails closed when a provider cannot remove raw shell from the LLM tool surface", () => {
    const plan = buildControlledAgentLaunchPlan({
      controllerJobId: "infinity-context-controller-v1",
      sessionId: "session-1",
      stateDir: "/tmp/controller-state",
      boundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: projectScope(),
      provider: providerCaps({ canDisableRawShell: false }),
      networkAccess: NetworkAccessMode.Restricted,
    });

    expect(plan).toMatchObject({
      status: LaunchPlanStatus.Blocked,
      reason: ControlledAgentLaunchBlockReason.ProviderCannotDisableRawShell,
    });
  });

  it("rejects non-controller boundaries for controlled LLM controller sessions", () => {
    const plan = buildControlledAgentLaunchPlan({
      controllerJobId: "worker-v1",
      sessionId: "session-1",
      stateDir: "/tmp/controller-state",
      boundary: AccessBoundary.IsolatedWorkspaceWrite,
      projectAccessScope: projectScope(),
      provider: providerCaps({ canDisableRawShell: true }),
    });

    expect(plan).toMatchObject({
      status: LaunchPlanStatus.Blocked,
      reason: ControlledAgentLaunchBlockReason.BoundaryRequired,
    });
  });

  it("keeps raw authority out of the controller tool allowlist", () => {
    const tools = projectScopedControllerToolNames();

    expect(tools).toContain(ControlledAgentToolName.ProjectCreateJob);
    expect(tools).toContain(ControlledAgentToolName.ProjectPushApprovedCommit);
    expect(tools).not.toContain("git" as never);
    expect(tools).not.toContain("tmux" as never);
    expect(tools).not.toContain("bash" as never);
  });
});

function projectScope() {
  return {
    projectId: "infinity-context",
    registryRoot: "/var/data/infinity-context/worker-jobs/registry",
    workspaceRoots: ["/var/data/infinity-context/workspaces"],
    worktreeRoots: ["/var/data/infinity-context/worktrees"],
    jobIdPrefixes: ["infinity-context-"],
    tmuxSessionPrefixes: ["infinity-context-"],
    allowedBranches: ["main"],
    allowedGitRemotes: ["origin"],
    allowedAccountIds: ["account-e"],
  };
}

function providerCaps(
  overrides: Partial<ControlledAgentProviderEnforcementCapabilities> = {},
): ControlledAgentProviderEnforcementCapabilities {
  return {
    providerKind: RunEventProviderKind.Codex,
    canRestrictToolSurface: true,
    canDisableRawShell: true,
    canEnforceFilesystemSandbox: true,
    canIsolateHome: true,
    canIsolateTemp: true,
    canRestrictNetwork: true,
    ...overrides,
  };
}

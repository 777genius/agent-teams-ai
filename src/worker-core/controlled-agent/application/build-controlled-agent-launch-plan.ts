import {
  AccessBoundary,
  LaunchPlanStatus,
  NetworkAccessMode,
  buildLaunchPlan,
} from "../../access-control";
import { ControlledAgentRunStatus } from "../domain/controlled-agent";
import {
  ControlledAgentLaunchBlockReason,
  type ControlledAgentLaunchPlan,
  type ControlledAgentLaunchPlanInput,
} from "../domain/controlled-agent";
import { projectScopedControllerToolSurfacePolicy } from "./tool-surface-policy";

export class BuildControlledAgentLaunchPlanUseCase {
  build(input: ControlledAgentLaunchPlanInput): ControlledAgentLaunchPlan {
    if (input.boundary !== AccessBoundary.ProjectScopedControl) {
      return blocked(input, ControlledAgentLaunchBlockReason.BoundaryRequired, [
        "controlled LLM controllers require project_scoped_control",
      ]);
    }
    if (!input.projectAccessScope) {
      return blocked(input, ControlledAgentLaunchBlockReason.ProjectScopeRequired, [
        "project scope is required for a broker-only controller",
      ]);
    }
    const providerBlocker = providerCapabilityBlocker(input);
    if (providerBlocker) return providerBlocker;

    const accessPlan = buildLaunchPlan({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: input.projectAccessScope,
      networkAccess: input.networkAccess ?? NetworkAccessMode.Restricted,
      adapter: {
        canEnforceFilesystemPolicy: input.provider.canEnforceFilesystemSandbox,
        canIsolateHome: input.provider.canIsolateHome,
        canIsolateTemp: input.provider.canIsolateTemp,
        canDisableRawShell: input.provider.canDisableRawShell,
        canBrokerProjectControl: input.provider.canRestrictToolSurface,
        canRestrictNetwork: input.provider.canRestrictNetwork,
      },
    });
    if (accessPlan.status === LaunchPlanStatus.Blocked) {
      return {
        status: LaunchPlanStatus.Blocked,
        controllerJobId: input.controllerJobId,
        boundary: input.boundary,
        reason: ControlledAgentLaunchBlockReason.AccessPlanBlocked,
        accessReason: accessPlan.reason,
        evidence: accessPlan.evidence,
      };
    }

    const now = (input.now ?? new Date()).toISOString();
    return {
      status: LaunchPlanStatus.Ready,
      session: {
        schemaVersion: 1,
        sessionId: input.sessionId,
        identity: {
          controllerJobId: input.controllerJobId,
          projectId: input.projectAccessScope.projectId,
          providerKind: input.provider.providerKind,
        },
        stateDir: input.stateDir,
        status: ControlledAgentRunStatus.Planned,
        createdAt: now,
        updatedAt: now,
        toolSurface: projectScopedControllerToolSurfacePolicy(),
      },
      filesystemPolicy: accessPlan.filesystemPolicy,
      environmentPolicy: accessPlan.environmentPolicy,
      networkPolicy: accessPlan.networkPolicy,
      commandPolicy: accessPlan.commandPolicy,
      evidence: [
        "provider can restrict tool surface",
        "provider can disable raw shell",
        "project broker tools are the only write surface",
      ],
    };
  }
}

export function buildControlledAgentLaunchPlan(
  input: ControlledAgentLaunchPlanInput,
): ControlledAgentLaunchPlan {
  return new BuildControlledAgentLaunchPlanUseCase().build(input);
}

function providerCapabilityBlocker(
  input: ControlledAgentLaunchPlanInput,
): ControlledAgentLaunchPlan | null {
  if (!input.provider.canRestrictToolSurface) {
    return blocked(input, ControlledAgentLaunchBlockReason.ProviderCannotRestrictToolSurface, [
      "provider cannot enforce a broker-only tool allowlist",
    ]);
  }
  if (!input.provider.canDisableRawShell) {
    return blocked(input, ControlledAgentLaunchBlockReason.ProviderCannotDisableRawShell, [
      "provider cannot remove raw shell from the LLM tool surface",
    ]);
  }
  if (!input.provider.canEnforceFilesystemSandbox) {
    return blocked(
      input,
      ControlledAgentLaunchBlockReason.ProviderCannotEnforceFilesystemSandbox,
      ["provider cannot enforce filesystem sandbox policy"],
    );
  }
  if (!input.provider.canIsolateHome) {
    return blocked(input, ControlledAgentLaunchBlockReason.ProviderCannotIsolateHome, [
      "provider cannot isolate HOME for controller session state",
    ]);
  }
  if (!input.provider.canIsolateTemp) {
    return blocked(input, ControlledAgentLaunchBlockReason.ProviderCannotIsolateTemp, [
      "provider cannot isolate temporary directories",
    ]);
  }
  if (!input.provider.canRestrictNetwork) {
    return blocked(input, ControlledAgentLaunchBlockReason.ProviderCannotRestrictNetwork, [
      "provider cannot restrict controller network access",
    ]);
  }
  return null;
}

function blocked(
  input: ControlledAgentLaunchPlanInput,
  reason: ControlledAgentLaunchBlockReason,
  evidence: readonly string[],
): ControlledAgentLaunchPlan {
  return {
    status: LaunchPlanStatus.Blocked,
    controllerJobId: input.controllerJobId,
    boundary: input.boundary,
    reason,
    evidence,
  };
}


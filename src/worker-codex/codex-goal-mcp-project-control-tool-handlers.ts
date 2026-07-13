import { mcpJson } from "./codex-goal-mcp-response";
import type {
  JobUpdateMcpArgs,
  ProjectControllerLaunchPlanMcpArgs,
  ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import {
  projectControlAdmissionSnapshotView,
  projectControlRepairJobManifestView,
  projectControlUpdateControllerScopeView,
} from "./codex-goal-mcp-project-control-admin";
import {
  projectControlCreateWorktreeView,
  projectControlIntegrateCommitView,
  projectControlMarkReviewedView,
  projectControlPushBranchView,
  projectControlStartStoredJobView,
  projectControlStopStoredJobView,
} from "./codex-goal-mcp-project-control-actions";
import {
  projectControlCreateCodexGoalJobView,
  projectControlOperationStatusView,
  projectControlPrepareVerifierView,
  projectControlRecoverOperationsView,
  projectControlRefillWorkerView,
} from "./codex-goal-mcp-project-control-jobs";
import {
  projectControllerConsumeGuidanceView,
  projectControllerLaunchPlanView,
  projectControllerReconcileView,
  projectControllerStartView,
  projectControllerStatusView,
  projectControllerStopView,
} from "./codex-goal-mcp-project-controller";
import {
  createInMemoryProjectControllerProviderRegistry,
} from "./application/project-control/codex-goal-project-controller-runtime";
import {
  codexProjectAdmissionDeps,
  codexProjectControlBroker,
  loadJobLaunch,
  loadProjectControlController,
} from "./codex-goal-mcp-project-control-deps";

const serverVersion = process.env.npm_package_version ?? "0.0.0";
const projectControllerProviderRegistry =
  createInMemoryProjectControllerProviderRegistry();

function projectControlAdminDeps() {
  return {
    loadProjectControlController,
    admissionDeps: codexProjectAdmissionDeps,
  };
}

export async function projectControlAdmissionSnapshot(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlAdmissionSnapshotView(args, projectControlAdminDeps()));
}

export async function projectControlUpdateControllerScope(
  args: ProjectControlMcpArgs,
) {
  return mcpJson(await projectControlUpdateControllerScopeView(args, projectControlAdminDeps()));
}

export async function projectControlRepairJobManifest(
  args: ProjectControlMcpArgs & JobUpdateMcpArgs,
) {
  return mcpJson(await projectControlRepairJobManifestView(args, projectControlAdminDeps()));
}

function projectControllerDeps() {
  return {
    loadProjectControlController,
    runtimeVersion: serverVersion,
    providerRegistry: projectControllerProviderRegistry,
  };
}

export async function projectControllerLaunchPlan(args: ProjectControllerLaunchPlanMcpArgs) {
  return mcpJson(await projectControllerLaunchPlanView(args, projectControllerDeps()));
}

export async function projectControllerStart(args: ProjectControllerLaunchPlanMcpArgs) {
  return mcpJson(await projectControllerStartView(args, projectControllerDeps()));
}

export async function projectControllerStatus(args: ProjectControllerLaunchPlanMcpArgs) {
  return mcpJson(await projectControllerStatusView(args, projectControllerDeps()));
}

export async function projectControllerConsumeGuidance(args: ProjectControllerLaunchPlanMcpArgs) {
  return mcpJson(await projectControllerConsumeGuidanceView(args, projectControllerDeps()));
}

export async function projectControllerStop(args: ProjectControllerLaunchPlanMcpArgs) {
  return mcpJson(await projectControllerStopView(args, projectControllerDeps()));
}

export async function projectControllerReconcile(args: ProjectControllerLaunchPlanMcpArgs) {
  return mcpJson(await projectControllerReconcileView(args, projectControllerDeps()));
}

function projectControlJobsDeps() {
  return {
    loadProjectControlController,
    codexProjectControlBroker,
  };
}

export async function projectControlCreateCodexGoalJob(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlCreateCodexGoalJobView(args, projectControlJobsDeps()));
}

export async function projectControlRefillWorker(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlRefillWorkerView(args, projectControlJobsDeps()));
}

export async function projectControlPrepareVerifier(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlPrepareVerifierView(args, projectControlJobsDeps()));
}

export async function projectControlOperationStatus(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlOperationStatusView(args, projectControlJobsDeps()));
}

export async function projectControlRecoverOperations(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlRecoverOperationsView(args, projectControlJobsDeps()));
}

function projectControlActionDeps() {
  return {
    loadProjectControlController,
    loadJobLaunch,
    codexProjectControlBroker,
  };
}

export async function projectControlStartStoredJob(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlStartStoredJobView(args, projectControlActionDeps()));
}

export async function projectControlCreateWorktree(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlCreateWorktreeView(args, projectControlActionDeps()));
}

export async function projectControlIntegrateCommit(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlIntegrateCommitView(args, projectControlActionDeps()));
}

export async function projectControlPushBranch(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlPushBranchView(args, projectControlActionDeps()));
}

export async function projectControlStopStoredJob(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlStopStoredJobView(args, projectControlActionDeps()));
}

export async function projectControlMarkReviewed(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlMarkReviewedView(args, projectControlActionDeps()));
}

import {
  AccessBoundary,
  type ProjectAccessScope,
  type ProjectControlBroker,
} from "@vioxen/subscription-runtime/worker-core";
import {
  listCodexGoalJobs,
  readCodexGoalJob,
  type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import {
  registryRootFromArgs,
  type ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import { buildCodexGoalOverviewItems } from "./codex-goal-mcp-overview-item";
import {
  createCodexProjectControlBroker,
  type CodexProjectControlBrokerInput,
} from "./codex-goal-mcp-project-broker";
import type { CodexProjectAdmissionDeps } from "./application/project-control/codex-goal-project-admission";
import { requiredRawString } from "./codex-goal-mcp-values";
export {
  loadJobLaunch,
  type LoadedCodexGoalJobLaunch,
} from "./application/codex-goal-job-launch-loader";

export type LoadedProjectControlController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};

export async function loadProjectControlController(
  args: ProjectControlMcpArgs,
): Promise<LoadedProjectControlController> {
  const registryRootDir = registryRootFromArgs(args);
  const controller = await readCodexGoalJob({
    registryRootDir,
    jobId: requiredRawString(args.controllerJobId, "controllerJobId"),
  });
  if (controller.accessBoundary !== AccessBoundary.ProjectScopedControl) {
    throw new Error("project_control_controller_boundary_required");
  }
  if (!controller.projectAccessScope) {
    throw new Error("project_control_controller_scope_required");
  }
  return {
    registryRootDir,
    controller,
    scope: controller.projectAccessScope,
  };
}

export const codexProjectAdmissionDeps: CodexProjectAdmissionDeps = {
  listJobs: listCodexGoalJobs,
  buildOverviewItems: (inputs) => buildCodexGoalOverviewItems(inputs),
};

export function codexProjectControlBroker(
  input: Omit<CodexProjectControlBrokerInput, "admissionDeps">,
): ProjectControlBroker {
  return createCodexProjectControlBroker({
    ...input,
    admissionDeps: codexProjectAdmissionDeps,
  });
}

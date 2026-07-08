import {
  AccessBoundary,
  type ProjectAccessScope,
  type ProjectControlBroker,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobToArgs,
  listCodexGoalJobs,
  readCodexGoalJob,
  type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import {
  registryRootFromArgs,
  type JobIdMcpArgs,
  type ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import { goalLaunchInput } from "./codex-goal-mcp-launch-input";
import { buildCodexGoalOverviewItem } from "./codex-goal-mcp-overview-item";
import {
  createCodexProjectControlBroker,
  type CodexProjectControlBrokerInput,
} from "./codex-goal-mcp-project-broker";
import type { CodexProjectAdmissionDeps } from "./codex-goal-mcp-project-admission";
import { requiredRawString } from "./codex-goal-mcp-values";

export type LoadedCodexGoalJobLaunch = {
  readonly registryRootDir: string;
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
};

export type LoadedProjectControlController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};

export async function loadJobLaunch(
  args: JobIdMcpArgs,
): Promise<LoadedCodexGoalJobLaunch> {
  const registryRootDir = registryRootFromArgs(args);
  const manifest = await readCodexGoalJob({
    registryRootDir,
    jobId: requiredRawString(args.jobId, "jobId"),
  });
  return {
    registryRootDir,
    manifest,
    launch: await goalLaunchInput(codexGoalJobToArgs(manifest)),
  };
}

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
  buildOverviewItem: (input) => buildCodexGoalOverviewItem(input),
};

export function codexProjectControlBroker(
  input: Omit<CodexProjectControlBrokerInput, "admissionDeps">,
): ProjectControlBroker {
  return createCodexProjectControlBroker({
    ...input,
    admissionDeps: codexProjectAdmissionDeps,
  });
}

import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "../../codex-goal-project-workspace-lock";
import {
  assertProjectPreStartAdmissionLaunchBinding,
  type ProjectPreStartAdmissionLaunchWorkspaceMode,
  validateStoredProjectPreStartAdmission,
} from "./codex-goal-project-pre-start-admission";

export type ProjectRefillPreStartAdmissionWorkspaceMode =
  ProjectPreStartAdmissionLaunchWorkspaceMode | undefined;

export async function validateProjectRefillPreStartAdmission(input: {
  readonly registryRootDir: string;
  readonly controllerJobId: string;
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly expectedCanonicalWorkspacePath: string;
  readonly admittedInputPatch: boolean;
}): Promise<ProjectRefillPreStartAdmissionWorkspaceMode> {
  return await withValidatedProjectWorkspaceLock({
    locks: projectControlWorkspaceLocks(input.registryRootDir),
    scope: input.scope,
    requestedWorkspacePath: input.manifest.workspacePath,
    expectedCanonicalWorkspacePath: input.expectedCanonicalWorkspacePath,
    owner:
      `project-refill-admission:${input.controllerJobId}:` +
      input.manifest.jobId,
    effect: async () =>
      await validateProjectRefillPreStartAdmissionLocked(input),
  });
}

/**
 * Validates the immutable pre-start admission while the caller holds the
 * project workspace lock. A fresh receipt still traverses the complete stored
 * validator path. A previously launch-authorized same-job refill is a
 * continuation: it must preserve the original receipt and prove every launch
 * binding instead of attempting to admit the job as fresh again.
 */
export async function validateProjectRefillPreStartAdmissionLocked(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly admittedInputPatch?: boolean;
}): Promise<ProjectRefillPreStartAdmissionWorkspaceMode> {
  try {
    await validateStoredProjectPreStartAdmission({
      manifest: input.manifest,
      scope: input.scope,
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "project_control_pre_start_admission_already_authorized"
    ) {
      throw error;
    }
    if (input.admittedInputPatch !== false) {
      await assertProjectPreStartAdmissionLaunchBinding({
        manifest: input.manifest,
        scope: input.scope,
        workspaceMode: "admitted_input_patch_continuation",
      });
      return "admitted_input_patch_continuation";
    }
    await assertProjectPreStartAdmissionLaunchBinding({
      manifest: input.manifest,
      scope: input.scope,
      workspaceMode: "clean_capacity_continuation",
    });
    return "clean_capacity_continuation";
  }

  await assertProjectPreStartAdmissionLaunchBinding({
    manifest: input.manifest,
    scope: input.scope,
    ...(input.admittedInputPatch
      ? { workspaceMode: "admitted_input_patch" as const }
      : {}),
  });
  return input.admittedInputPatch ? "admitted_input_patch" : undefined;
}

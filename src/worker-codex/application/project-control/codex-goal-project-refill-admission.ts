import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "../../codex-goal-project-workspace-lock";
import {
  assertProjectPreStartAdmissionLaunchBinding,
  validateStoredProjectPreStartAdmission,
} from "./codex-goal-project-pre-start-admission";

export async function validateProjectRefillPreStartAdmission(input: {
  readonly registryRootDir: string;
  readonly controllerJobId: string;
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly expectedCanonicalWorkspacePath: string;
  readonly admittedInputPatch: boolean;
}): Promise<void> {
  await withValidatedProjectWorkspaceLock({
    locks: projectControlWorkspaceLocks(input.registryRootDir),
    scope: input.scope,
    requestedWorkspacePath: input.manifest.workspacePath,
    expectedCanonicalWorkspacePath: input.expectedCanonicalWorkspacePath,
    owner:
      `project-refill-admission:${input.controllerJobId}:` +
      input.manifest.jobId,
    effect: async () => {
      await validateStoredProjectPreStartAdmission({
        manifest: input.manifest,
        scope: input.scope,
      });
      await assertProjectPreStartAdmissionLaunchBinding({
        manifest: input.manifest,
        scope: input.scope,
        ...(input.admittedInputPatch
          ? { workspaceMode: "admitted_input_patch" as const }
          : {}),
      });
    },
  });
}

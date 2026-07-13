import { dirname, join } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifestInput } from "../../codex-goal-jobs";
import type { CodexGoalJobCreateInput } from "../codex-goal-use-case-inputs";
import { jobManifestInputFromArgs } from "../codex-goal-manifest-input";
import { requiredRawString } from "../codex-goal-input-values";

export function projectControlChildManifestInput(input: {
  readonly args: CodexGoalJobCreateInput;
  readonly scope: ProjectAccessScope;
  readonly registryRootDir: string;
}): CodexGoalJobManifestInput {
  const jobId = requiredRawString(input.args.jobId, "jobId");
  const projectRoot = dirname(
    input.scope.registryRoot ?? input.registryRootDir,
  );
  return jobManifestInputFromArgs({
    ...input.args,
    ...(input.args.jobRootDir === undefined
      ? { jobRootDir: join(projectRoot, jobId) }
      : {}),
    ...(input.args.authRootDir === undefined && input.scope.authRoot
      ? { authRootDir: input.scope.authRoot }
      : {}),
  });
}

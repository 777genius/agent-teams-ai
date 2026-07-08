import {
  codexGoalJobToArgs,
  readCodexGoalJob,
  type CodexGoalJobManifest,
} from "../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import { goalLaunchInput } from "./codex-goal-launch-input";
import { requiredRawString } from "./codex-goal-input-values";
import {
  registryRootFromInput,
  type CodexGoalJobIdInput,
} from "./codex-goal-use-case-inputs";

export type LoadedCodexGoalJobLaunch = {
  readonly registryRootDir: string;
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
};

export async function loadJobLaunch(
  args: CodexGoalJobIdInput,
): Promise<LoadedCodexGoalJobLaunch> {
  const registryRootDir = registryRootFromInput(args);
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

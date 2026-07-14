import { createLocalFileSafeExecutionStores } from "@vioxen/subscription-runtime/store-local-file";
import type { AttemptJournal } from "@vioxen/subscription-runtime/worker-core";
import { codexGoalStateRootDir } from "./application/codex-goal-worker-control";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";

export function localCodexProjectSafeExecutionJournal(
  launch: CodexGoalLaunchInput,
): Pick<AttemptJournal, "readTask"> {
  return createLocalFileSafeExecutionStores({
    rootDir: codexGoalStateRootDir(launch),
  }).journal;
}

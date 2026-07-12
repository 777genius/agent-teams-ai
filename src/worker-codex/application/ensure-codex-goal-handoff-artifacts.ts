import {
  collectCodexGoalStatus,
  reconcileCodexGoalRuntimeResult,
  resolveCodexGoalWorkerLiveness,
  type CodexGoalLaunchInput,
  type CodexGoalStatus,
} from "../codex-goal-ops";
import { codexGoalStatusInputFromLaunch } from "./codex-goal-status-input";

export async function ensureTerminalCodexGoalHandoffArtifacts(input: {
  readonly launch: CodexGoalLaunchInput;
  readonly status?: CodexGoalStatus;
}): Promise<CodexGoalStatus> {
  const status = input.status ?? await collectCodexGoalStatus(
    codexGoalStatusInputFromLaunch(input.launch),
  );
  const workerLiveness = resolveCodexGoalWorkerLiveness({ status });
  if (
    workerLiveness.alive ||
    status.resultStatus !== "done" ||
    status.workspaceDirty !== true ||
    (status.changedFiles ?? []).length === 0
  ) {
    return status;
  }
  await reconcileCodexGoalRuntimeResult({
    config: input.launch.config,
    status,
    forceWrite: true,
    preservePatch: true,
  });
  return await collectCodexGoalStatus(
    codexGoalStatusInputFromLaunch(input.launch),
  );
}

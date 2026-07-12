import type { RuntimeResultArtifact } from "@vioxen/subscription-runtime/worker-core";

import { materializeCodexGoalHandoffArtifacts } from "./codex-goal-handoff-artifacts";

export type TerminalCodexGoalHandoffMaterialization = {
  readonly artifacts: readonly RuntimeResultArtifact[];
  readonly changedPaths?: readonly string[];
  readonly errorCode?: string;
};

export async function tryMaterializeTerminalCodexGoalHandoff(input: {
  readonly jobId?: string;
  readonly jobRootDir: string;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly expectedBaseCommit?: string;
}): Promise<TerminalCodexGoalHandoffMaterialization> {
  try {
    const materialized = await materializeCodexGoalHandoffArtifacts({
      workerJobId: input.jobId ?? input.taskId,
      taskId: input.taskId,
      workspacePath: input.workspacePath,
      jobRootDir: input.jobRootDir,
      ...(input.expectedBaseCommit === undefined
        ? {}
        : { expectedBaseCommit: input.expectedBaseCommit }),
    });
    return materialized === null
      ? {
          artifacts: [],
          errorCode: "handoff_patch_empty_for_dirty_workspace",
        }
      : {
          artifacts: materialized.artifacts,
          changedPaths: materialized.changedPaths,
        };
  } catch (error) {
    return {
      artifacts: [],
      errorCode: safeHandoffMaterializationErrorCode(error),
    };
  }
}

function safeHandoffMaterializationErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const code = message.split(":", 1)[0] ?? "";
  return /^handoff_[a-z0-9_]+$/.test(code)
    ? code
    : "handoff_artifact_materialization_failed";
}

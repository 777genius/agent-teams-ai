import { join } from "node:path";
import type {
  RunProgressClassification,
  RuntimeRecommendedAction,
  RuntimeResultArtifact,
  RuntimeResultEnvelope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  createCodexGoalResultRecorder,
  GitPatchPreserver,
} from "./codex-goal-runtime-result-io";
import type { CodexGoalRunConfig } from "./codex-goal-runner";

export async function refreshCompletedCodexGoalResultArtifacts(input: {
  readonly config: Pick<
    CodexGoalRunConfig,
    "jobRootDir" | "jobId" | "outputPath" | "taskId" | "workspacePath"
  >;
  readonly outputPath: string;
  readonly existingResult: RuntimeResultEnvelope;
  readonly changedFiles: readonly string[];
  readonly preservePatch: boolean;
}): Promise<{
  readonly wrote: true;
  readonly reason: string;
  readonly outputPath: string;
  readonly classification?: RunProgressClassification;
  readonly recommendedAction: RuntimeRecommendedAction;
  readonly result: RuntimeResultEnvelope;
}> {
  const artifacts = input.preservePatch && input.changedFiles.length > 0
    ? await refreshedPatchArtifacts(input)
    : input.existingResult.artifacts ?? [];
  const result = await createCodexGoalResultRecorder({
    outputPath: input.outputPath,
  }).record({
    status: "done",
    provider: input.existingResult.provider,
    runId: input.existingResult.runId,
    taskId: input.existingResult.taskId,
    classification: input.existingResult.classification,
    reason: input.existingResult.reason,
    details: input.existingResult.details,
    changedFiles: input.changedFiles,
    evidence: [
      ...input.existingResult.evidence,
      "supervisor_refreshed_terminal_result_artifacts",
      ...artifacts.map((artifact) => `patch_preserved:${artifact.path ?? ""}`),
    ],
    blockers: [],
    nextAction: input.existingResult.nextAction,
    artifacts,
  });
  return {
    wrote: true,
    reason: "terminal_result_artifacts_refreshed",
    outputPath: input.outputPath,
    ...(input.existingResult.classification === undefined
      ? {}
      : { classification: input.existingResult.classification }),
    recommendedAction: input.existingResult.nextAction,
    result,
  };
}

async function refreshedPatchArtifacts(input: {
  readonly config: Pick<
    CodexGoalRunConfig,
    "jobRootDir" | "taskId" | "workspacePath"
  >;
  readonly existingResult: RuntimeResultEnvelope;
}): Promise<readonly RuntimeResultArtifact[]> {
  try {
    const artifact = await new GitPatchPreserver().preserve({
      workspacePath: input.config.workspacePath,
      outputPath: join(
        input.config.jobRootDir,
        `${input.config.taskId}.preserved.patch`,
      ),
    });
    return artifact === null ? input.existingResult.artifacts ?? [] : [artifact];
  } catch {
    return input.existingResult.artifacts ?? [];
  }
}

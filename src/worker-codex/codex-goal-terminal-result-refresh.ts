import type {
  RunProgressClassification,
  RuntimeRecommendedAction,
  RuntimeResultArtifact,
  RuntimeResultEnvelope,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalResultRecorder } from "./codex-goal-runtime-result-io";
import {
  materializeCodexGoalHandoffArtifacts,
} from "./codex-goal-handoff-artifacts";
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
  const handoff = input.preservePatch && input.changedFiles.length > 0
    ? await refreshedHandoffArtifacts(input)
    : null;
  const artifacts = handoff?.artifacts ?? input.existingResult.artifacts ?? [];
  const changedFiles = handoff?.changedPaths ?? input.existingResult.changedFiles;
  const result = await createCodexGoalResultRecorder({
    outputPath: input.outputPath,
  }).record({
    status: "done",
    provider: input.existingResult.provider,
    runId: input.existingResult.runId,
    taskId: input.existingResult.taskId,
    classification: input.existingResult.classification,
    reason: input.existingResult.reason,
    details: {
      ...(input.existingResult.details ?? {}),
      ...(handoff?.baseCommit === undefined
        ? {}
        : { baseCommit: handoff.baseCommit }),
    },
    changedFiles,
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

async function refreshedHandoffArtifacts(input: {
  readonly config: Pick<
    CodexGoalRunConfig,
    "jobRootDir" | "jobId" | "taskId" | "workspacePath"
  >;
  readonly existingResult: RuntimeResultEnvelope;
}): Promise<{
  readonly artifacts: readonly RuntimeResultArtifact[];
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
} | null> {
  const expectedBaseCommit = runtimeResultBaseCommit(input.existingResult);
  const materialized = await materializeCodexGoalHandoffArtifacts({
    workerJobId: input.config.jobId ?? input.config.taskId,
    taskId: input.config.taskId,
    workspacePath: input.config.workspacePath,
    jobRootDir: input.config.jobRootDir,
    ...(expectedBaseCommit === undefined ? {} : { expectedBaseCommit }),
  });
  if (materialized === null) {
    throw new Error("handoff_dirty_workspace_materialized_empty");
  }
  return {
    artifacts: materialized.artifacts,
    baseCommit: materialized.baseCommit,
    changedPaths: materialized.changedPaths,
  };
}

function runtimeResultBaseCommit(
  result: RuntimeResultEnvelope,
): string | undefined {
  const value = result.details?.baseCommit;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

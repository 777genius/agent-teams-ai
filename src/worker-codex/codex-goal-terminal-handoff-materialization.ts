import type { RuntimeResultArtifact } from "@vioxen/subscription-runtime/worker-core";

import type { CodexGoalContinuationWorkspaceFingerprint } from "./codex-goal-continuation-workspace-fingerprint";
import {
  captureCodexGoalContinuationWorkspaceFingerprint,
  materializeCodexGoalHandoffArtifacts,
} from "./codex-goal-handoff-artifacts";
import { sanitizeNodeDependencyEnvironment } from "./dependency-environment-safety";

export type TerminalCodexGoalHandoffMaterialization = {
  readonly artifacts: readonly RuntimeResultArtifact[];
  readonly changedPaths?: readonly string[];
  readonly errorCode?: string;
  readonly continuationFingerprint?: CodexGoalContinuationWorkspaceFingerprint;
};

export async function tryMaterializeTerminalCodexGoalHandoff(input: {
  readonly jobId?: string;
  readonly jobRootDir: string;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly expectedBaseCommit?: string;
}): Promise<TerminalCodexGoalHandoffMaterialization> {
  try {
    // Dependency bootstrap may create worktree-local links to a shared cache.
    // They are execution infrastructure, never authored output. Remove only
    // dependency roots proven unsafe by the bounded dependency scanner before
    // freezing the terminal workspace. All other symlinks still fail closed in
    // handoff materialization.
    await sanitizeNodeDependencyEnvironment({
      workspacePath: input.workspacePath,
    });
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
    const errorCode = safeHandoffMaterializationErrorCode(error);
    const continuationFingerprint = errorCode === "handoff_raw_secret_rejected"
      ? await tryCaptureContinuationFingerprint(input)
      : undefined;
    return {
      artifacts: [],
      errorCode,
      ...(continuationFingerprint
        ? {
            continuationFingerprint,
            changedPaths: continuationFingerprint.changedPaths,
          }
        : {}),
    };
  }
}
export function terminalCodexGoalHandoffResultDetails(
  handoff: TerminalCodexGoalHandoffMaterialization | null,
): Readonly<Record<string, string>> {
  return {
    ...(handoff?.errorCode ? { handoffArtifactError: handoff.errorCode } : {}),
    ...(handoff?.continuationFingerprint
      ? {
          continuationWorkspaceFingerprintSchema:
            handoff.continuationFingerprint.schema,
          continuationWorkspaceFingerprintSha256:
            handoff.continuationFingerprint.sha256,
        }
      : {}),
  };
}

export function terminalCodexGoalHandoffEvidence(
  handoff: TerminalCodexGoalHandoffMaterialization | null,
): readonly string[] {
  return [
    ...(handoff?.errorCode
      ? [`handoff_artifact_materialization_failed:${handoff.errorCode}`]
      : []),
    ...(handoff?.continuationFingerprint
      ? ["continuation_workspace_fingerprint_captured"]
      : []),
  ];
}

async function tryCaptureContinuationFingerprint(input: {
  readonly workspacePath: string;
  readonly expectedBaseCommit?: string;
}): Promise<CodexGoalContinuationWorkspaceFingerprint | undefined> {
  try {
    return (await captureCodexGoalContinuationWorkspaceFingerprint(input)) ??
      undefined;
  } catch {
    return undefined;
  }
}

function safeHandoffMaterializationErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const code = message.split(":", 1)[0] ?? "";
  return /^handoff_[a-z0-9_]+$/.test(code)
    ? code
    : "handoff_artifact_materialization_failed";
}

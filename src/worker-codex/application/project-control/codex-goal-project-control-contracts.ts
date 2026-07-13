import type {
  ProjectAdmissionWorkerRole,
  ProjectControlOperationResult,
} from "@vioxen/subscription-runtime/worker-core";

export type CodexGoalProjectCreateWorktreeInput = {
  readonly sourceWorkspacePath: string;
  readonly realSourceWorkspacePath?: string;
  readonly expectedSourceRealPath: string;
  readonly path: string;
  readonly realPath?: string;
  readonly expectedRealPath?: string;
  readonly expectedRevision: string;
  readonly baseBranch?: string;
  readonly sourceRef?: string;
  readonly newBranch?: string;
  readonly inputPatch?: {
    readonly path: string;
    readonly sha256: string;
    readonly baseCommit: string;
    readonly changedPaths: readonly string[];
  };
  readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
  readonly tags?: readonly string[];
};

export function noopOperationResult(
  resourceId: string,
  safeMessage: string,
): ProjectControlOperationResult {
  return {
    status: "noop",
    resourceId,
    safeMessage,
  };
}

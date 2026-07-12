import type {
  CommitCandidate,
  IntegrationAttempt,
  WorkerOutput,
} from "../domain/integration-attempt";
import type { CommitIdentity } from "./commit-identity-port";

export type GitWorkspaceStatus = {
  readonly branch: string;
  readonly dirtyFiles: readonly string[];
};

export type GitApplyWorkerOutputResult = {
  readonly changedFiles: readonly string[];
};

export type GitDiffCheckResult = {
  readonly ok: boolean;
  readonly safeMessage?: string;
};

export type GitCommitResult = {
  readonly commitSha: string;
  readonly diffStat?: string;
};

export interface GitPort {
  getStatus(input: {
    readonly workspacePath: string;
  }): Promise<GitWorkspaceStatus> | GitWorkspaceStatus;

  applyWorkerOutput(input: {
    readonly attempt: IntegrationAttempt;
    readonly workerOutput: WorkerOutput;
    readonly allowAlreadyApplied?: boolean;
  }): Promise<GitApplyWorkerOutputResult> | GitApplyWorkerOutputResult;

  diffCheck(input: {
    readonly workspacePath: string;
  }): Promise<GitDiffCheckResult> | GitDiffCheckResult;

  commit(input: {
    readonly workspacePath: string;
    readonly message: string;
    readonly files: readonly string[];
    readonly identity: CommitIdentity;
  }): Promise<GitCommitResult> | GitCommitResult;

  push(input: {
    readonly workspacePath: string;
    readonly remote: string;
    readonly branch: string;
    readonly commitSha: string;
    readonly force: boolean;
  }): Promise<void> | void;

  currentBranch(input: {
    readonly workspacePath: string;
  }): Promise<string> | string;
}

export function commitCandidateFromGitResult(input: {
  readonly message: string;
  readonly files: readonly string[];
  readonly secretScanStatus: CommitCandidate["secretScanStatus"];
  readonly createdAt: string;
  readonly result: GitCommitResult;
}): CommitCandidate {
  return {
    commitSha: input.result.commitSha,
    message: input.message,
    files: input.files,
    secretScanStatus: input.secretScanStatus,
    createdAt: input.createdAt,
    ...(input.result.diffStat ? { diffStat: input.result.diffStat } : {}),
  };
}

import {
  IntegrationError,
  IntegrationErrorReason,
  normalizeProjectRelativePath,
  type GitApplyWorkerOutputResult,
  type GitCommitResult,
  type GitWorkspaceStatus,
  type CommitIdentity,
  type IntegrationAttempt,
  type WorkerOutput,
} from "@vioxen/subscription-runtime/worker-core";
import { inspectReviewedMergeScope } from "./project-integration-local-merge-scope";

export type LocalGitMergeWorkerOutput = Pick<WorkerOutput, "workspacePath"> &
  Partial<Omit<WorkerOutput, "workspacePath">>;

export type LocalGitMergeAttempt = Pick<
  IntegrationAttempt,
  "targetWorkspacePath" | "expectedFiles"
> & Partial<Omit<IntegrationAttempt, "targetWorkspacePath" | "expectedFiles">>;

export type LocalGitCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export type LocalGitMergeRuntime = {
  readonly git: (
    args: readonly string[],
    cwd: string,
    env?: Readonly<Record<string, string | undefined>>,
  ) => Promise<LocalGitCommandResult>;
  readonly tryGit: (
    args: readonly string[],
    cwd: string,
    env?: Readonly<Record<string, string | undefined>>,
  ) => Promise<LocalGitCommandResult>;
  readonly gitNullTerminatedPaths: (
    args: readonly string[],
    cwd: string,
  ) => Promise<readonly string[]>;
  readonly getStatus: (
    workspacePath: string,
  ) => Promise<GitWorkspaceStatus>;
  readonly remoteBranchCommit: (input: {
    readonly workspacePath: string;
    readonly remote: string;
    readonly branch: string;
  }) => Promise<string | null>;
  readonly canonicalWorkerPatch: (
    workerOutput: LocalGitMergeWorkerOutput,
  ) => Promise<string>;
  readonly assertPatchSha256: (
    patchPath: string,
    expectedSha256: string | undefined,
  ) => Promise<void>;
  readonly patchChangedFiles: (
    patchPath: string,
    cwd: string,
  ) => Promise<readonly string[]>;
};

const emptyPatchSha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export async function applyReviewedMerge(input: {
  readonly runtime: LocalGitMergeRuntime;
  readonly workspacePath: string;
  readonly workerOutput: LocalGitMergeWorkerOutput;
  readonly attempt: LocalGitMergeAttempt;
  readonly allowAlreadyApplied?: boolean;
}): Promise<GitApplyWorkerOutputResult> {
  const { runtime, workspacePath } = input;
  const merge = input.attempt.merge;
  if (!merge) throw new Error("local_git_integration_merge_plan_required");
  assertSafeMergeRemote(merge.sourceRemote);
  assertSafeMergeBranch(merge.sourceBranch);
  if (!input.workerOutput.workerJobId) {
    throw new Error("local_git_integration_merge_worker_job_required");
  }
  if (!input.workerOutput.changedFiles) {
    throw new Error("local_git_integration_merge_changed_files_required");
  }
  if (
    input.workerOutput.changedFiles.length > 0 &&
    !sameFiles(input.workerOutput.changedFiles, input.attempt.expectedFiles)
  ) {
    throw new Error(
      "local_git_integration_merge_reviewed_conflict_set_mismatch",
    );
  }
  if (input.allowAlreadyApplied === true) {
    throw new Error("local_git_integration_merge_replay_forbidden");
  }
  const status = await runtime.getStatus(workspacePath);
  if (status.dirtyFiles.length > 0) {
    throw new Error("local_git_integration_merge_target_dirty");
  }
  const targetHead = (
    await runtime.git(["rev-parse", "HEAD"], workspacePath)
  ).stdout.trim().toLowerCase();
  if (targetHead !== merge.expectedTargetCommit) {
    throw new Error("local_git_integration_merge_target_head_mismatch");
  }
  const remoteHead = await runtime.remoteBranchCommit({
    workspacePath,
    remote: merge.sourceRemote,
    branch: merge.sourceBranch,
  });
  if (!remoteHead) {
    throw new Error("local_git_integration_merge_source_missing");
  }
  const expectedFetchedHead = remoteHead.toLowerCase();

  let mergeStarted = false;
  try {
    await runtime.git(
      [
        "fetch",
        "--no-tags",
        merge.sourceRemote,
        `refs/heads/${merge.sourceBranch}`,
      ],
      workspacePath,
    );
    const fetchedHead = (
      await runtime.git(["rev-parse", "FETCH_HEAD"], workspacePath)
    ).stdout.trim().toLowerCase();
    if (fetchedHead !== expectedFetchedHead) {
      throw new Error("local_git_integration_merge_fetched_head_mismatch");
    }
    const stableRemoteHead = await runtime.remoteBranchCommit({
      workspacePath,
      remote: merge.sourceRemote,
      branch: merge.sourceBranch,
    });
    if (stableRemoteHead?.toLowerCase() !== fetchedHead) {
      throw new Error("local_git_integration_merge_source_head_changed");
    }
    const sourceExists = await runtime.tryGit(
      ["cat-file", "-e", `${merge.sourceCommit}^{commit}`],
      workspacePath,
    );
    if (sourceExists.exitCode !== 0) {
      throw new Error("local_git_integration_merge_source_commit_unreachable");
    }
    const sourceIsAncestor = await runtime.tryGit(
      ["merge-base", "--is-ancestor", merge.sourceCommit, fetchedHead],
      workspacePath,
    );
    if (sourceIsAncestor.exitCode !== 0) {
      throw new Error("local_git_integration_merge_source_commit_not_ancestor");
    }
    const statusAfterFetch = await runtime.getStatus(workspacePath);
    if (statusAfterFetch.dirtyFiles.length > 0) {
      throw new Error("local_git_integration_merge_target_changed_during_fetch");
    }
    const targetHeadAfterFetch = (
      await runtime.git(["rev-parse", "HEAD"], workspacePath)
    ).stdout.trim().toLowerCase();
    if (targetHeadAfterFetch !== merge.expectedTargetCommit) {
      throw new Error(
        "local_git_integration_merge_target_head_changed_during_fetch",
      );
    }

    const mergeResult = await runtime.tryGit(
      ["merge", "--no-ff", "--no-commit", merge.sourceCommit],
      workspacePath,
    );
    mergeStarted = await hasMergeHead(runtime, workspacePath);
    if (!mergeStarted) {
      throw new Error(
        mergeResult.exitCode === 0
          ? "local_git_integration_merge_conflicts_required"
          : `local_git_integration_merge_start_failed:${safeTail(
              mergeResult.stderr || mergeResult.stdout,
            )}`,
      );
    }
    const conflictFiles = await runtime.gitNullTerminatedPaths(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      workspacePath,
    );
    const mergeFootprint = (await runtime.getStatus(workspacePath)).dirtyFiles;
    if (!includesAllFiles(mergeFootprint, conflictFiles)) {
      throw new Error(
        "local_git_integration_merge_conflicts_missing_from_source_footprint",
      );
    }
    const reviewedScope = await inspectReviewedMergeScope({
      runtime,
      workspacePath,
      targetCommit: merge.expectedTargetCommit,
      sourceCommit: merge.sourceCommit,
      conflictFiles,
      mergeFootprint,
      reviewedFiles: input.workerOutput.changedFiles,
    });
    if (
      reviewedScope.semanticFiles.length > 0 &&
      fetchedHead !== merge.sourceCommit.toLowerCase()
    ) {
      throw new Error(
        "local_git_integration_merge_semantic_source_head_mismatch",
      );
    }
    if (conflictFiles.length === 0 && isTopologyOnlyMerge(input)) {
      if (input.workerOutput.changedFiles.length !== 0) {
        throw new Error(
          "local_git_integration_clean_merge_reviewed_changes_must_be_empty",
        );
      }
      const patchPath = await runtime.canonicalWorkerPatch(input.workerOutput);
      await runtime.assertPatchSha256(patchPath, emptyPatchSha256);
      const sourceFootprint = await runtime.gitNullTerminatedPaths(
        [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          merge.expectedTargetCommit,
          merge.sourceCommit,
        ],
        workspacePath,
      );
      if (!sameFiles(mergeFootprint, sourceFootprint)) {
        throw new Error(
          `local_git_integration_topology_only_footprint_mismatch:expected=${
            uniqueSorted(sourceFootprint).join(",")
          };actual=${uniqueSorted(mergeFootprint).join(",")}`,
        );
      }
      await restoreExactFilesToCommit(
        runtime,
        workspacePath,
        merge.expectedTargetCommit,
        mergeFootprint,
      );
      await assertDiscardedTopologyOnlyMerge({
        runtime,
        workspacePath,
        expectedTargetCommit: merge.expectedTargetCommit,
        expectedSourceCommit: merge.sourceCommit,
      });
      return { changedFiles: [] };
    }
    if (
      conflictFiles.length === 0 &&
      input.workerOutput.changedFiles.length === 0
    ) {
      if (!sameFiles(mergeFootprint, input.attempt.expectedFiles)) {
        throw new Error(
          `local_git_integration_clean_merge_footprint_mismatch:expected=${
            uniqueSorted(input.attempt.expectedFiles).join(",")
          };actual=${uniqueSorted(mergeFootprint).join(",")}`,
        );
      }
      if (input.workerOutput.patchSha256 !== emptyPatchSha256) {
        throw new Error(
          "local_git_integration_clean_merge_empty_patch_hash_required",
        );
      }
      const patchPath = await runtime.canonicalWorkerPatch(input.workerOutput);
      await runtime.assertPatchSha256(patchPath, emptyPatchSha256);
      return { changedFiles: mergeFootprint };
    }
    await restoreFilesToFirstParent(
      runtime,
      workspacePath,
      input.workerOutput.changedFiles,
    );

    const patchPath = await runtime.canonicalWorkerPatch(input.workerOutput);
    await runtime.assertPatchSha256(
      patchPath,
      input.workerOutput.patchSha256,
    );
    const patchFiles = await runtime.patchChangedFiles(patchPath, workspacePath);
    if (!sameFiles(patchFiles, input.workerOutput.changedFiles)) {
      throw new Error(
        `local_git_integration_merge_resolution_set_mismatch:expected=${
          uniqueSorted(input.workerOutput.changedFiles).join(",")
        };actual=${patchFiles.join(",")}`,
      );
    }
    const forwardCheck = await runtime.tryGit(
      ["apply", "--check", "--whitespace=nowarn", patchPath],
      workspacePath,
    );
    if (forwardCheck.exitCode !== 0) {
      throw new Error("local_git_integration_merge_resolution_not_applicable");
    }
    await runtime.assertPatchSha256(
      patchPath,
      input.workerOutput.patchSha256,
    );
    await runtime.git(
      ["apply", "--whitespace=nowarn", patchPath],
      workspacePath,
    );
    const unmerged = await runtime.gitNullTerminatedPaths(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      workspacePath,
    );
    if (unmerged.length > 0) {
      throw new Error(
        `local_git_integration_unresolved_merge:${unmerged.join(",")}`,
      );
    }
    const changedFiles = (await runtime.getStatus(workspacePath)).dirtyFiles;
    const expectedChangedFiles = uniqueSorted([
      ...mergeFootprint,
      ...input.workerOutput.changedFiles,
    ]);
    if (!sameFiles(changedFiles, expectedChangedFiles)) {
      throw new Error(
        `local_git_integration_merge_footprint_changed:expected=${
          expectedChangedFiles.join(",")
        };actual=${uniqueSorted(changedFiles).join(",")}`,
      );
    }
    return { changedFiles };
  } catch (error) {
    if (mergeStarted || await hasMergeHead(runtime, workspacePath)) {
      try {
        await abortPendingMerge(
          runtime,
          workspacePath,
          merge.expectedTargetCommit,
          input.workerOutput.changedFiles,
        );
      } catch (rollbackError) {
        throw new IntegrationError({
          reason: IntegrationErrorReason.MergeRollbackFailed,
          evidence: [safeError(error), safeError(rollbackError)],
        });
      }
    }
    throw error;
  }
}

function isTopologyOnlyMerge(input: {
  readonly workerOutput: LocalGitMergeWorkerOutput;
  readonly attempt: LocalGitMergeAttempt;
}): boolean {
  return input.attempt.expectedFiles.length === 0 &&
    input.workerOutput.changedFiles?.length === 0 &&
    input.workerOutput.patchSha256 === emptyPatchSha256;
}

async function assertDiscardedTopologyOnlyMerge(input: {
  readonly runtime: Pick<
    LocalGitMergeRuntime,
    "git" | "getStatus"
  >;
  readonly workspacePath: string;
  readonly expectedTargetCommit: string;
  readonly expectedSourceCommit: string;
}): Promise<void> {
  const [head, mergeHead, status] = await Promise.all([
    input.runtime.git(["rev-parse", "HEAD"], input.workspacePath),
    input.runtime.git(["rev-parse", "MERGE_HEAD"], input.workspacePath),
    input.runtime.getStatus(input.workspacePath),
  ]);
  if (
    head.stdout.trim().toLowerCase() !==
      input.expectedTargetCommit.toLowerCase() ||
    mergeHead.stdout.trim().toLowerCase() !==
      input.expectedSourceCommit.toLowerCase()
  ) {
    throw new Error(
      "local_git_integration_topology_only_merge_parents_changed",
    );
  }
  if (status.dirtyFiles.length > 0) {
    throw new Error(
      `local_git_integration_topology_only_discard_left_dirty_workspace:${
        uniqueSorted(status.dirtyFiles).join(",")
      }`,
    );
  }
}

export async function abortPendingMerge(
  runtime: Pick<LocalGitMergeRuntime, "git" | "tryGit" | "getStatus">,
  workspacePath: string,
  expectedTargetCommit: string | undefined,
  reviewedConflictFiles: readonly string[] = [],
): Promise<void> {
  const normalizedConflictFiles = uniqueSorted(
    reviewedConflictFiles.map(normalizeProjectRelativePath),
  );
  const mergeInProgress = await hasMergeHead(runtime, workspacePath);
  if (
    mergeInProgress &&
    expectedTargetCommit &&
    normalizedConflictFiles.length > 0
  ) {
    await restoreExactFilesToCommit(
      runtime,
      workspacePath,
      expectedTargetCommit,
      normalizedConflictFiles,
    );
  }
  if (mergeInProgress) {
    await runtime.git(["merge", "--abort"], workspacePath);
  }
  if (expectedTargetCommit) {
    const head = (
      await runtime.git(["rev-parse", "HEAD"], workspacePath)
    ).stdout.trim().toLowerCase();
    if (head !== expectedTargetCommit) {
      throw new Error("local_git_integration_merge_abort_head_mismatch");
    }
    if (normalizedConflictFiles.length > 0) {
      await restoreExactFilesToCommit(
        runtime,
        workspacePath,
        expectedTargetCommit,
        normalizedConflictFiles,
      );
    }
  }
  const status = await runtime.getStatus(workspacePath);
  if (status.dirtyFiles.length > 0) {
    throw new Error("local_git_integration_merge_abort_left_dirty_workspace");
  }
}

async function restoreExactFilesToCommit(
  runtime: Pick<LocalGitMergeRuntime, "git" | "tryGit">,
  workspacePath: string,
  commitSha: string,
  files: readonly string[],
): Promise<void> {
  for (const file of files) {
    const tracked = await runtime.tryGit(
      ["cat-file", "-e", `${commitSha}:${file}`],
      workspacePath,
    );
    if (tracked.exitCode === 0) {
      await runtime.git(["checkout", commitSha, "--", file], workspacePath);
      continue;
    }
    await runtime.git(
      ["rm", "-f", "--ignore-unmatch", "--", file],
      workspacePath,
    );
    await runtime.git(["clean", "-f", "--", file], workspacePath);
  }
}

export async function assertPendingMergeParents(
  runtime: Pick<LocalGitMergeRuntime, "git">,
  workspacePath: string,
  expectedParentCommits: readonly string[],
): Promise<void> {
  if (expectedParentCommits.length !== 2) {
    throw new Error("local_git_integration_merge_parent_count_invalid");
  }
  const [expectedFirst, expectedSecond] = expectedParentCommits.map((commit) =>
    commit.toLowerCase()
  );
  const first = (
    await runtime.git(["rev-parse", "HEAD"], workspacePath)
  ).stdout.trim().toLowerCase();
  const second = (
    await runtime.git(["rev-parse", "MERGE_HEAD"], workspacePath)
  ).stdout.trim().toLowerCase();
  if (first !== expectedFirst || second !== expectedSecond) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.MergeParentsMismatch,
      evidence: [
        `expected:${expectedFirst},${expectedSecond}`,
        `actual:${first},${second}`,
      ],
    });
  }
}

export async function adoptExistingReviewedMergeCommit(input: {
  readonly runtime: Pick<
    LocalGitMergeRuntime,
    "git" | "tryGit" | "gitNullTerminatedPaths"
  >;
  readonly workspacePath: string;
  readonly expectedParentCommits: readonly string[];
  readonly files: readonly string[];
  readonly message: string;
  readonly identity: CommitIdentity;
}): Promise<GitCommitResult | undefined> {
  if (await hasMergeHead(input.runtime, input.workspacePath)) return undefined;
  const commitSha = (
    await input.runtime.git(["rev-parse", "HEAD"], input.workspacePath)
  ).stdout.trim().toLowerCase();
  const parentCommits = await commitParents(
    input.runtime,
    input.workspacePath,
    commitSha,
  );
  if (!sameCommits(parentCommits, input.expectedParentCommits)) {
    return undefined;
  }
  const files = await input.runtime.gitNullTerminatedPaths(
    ["diff", "--name-only", "--no-renames", "-z", `${commitSha}^1`, commitSha],
    input.workspacePath,
  );
  const message = (
    await input.runtime.git(["log", "-1", "--format=%B", commitSha], input.workspacePath)
  ).stdout.trim();
  const identityFields = (
    await input.runtime.git(
      ["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", commitSha],
      input.workspacePath,
    )
  ).stdout.trim().split("\0");
  if (
    !sameFiles(files, input.files) ||
    message !== input.message.trim() ||
    identityFields.length !== 4 ||
    identityFields[0] !== input.identity.name ||
    identityFields[1] !== input.identity.email ||
    identityFields[2] !== input.identity.name ||
    identityFields[3] !== input.identity.email
  ) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.MergeCommitRecoveryMismatch,
      evidence: ["existing_merge_commit_does_not_match_approved_transition"],
    });
  }
  const diffStat = (
    await input.runtime.git(
      ["diff", "--stat", "--no-renames", `${commitSha}^1`, commitSha],
      input.workspacePath,
    )
  ).stdout.trim();
  return {
    commitSha,
    parentCommits,
    ...(diffStat ? { diffStat } : {}),
  };
}

export async function commitParents(
  runtime: Pick<LocalGitMergeRuntime, "git">,
  workspacePath: string,
  commitSha: string,
): Promise<readonly string[]> {
  const fields = (
    await runtime.git(
      ["rev-list", "--parents", "-n", "1", commitSha],
      workspacePath,
    )
  ).stdout.trim().split(/\s+/);
  if (fields[0]?.toLowerCase() !== commitSha.toLowerCase()) {
    throw new Error("local_git_integration_commit_parent_read_invalid");
  }
  return fields.slice(1).map((parent) => parent.toLowerCase());
}

function hasMergeHead(
  runtime: Pick<LocalGitMergeRuntime, "tryGit">,
  workspacePath: string,
): Promise<boolean> {
  return runtime.tryGit(
    ["rev-parse", "--verify", "MERGE_HEAD"],
    workspacePath,
  ).then((result) => result.exitCode === 0);
}

async function restoreFilesToFirstParent(
  runtime: Pick<LocalGitMergeRuntime, "git" | "tryGit">,
  workspacePath: string,
  files: readonly string[],
): Promise<void> {
  for (const file of files) {
    const tracked = await runtime.tryGit(
      ["cat-file", "-e", `HEAD:${file}`],
      workspacePath,
    );
    if (tracked.exitCode === 0) {
      await runtime.git(["checkout", "HEAD", "--", file], workspacePath);
    } else {
      await runtime.git(
        ["rm", "-f", "--ignore-unmatch", "--", file],
        workspacePath,
      );
    }
  }
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = uniqueSorted(left);
  const normalizedRight = uniqueSorted(right);
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((file, index) => file === normalizedRight[index]);
}

function includesAllFiles(
  files: readonly string[],
  requiredFiles: readonly string[],
): boolean {
  const actual = new Set(uniqueSorted(files));
  return uniqueSorted(requiredFiles).every((file) => actual.has(file));
}

function sameCommits(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(
    (commit, index) => commit.toLowerCase() === right[index]?.toLowerCase(),
  );
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function assertSafeMergeRemote(value: string): void {
  if (value.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("local_git_integration_merge_remote_invalid");
  }
}

function assertSafeMergeBranch(value: string): void {
  if (
    value.startsWith("-") ||
    value.includes("..") ||
    /[\s~^:?*\\[\]\x00-\x1f\x7f]/.test(value) ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//")
  ) {
    throw new Error("local_git_integration_merge_branch_invalid");
  }
}

function safeError(error: unknown): string {
  return safeTail(error instanceof Error ? error.message : String(error));
}

function safeTail(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(-500);
}

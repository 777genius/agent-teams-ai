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
> &
  Partial<Omit<IntegrationAttempt, "targetWorkspacePath" | "expectedFiles">>;

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
  readonly getStatus: (workspacePath: string) => Promise<GitWorkspaceStatus>;
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
    !includesAllFiles(
      input.attempt.expectedFiles,
      input.workerOutput.changedFiles,
    )
  ) {
    throw new Error("local_git_integration_merge_patch_outside_reviewed_scope");
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
  ).stdout
    .trim()
    .toLowerCase();
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
  let mergeConflictFiles: readonly string[] = [];
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
    ).stdout
      .trim()
      .toLowerCase();
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
      throw new Error(
        "local_git_integration_merge_target_changed_during_fetch",
      );
    }
    const targetHeadAfterFetch = (
      await runtime.git(["rev-parse", "HEAD"], workspacePath)
    ).stdout
      .trim()
      .toLowerCase();
    if (targetHeadAfterFetch !== merge.expectedTargetCommit) {
      throw new Error(
        "local_git_integration_merge_target_head_changed_during_fetch",
      );
    }

    let appliedSourceCommit = merge.sourceCommit.toLowerCase();
    let mergeState = await startReviewedMerge({
      runtime,
      workspacePath,
      sourceCommit: merge.sourceCommit,
    });
    mergeStarted = true;
    mergeConflictFiles = mergeState.conflictFiles;
    const reviewedScope = await inspectReviewedMergeScope({
      runtime,
      workspacePath,
      targetCommit: merge.expectedTargetCommit,
      sourceCommit: merge.sourceCommit,
      conflictFiles: mergeState.conflictFiles,
      mergeFootprint: mergeState.mergeFootprint,
      approvedFiles: input.attempt.expectedFiles,
      patchFiles: input.workerOutput.changedFiles,
    });
    const sourceDescendant =
      reviewedScope.semanticFiles.length > 0 &&
      fetchedHead !== merge.sourceCommit.toLowerCase();
    const descendantDriftFiles = sourceDescendant
      ? await assertSafeSemanticSourceDescendant({
        runtime,
        workspacePath,
        reviewedSourceCommit: merge.sourceCommit,
        fetchedHead,
        protectedFiles: uniqueSorted([
          ...input.attempt.expectedFiles,
          ...input.workerOutput.changedFiles,
          ...mergeState.conflictFiles,
          ...reviewedScope.semanticFiles,
        ]),
      })
      : [];
    const reviewedConflictFiles = mergeState.conflictFiles;
    const reviewedConflictStages = mergeState.conflictStages;
    const conflictFiles = mergeState.conflictFiles;
    const mergeFootprint = mergeState.mergeFootprint;
    if (
      conflictFiles.length === 0 &&
      input.workerOutput.changedFiles.length === 0
    ) {
      if (!sameFiles(mergeFootprint, input.attempt.expectedFiles)) {
        throw new Error(
          `local_git_integration_clean_merge_footprint_mismatch:expected=${uniqueSorted(
            input.attempt.expectedFiles,
          ).join(",")};actual=${uniqueSorted(mergeFootprint).join(",")}`,
        );
      }
      if (input.workerOutput.patchSha256 !== emptyPatchSha256) {
        throw new Error(
          "local_git_integration_clean_merge_empty_patch_hash_required",
        );
      }
      const patchPath = await runtime.canonicalWorkerPatch(input.workerOutput);
      await runtime.assertPatchSha256(patchPath, emptyPatchSha256);
      return {
        changedFiles: mergeFootprint,
        ...(appliedSourceCommit !== merge.sourceCommit.toLowerCase()
          ? { mergeSourceCommit: appliedSourceCommit }
          : {}),
      };
    }
    const patchPath = await runtime.canonicalWorkerPatch(input.workerOutput);
    await runtime.assertPatchSha256(patchPath, input.workerOutput.patchSha256);
    const patchFiles = await runtime.patchChangedFiles(
      patchPath,
      workspacePath,
    );
    if (!sameFiles(patchFiles, input.workerOutput.changedFiles)) {
      throw new Error(
        `local_git_integration_merge_resolution_set_mismatch:expected=${uniqueSorted(
          input.workerOutput.changedFiles,
        ).join(",")};actual=${patchFiles.join(",")}`,
      );
    }
    await restoreFilesToFirstParent(runtime, workspacePath, conflictFiles);
    const prePatchFiles = (await runtime.getStatus(workspacePath)).dirtyFiles;
    await runtime.assertPatchSha256(patchPath, input.workerOutput.patchSha256);
    const applyResult = await runtime.tryGit(
      ["apply", "--3way", "--whitespace=nowarn", patchPath],
      workspacePath,
    );
    let unmerged = await runtime.gitNullTerminatedPaths(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      workspacePath,
    );
    if (applyResult.exitCode !== 0) {
      if (
        unmerged.length === 0 ||
        !includesAllFiles(patchFiles, unmerged)
      ) {
        throw new Error(
          "local_git_integration_merge_resolution_not_applicable",
        );
      }
      for (const file of unmerged) {
        await restoreExactFilesToCommit(
          runtime,
          workspacePath,
          merge.expectedTargetCommit,
          [file],
        );
        await runtime.assertPatchSha256(
          patchPath,
          input.workerOutput.patchSha256,
        );
        const fallback = await runtime.tryGit(
          [
            "apply",
            "--3way",
            "--whitespace=nowarn",
            `--include=${literalGitApplyPattern(file)}`,
            patchPath,
          ],
          workspacePath,
        );
        if (fallback.exitCode !== 0) {
          throw new Error(
            "local_git_integration_merge_resolution_not_applicable",
          );
        }
      }
      unmerged = await runtime.gitNullTerminatedPaths(
        ["diff", "--name-only", "--diff-filter=U", "-z"],
        workspacePath,
      );
    }
    if (unmerged.length > 0) {
      throw new Error(
        `local_git_integration_unresolved_merge:${unmerged.join(",")}`,
      );
    }
    await runtime.assertPatchSha256(patchPath, input.workerOutput.patchSha256);
    const reverseCheck = await runtime.tryGit(
      [
        "apply",
        "--3way",
        "--reverse",
        "--check",
        "--whitespace=nowarn",
        patchPath,
      ],
      workspacePath,
    );
    if (reverseCheck.exitCode !== 0) {
      throw new Error(
        "local_git_integration_merge_resolution_incomplete",
      );
    }
    const reviewedChangedFiles = (await runtime.getStatus(workspacePath))
      .dirtyFiles;
    const expectedReviewedFiles = uniqueSorted([
      ...prePatchFiles,
      ...input.workerOutput.changedFiles,
    ]);
    if (!sameFiles(reviewedChangedFiles, expectedReviewedFiles)) {
      throw new Error(
        `local_git_integration_merge_footprint_changed:expected=${expectedReviewedFiles.join(
          ",",
        )};actual=${uniqueSorted(reviewedChangedFiles).join(",")}`,
      );
    }
    if (!sourceDescendant) {
      return { changedFiles: reviewedChangedFiles };
    }

    const reviewedResolvedTree = (
      await runtime.git(["write-tree"], workspacePath)
    ).stdout.trim().toLowerCase();
    if (!/^[a-f0-9]{40,64}$/.test(reviewedResolvedTree)) {
      throw new Error("local_git_integration_merge_resolved_tree_invalid");
    }
    const reviewedResolutionFiles = uniqueSorted([
      ...reviewedConflictFiles,
      ...patchFiles,
    ]);
    await abortPendingMerge(
      runtime,
      workspacePath,
      merge.expectedTargetCommit,
      reviewedConflictFiles,
    );
    mergeStarted = false;
    mergeConflictFiles = [];
    const stableDescendantHead = await runtime.remoteBranchCommit({
      workspacePath,
      remote: merge.sourceRemote,
      branch: merge.sourceBranch,
    });
    if (stableDescendantHead?.toLowerCase() !== fetchedHead) {
      throw new Error("local_git_integration_merge_source_head_changed");
    }
    mergeState = await startReviewedMerge({
      runtime,
      workspacePath,
      sourceCommit: fetchedHead,
    });
    mergeStarted = true;
    mergeConflictFiles = mergeState.conflictFiles;
    if (!sameFiles(mergeState.conflictFiles, reviewedConflictFiles)) {
      throw new Error(
        `local_git_integration_merge_semantic_conflict_scope_changed:reviewed=${uniqueSorted(
          reviewedConflictFiles,
        ).join(",")};actual=${uniqueSorted(mergeState.conflictFiles).join(",")}`,
      );
    }
    if (!sameStrings(mergeState.conflictStages, reviewedConflictStages)) {
      throw new Error(
        "local_git_integration_merge_semantic_conflict_stages_changed",
      );
    }
    await inspectReviewedMergeScope({
      runtime,
      workspacePath,
      targetCommit: merge.expectedTargetCommit,
      sourceCommit: fetchedHead,
      conflictFiles: mergeState.conflictFiles,
      mergeFootprint: mergeState.mergeFootprint,
      approvedFiles: input.attempt.expectedFiles,
      patchFiles: input.workerOutput.changedFiles,
    });
    await restoreExactFilesToCommit(
      runtime,
      workspacePath,
      reviewedResolvedTree,
      reviewedResolutionFiles,
    );
    const liveUnmerged = await runtime.gitNullTerminatedPaths(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      workspacePath,
    );
    if (liveUnmerged.length > 0) {
      throw new Error(
        `local_git_integration_unresolved_merge:${liveUnmerged.join(",")}`,
      );
    }
    const changedFiles = (await runtime.getStatus(workspacePath)).dirtyFiles;
    const reviewedFiles = new Set(uniqueSorted(reviewedChangedFiles));
    const driftFiles = new Set(uniqueSorted(descendantDriftFiles));
    const missingReviewedFiles = uniqueSorted(reviewedChangedFiles).filter(
      (file) => !changedFiles.includes(file),
    );
    const unexpectedFiles = uniqueSorted(changedFiles).filter(
      (file) => !reviewedFiles.has(file) && !driftFiles.has(file),
    );
    if (missingReviewedFiles.length > 0 || unexpectedFiles.length > 0) {
      throw new Error(
        `local_git_integration_merge_descendant_footprint_changed:missing=${missingReviewedFiles.join(
          ",",
        )};unexpected=${unexpectedFiles.join(",")}`,
      );
    }
    appliedSourceCommit = fetchedHead;
    return {
      changedFiles,
      ...(appliedSourceCommit !== merge.sourceCommit.toLowerCase()
        ? { mergeSourceCommit: appliedSourceCommit }
        : {}),
    };
  } catch (error) {
    if (mergeStarted || (await hasMergeHead(runtime, workspacePath))) {
      try {
        await abortPendingMerge(
          runtime,
          workspacePath,
          merge.expectedTargetCommit,
          mergeConflictFiles,
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

async function startReviewedMerge(input: {
  readonly runtime: LocalGitMergeRuntime;
  readonly workspacePath: string;
  readonly sourceCommit: string;
}): Promise<{
  readonly conflictFiles: readonly string[];
  readonly conflictStages: readonly string[];
  readonly mergeFootprint: readonly string[];
}> {
  const mergeResult = await input.runtime.tryGit(
    ["merge", "--no-ff", "--no-commit", input.sourceCommit],
    input.workspacePath,
  );
  if (!(await hasMergeHead(input.runtime, input.workspacePath))) {
    throw new Error(
      mergeResult.exitCode === 0
        ? "local_git_integration_merge_conflicts_required"
        : `local_git_integration_merge_start_failed:${safeTail(
            mergeResult.stderr || mergeResult.stdout,
          )}`,
    );
  }
  const conflictFiles = await input.runtime.gitNullTerminatedPaths(
    ["diff", "--name-only", "--diff-filter=U", "-z"],
    input.workspacePath,
  );
  const mergeFootprint = (await input.runtime.getStatus(input.workspacePath))
    .dirtyFiles;
  if (!includesAllFiles(mergeFootprint, conflictFiles)) {
    throw new Error(
      "local_git_integration_merge_conflicts_missing_from_source_footprint",
    );
  }
  const conflictStages = await readConflictStages(
    input.runtime,
    input.workspacePath,
    conflictFiles,
  );
  return { conflictFiles, conflictStages, mergeFootprint };
}

async function readConflictStages(
  runtime: Pick<LocalGitMergeRuntime, "git">,
  workspacePath: string,
  conflictFiles: readonly string[],
): Promise<readonly string[]> {
  if (conflictFiles.length === 0) return [];
  const allowedFiles = new Set(uniqueSorted(conflictFiles));
  const records = (
    await runtime.git(
      ["ls-files", "--unmerged", "--stage", "-z", "--", ...conflictFiles],
      workspacePath,
    )
  ).stdout.split("\0").filter(Boolean).map((record) => {
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([123])\t(.+)$/i.exec(record);
    if (!match) {
      throw new Error("local_git_integration_merge_conflict_stage_invalid");
    }
    const file = normalizeProjectRelativePath(match[4]!);
    if (!allowedFiles.has(file)) {
      throw new Error(
        "local_git_integration_merge_conflict_stage_outside_scope",
      );
    }
    return `${file}\t${match[3]}\t${match[1]}\t${match[2]!.toLowerCase()}`;
  });
  if (!includesAllFiles(
    records.map((record) => record.split("\t", 1)[0]!),
    conflictFiles,
  )) {
    throw new Error("local_git_integration_merge_conflict_stage_missing");
  }
  return [...new Set(records)].sort();
}

async function assertSafeSemanticSourceDescendant(input: {
  readonly runtime: Pick<LocalGitMergeRuntime, "gitNullTerminatedPaths">;
  readonly workspacePath: string;
  readonly reviewedSourceCommit: string;
  readonly fetchedHead: string;
  readonly protectedFiles: readonly string[];
}): Promise<readonly string[]> {
  const driftFiles = await input.runtime.gitNullTerminatedPaths(
    [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      input.reviewedSourceCommit,
      input.fetchedHead,
      "--",
    ],
    input.workspacePath,
  );
  const protectedFiles = new Set(uniqueSorted(input.protectedFiles));
  const touchedProtectedFiles = uniqueSorted(driftFiles).filter((file) =>
    protectedFiles.has(file),
  );
  if (touchedProtectedFiles.length > 0) {
    throw new Error(
      `local_git_integration_merge_semantic_descendant_touched_reviewed_scope:${touchedProtectedFiles.join(
        ",",
      )}`,
    );
  }
  return uniqueSorted(driftFiles);
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
    ).stdout
      .trim()
      .toLowerCase();
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
    commit.toLowerCase(),
  );
  const first = (await runtime.git(["rev-parse", "HEAD"], workspacePath)).stdout
    .trim()
    .toLowerCase();
  const second = (
    await runtime.git(["rev-parse", "MERGE_HEAD"], workspacePath)
  ).stdout
    .trim()
    .toLowerCase();
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
  ).stdout
    .trim()
    .toLowerCase();
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
    await input.runtime.git(
      ["log", "-1", "--format=%B", commitSha],
      input.workspacePath,
    )
  ).stdout.trim();
  const identityFields = (
    await input.runtime.git(
      ["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", commitSha],
      input.workspacePath,
    )
  ).stdout
    .trim()
    .split("\0");
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
  ).stdout
    .trim()
    .split(/\s+/);
  if (fields[0]?.toLowerCase() !== commitSha.toLowerCase()) {
    throw new Error("local_git_integration_commit_parent_read_invalid");
  }
  return fields.slice(1).map((parent) => parent.toLowerCase());
}

function hasMergeHead(
  runtime: Pick<LocalGitMergeRuntime, "tryGit">,
  workspacePath: string,
): Promise<boolean> {
  return runtime
    .tryGit(["rev-parse", "--verify", "MERGE_HEAD"], workspacePath)
    .then((result) => result.exitCode === 0);
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
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((file, index) => file === normalizedRight[index])
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function literalGitApplyPattern(file: string): string {
  return file.replace(/[\\*?[\]]/g, "\\$&");
}

function includesAllFiles(
  files: readonly string[],
  requiredFiles: readonly string[],
): boolean {
  const actual = new Set(uniqueSorted(files));
  return uniqueSorted(requiredFiles).every((file) => actual.has(file));
}

function sameCommits(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (commit, index) => commit.toLowerCase() === right[index]?.toLowerCase(),
    )
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

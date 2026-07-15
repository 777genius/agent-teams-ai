import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  integrationAppliedFiles,
  normalizeProjectRelativePath,
  type IntegrationAttempt,
} from "@vioxen/subscription-runtime/worker-core";

import type { LocalGitMergeRuntime } from "./project-integration-local-merge-coordinator";

export type LocalGitOutputRollbackRuntime = Pick<
  LocalGitMergeRuntime,
  | "git"
  | "tryGit"
  | "getStatus"
  | "canonicalWorkerPatch"
  | "assertPatchSha256"
>;

type LocalOutputState = "applied" | "target";

export function localWorkerOutputTargetCommit(output: {
  readonly targetCommit?: string;
  readonly baseCommit?: string;
}): string {
  const commit = output.targetCommit ?? output.baseCommit;
  if (!commit || !/^[a-f0-9]{40}$/i.test(commit)) {
    throw new Error("local_git_integration_output_rollback_target_required");
  }
  return commit.toLowerCase();
}

export async function inspectLocalPatchOutputTree(input: {
  readonly runtime: LocalGitOutputRollbackRuntime;
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly patchPath: string;
}): Promise<{
  readonly targetTree: string;
  readonly outputTree: string;
  readonly changedFiles: readonly string[];
}> {
  const [targetTree, outputTree] = await Promise.all([
    resolveTree(input.runtime, input.workspacePath, input.baseCommit),
    writeTemporaryIndexTree({
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      baseCommit: input.baseCommit,
      patchPath: input.patchPath,
    }),
  ]);
  return {
    targetTree,
    outputTree,
    changedFiles: await treeChangedFiles({
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      baseTree: targetTree,
      outputTree,
    }),
  };
}

export async function rollbackLocalWorkerOutput(input: {
  readonly runtime: LocalGitOutputRollbackRuntime;
  readonly workspacePath: string;
  readonly attempt: IntegrationAttempt;
}): Promise<void> {
  if (input.attempt.merge) {
    throw new Error("local_git_integration_output_rollback_merge_forbidden");
  }
  const expectedCommit = localWorkerOutputTargetCommit(
    input.attempt.workerOutput,
  );
  await assertRollbackTarget({ ...input, expectedCommit });
  const status = await input.runtime.getStatus(input.workspacePath);
  const appliedFiles = integrationAppliedFiles(input.attempt);
  if (hasFilesOutside(status.dirtyFiles, appliedFiles)) {
    throw new Error("local_git_integration_output_rollback_dirty_mismatch");
  }
  if (input.attempt.workerOutput.commitSha) {
    const state = await commitOutputState({
      ...input,
      appliedFiles,
      commitSha: input.attempt.workerOutput.commitSha,
      expectedCommit,
    });
    if (state === "applied") {
      await input.runtime.git([
        "restore",
        `--source=${expectedCommit}`,
        "--staged",
        "--worktree",
        "--",
        ...appliedFiles,
      ], input.workspacePath);
    }
    if (await commitOutputState({
      ...input,
      appliedFiles,
      commitSha: input.attempt.workerOutput.commitSha,
      expectedCommit,
    }) !== "target") {
      throw new Error("local_git_integration_output_rollback_not_restored");
    }
  } else if (input.attempt.workerOutput.patchPath) {
    await reverseImmutableWorkerPatch({
      ...input,
      appliedFiles,
      expectedCommit,
    });
  } else {
    throw new Error("local_git_integration_output_rollback_source_required");
  }
  await assertRollbackTarget({
    ...input,
    expectedCommit,
    requireClean: true,
  });
}

async function reverseImmutableWorkerPatch(input: {
  readonly runtime: LocalGitOutputRollbackRuntime;
  readonly workspacePath: string;
  readonly attempt: IntegrationAttempt;
  readonly appliedFiles: readonly string[];
  readonly expectedCommit: string;
}): Promise<void> {
  const patchPath = await input.runtime.canonicalWorkerPatch(
    input.attempt.workerOutput,
  );
  const patchSha256 = input.attempt.workerOutput.patchSha256;
  if (!patchSha256) {
    throw new Error("local_git_integration_patch_hash_required");
  }
  await input.runtime.assertPatchSha256(patchPath, patchSha256);
  const state = await patchOutputState({
    ...input,
    patchPath,
  });
  if (state === "target") return;
  const reverseCheck = await input.runtime.tryGit(
    ["apply", "--reverse", "--check", "--whitespace=nowarn", patchPath],
    input.workspacePath,
  );
  if (reverseCheck.exitCode !== 0) {
    throw new Error("local_git_integration_output_rollback_patch_not_applied");
  }
  await input.runtime.assertPatchSha256(patchPath, patchSha256);
  await input.runtime.git(
    ["apply", "--reverse", "--whitespace=nowarn", patchPath],
    input.workspacePath,
  );
  if (await patchOutputState({
    ...input,
    patchPath,
  }) !== "target") {
    throw new Error("local_git_integration_output_rollback_not_restored");
  }
}

async function patchOutputState(input: {
  readonly runtime: LocalGitOutputRollbackRuntime;
  readonly workspacePath: string;
  readonly appliedFiles: readonly string[];
  readonly expectedCommit: string;
  readonly patchPath: string;
}): Promise<LocalOutputState> {
  const [patchOutput, indexTree, currentWorktreeTree] =
    await Promise.all([
      inspectLocalPatchOutputTree({
        runtime: input.runtime,
        workspacePath: input.workspacePath,
        baseCommit: input.expectedCommit,
        patchPath: input.patchPath,
      }),
      writeIndexTree(input.runtime, input.workspacePath),
      writeTemporaryIndexTree({
        runtime: input.runtime,
        workspacePath: input.workspacePath,
        baseCommit: input.expectedCommit,
        worktreeFiles: input.appliedFiles,
      }),
    ]);
  if (!sameFiles(patchOutput.changedFiles, input.appliedFiles)) {
    throw new Error("local_git_integration_output_rollback_patch_mismatch");
  }
  if (
    indexTree === patchOutput.targetTree &&
    currentWorktreeTree === patchOutput.targetTree
  ) {
    return "target";
  }
  if (indexTree !== patchOutput.targetTree) {
    throw new Error(
      "local_git_integration_output_rollback_patch_index_mismatch",
    );
  }
  if (patchOutput.outputTree !== currentWorktreeTree) {
    throw new Error(
      "local_git_integration_output_rollback_patch_not_exactly_applied",
    );
  }
  return "applied";
}

async function assertRollbackTarget(input: {
  readonly runtime: LocalGitOutputRollbackRuntime;
  readonly workspacePath: string;
  readonly attempt: IntegrationAttempt;
  readonly expectedCommit: string;
  readonly requireClean?: boolean;
}): Promise<void> {
  const [head, status] = await Promise.all([
    input.runtime.git(["rev-parse", "HEAD"], input.workspacePath),
    input.runtime.getStatus(input.workspacePath),
  ]);
  if (head.stdout.trim().toLowerCase() !== input.expectedCommit) {
    throw new Error("local_git_integration_output_rollback_head_mismatch");
  }
  if (status.branch !== input.attempt.targetBranch) {
    throw new Error("local_git_integration_output_rollback_branch_mismatch");
  }
  if (input.requireClean && status.dirtyFiles.length > 0) {
    throw new Error("local_git_integration_output_rollback_not_clean");
  }
}

async function commitOutputState(input: {
  readonly runtime: LocalGitOutputRollbackRuntime;
  readonly workspacePath: string;
  readonly appliedFiles: readonly string[];
  readonly commitSha: string;
  readonly expectedCommit: string;
}): Promise<LocalOutputState> {
  if (!/^[a-f0-9]{40}$/i.test(input.commitSha)) {
    throw new Error("local_git_integration_output_rollback_commit_invalid");
  }
  const commitSha = input.commitSha.toLowerCase();
  const revision = await input.runtime.git(
    ["rev-list", "--parents", "-n", "1", commitSha],
    input.workspacePath,
  );
  const revisionParts = revision.stdout.trim().toLowerCase().split(/\s+/u);
  if (
    revisionParts.length !== 2 ||
    revisionParts[0] !== commitSha ||
    revisionParts[1] !== input.expectedCommit
  ) {
    throw new Error(
      "local_git_integration_output_rollback_commit_parent_mismatch",
    );
  }
  const [targetTree, commitTree, indexTree, currentWorktreeTree] =
    await Promise.all([
      resolveTree(input.runtime, input.workspacePath, input.expectedCommit),
      resolveTree(input.runtime, input.workspacePath, commitSha),
      writeIndexTree(input.runtime, input.workspacePath),
      writeTemporaryIndexTree({
        runtime: input.runtime,
        workspacePath: input.workspacePath,
        baseCommit: input.expectedCommit,
        worktreeFiles: input.appliedFiles,
      }),
    ]);
  const commitFiles = await treeChangedFiles({
    runtime: input.runtime,
    workspacePath: input.workspacePath,
    baseTree: targetTree,
    outputTree: commitTree,
  });
  if (!sameFiles(commitFiles, input.appliedFiles)) {
    throw new Error(
      "local_git_integration_output_rollback_commit_files_mismatch",
    );
  }
  if (indexTree === targetTree && currentWorktreeTree === targetTree) {
    return "target";
  }
  if (indexTree !== commitTree) {
    throw new Error(
      "local_git_integration_output_rollback_commit_index_mismatch",
    );
  }
  if (currentWorktreeTree !== commitTree) {
    throw new Error(
      "local_git_integration_output_rollback_commit_not_exactly_applied",
    );
  }
  return "applied";
}

async function resolveTree(
  runtime: LocalGitOutputRollbackRuntime,
  workspacePath: string,
  revision: string,
): Promise<string> {
  return (await runtime.git(
    ["rev-parse", `${revision}^{tree}`],
    workspacePath,
  )).stdout.trim().toLowerCase();
}

async function writeIndexTree(
  runtime: LocalGitOutputRollbackRuntime,
  workspacePath: string,
): Promise<string> {
  return (await runtime.git(["write-tree"], workspacePath))
    .stdout.trim().toLowerCase();
}

async function writeTemporaryIndexTree(input: {
  readonly runtime: LocalGitOutputRollbackRuntime;
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly patchPath?: string;
  readonly worktreeFiles?: readonly string[];
}): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), "integration-output-tree-"));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(tempRoot, "index"),
  };
  try {
    await input.runtime.git(
      ["read-tree", input.baseCommit],
      input.workspacePath,
      env,
    );
    if (input.patchPath) {
      await input.runtime.git(
        ["apply", "--cached", "--whitespace=nowarn", input.patchPath],
        input.workspacePath,
        env,
      );
    } else if (input.worktreeFiles) {
      // Reconstruct every tracked worktree path from a clean target index so
      // skip-worktree/assume-unchanged cannot hide unrelated tracked tampering.
      await input.runtime.git(
        ["-c", "core.fileMode=true", "add", "-u", "--", "."],
        input.workspacePath,
        env,
      );
      for (const rawFile of input.worktreeFiles) {
        const file = normalizeProjectRelativePath(rawFile);
        if (await pathExists(join(input.workspacePath, file))) {
          await input.runtime.git(
            ["-c", "core.fileMode=true", "add", "-f", "--", file],
            input.workspacePath,
            env,
          );
        } else {
          await input.runtime.git(
            ["update-index", "--force-remove", "--", file],
            input.workspacePath,
            env,
          );
        }
      }
    } else {
      throw new Error("local_git_integration_output_tree_source_required");
    }
    return (await input.runtime.git(
      ["write-tree"],
      input.workspacePath,
      env,
    )).stdout.trim().toLowerCase();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" && error !== null && "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function treeChangedFiles(input: {
  readonly runtime: LocalGitOutputRollbackRuntime;
  readonly workspacePath: string;
  readonly baseTree: string;
  readonly outputTree: string;
}): Promise<readonly string[]> {
  const result = await input.runtime.git([
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    input.baseTree,
    input.outputTree,
  ], input.workspacePath);
  return result.stdout.split("\0").filter((file) => file.length > 0);
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = uniqueSorted(left.map(normalizeProjectRelativePath));
  const normalizedRight = uniqueSorted(right.map(normalizeProjectRelativePath));
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((file, index) => file === normalizedRight[index]);
}

function hasFilesOutside(
  observed: readonly string[],
  allowed: readonly string[],
): boolean {
  const allowedFiles = new Set(allowed.map(normalizeProjectRelativePath));
  return observed
    .map(normalizeProjectRelativePath)
    .some((file) => !allowedFiles.has(file));
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

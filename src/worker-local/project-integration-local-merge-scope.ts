import { normalizeProjectRelativePath } from "@vioxen/subscription-runtime/worker-core";

type MergeScopeGitRuntime = {
  readonly git: (
    args: readonly string[],
    cwd: string,
  ) => Promise<{ readonly stdout: string }>;
  readonly gitNullTerminatedPaths: (
    args: readonly string[],
    cwd: string,
  ) => Promise<readonly string[]>;
};

export type ReviewedMergeScope = {
  readonly parentFootprint: readonly string[];
  readonly semanticFiles: readonly string[];
};

export async function inspectReviewedMergeScope(input: {
  readonly runtime: MergeScopeGitRuntime;
  readonly workspacePath: string;
  readonly targetCommit: string;
  readonly sourceCommit: string;
  readonly conflictFiles: readonly string[];
  readonly mergeFootprint: readonly string[];
  readonly approvedFiles: readonly string[];
  readonly patchFiles: readonly string[];
}): Promise<ReviewedMergeScope> {
  const conflicts = uniqueSorted(input.conflictFiles);
  const approved = uniqueSorted(input.approvedFiles);
  const missingConflicts = conflicts.filter((file) => !approved.includes(file));
  if (missingConflicts.length > 0) {
    throw new Error(
      `local_git_integration_merge_conflicts_missing_from_reviewed_scope:${missingConflicts.join(
        ",",
      )}`,
    );
  }

  const semanticFiles = uniqueSorted(input.patchFiles).filter(
    (file) => !conflicts.includes(file),
  );
  if (semanticFiles.length === 0) {
    return {
      parentFootprint: uniqueSorted(input.mergeFootprint),
      semanticFiles,
    };
  }

  const mergeBases = (
    await input.runtime.git(
      ["merge-base", "--all", input.targetCommit, input.sourceCommit],
      input.workspacePath,
    )
  ).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (mergeBases.length !== 1 || !/^[a-f0-9]{40}$/i.test(mergeBases[0]!)) {
    throw new Error("local_git_integration_merge_base_not_unique");
  }
  const mergeBase = mergeBases[0]!;
  const parentFootprint = uniqueSorted([
    ...(await input.runtime.gitNullTerminatedPaths(
      [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        mergeBase,
        input.targetCommit,
      ],
      input.workspacePath,
    )),
    ...(await input.runtime.gitNullTerminatedPaths(
      [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        mergeBase,
        input.sourceCommit,
      ],
      input.workspacePath,
    )),
  ]);
  const parentPaths = new Set(parentFootprint);
  const unexpectedMergeFiles = uniqueSorted(input.mergeFootprint).filter(
    (file) => !parentPaths.has(file),
  );
  if (unexpectedMergeFiles.length > 0) {
    throw new Error(
      `local_git_integration_merge_footprint_outside_parent_delta:${unexpectedMergeFiles.join(
        ",",
      )}`,
    );
  }
  return { parentFootprint, semanticFiles };
}

function uniqueSorted(files: readonly string[]): string[] {
  return [...new Set(files.map(normalizeProjectRelativePath))].sort();
}

import type { ProjectControlOperationResult } from "@vioxen/subscription-runtime/worker-core";
import { execGit, execGitStdout } from "../../codex-goal-mcp-project-git";

export type CodexGoalProjectPushBranchInput = {
  readonly workspacePath: string;
  readonly realWorkspacePath?: string;
  readonly branch: string;
  readonly remote: string;
  readonly force: boolean;
};

export enum ProjectControlPushOutcome {
  UpToDate = "up_to_date",
  FastForwarded = "fast_forwarded",
  RemoteChanged = "remote_changed",
}

export type ProjectControlPushBranchResult = ProjectControlOperationResult & {
  readonly outcome: ProjectControlPushOutcome;
  readonly localCommit: string;
  readonly remoteCommitBefore: string | null;
  readonly remoteCommitAfter: string | null;
};

export async function pushProjectBranch(
  input: CodexGoalProjectPushBranchInput,
): Promise<ProjectControlPushBranchResult> {
  const localCommit = (
    await execGitStdout([
      "-C",
      input.workspacePath,
      "rev-parse",
      "--verify",
      `refs/heads/${input.branch}^{commit}`,
    ])
  ).trim();
  assertFullCommit(localCommit, "project_control_push_local_commit_invalid");
  const remoteCommitBefore = await remoteBranchCommit(input);
  const resourceId = `${input.remote}/${input.branch}`;

  if (remoteCommitBefore === localCommit) {
    const remoteCommitAfter = await remoteBranchCommit(input);
    return pushResult({
      status: "noop",
      resourceId,
      outcome:
        remoteCommitAfter === localCommit
          ? ProjectControlPushOutcome.UpToDate
          : ProjectControlPushOutcome.RemoteChanged,
      localCommit,
      remoteCommitBefore,
      remoteCommitAfter,
    });
  }

  const remoteCanFastForward =
    remoteCommitBefore === null ||
    (await isAncestor(input.workspacePath, remoteCommitBefore, localCommit));
  let pushError: unknown;
  let pushSucceeded = false;
  try {
    await execGit([
      "-C",
      input.workspacePath,
      "push",
      ...(input.force
        ? [
            `--force-with-lease=refs/heads/${input.branch}:${remoteCommitBefore ?? ""}`,
          ]
        : []),
      input.remote,
      `refs/heads/${input.branch}:refs/heads/${input.branch}`,
    ]);
    pushSucceeded = true;
  } catch (error) {
    pushError = error;
  }

  const remoteCommitAfter = await remoteBranchCommit(input);
  if (remoteCommitAfter === localCommit) {
    return pushResult({
      status: "applied",
      resourceId,
      outcome: ProjectControlPushOutcome.FastForwarded,
      localCommit,
      remoteCommitBefore,
      remoteCommitAfter,
    });
  }
  if (
    pushSucceeded ||
    remoteCommitAfter !== remoteCommitBefore ||
    !remoteCanFastForward
  ) {
    return pushResult({
      status: "noop",
      resourceId,
      outcome: ProjectControlPushOutcome.RemoteChanged,
      localCommit,
      remoteCommitBefore,
      remoteCommitAfter,
    });
  }
  if (pushError instanceof Error) throw pushError;
  throw new Error("project_control_push_failed_without_error");
}

async function isAncestor(
  workspacePath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await execGit([
      "-C",
      workspacePath,
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function remoteBranchCommit(
  input: CodexGoalProjectPushBranchInput,
): Promise<string | null> {
  const ref = `refs/heads/${input.branch}`;
  const output = (
    await execGitStdout([
      "-C",
      input.workspacePath,
      "ls-remote",
      "--refs",
      input.remote,
      ref,
    ])
  ).trim();
  if (!output) return null;
  const lines = output.split("\n");
  const fields = lines[0]!.trim().split(/\s+/);
  if (lines.length !== 1 || fields.length !== 2 || fields[1] !== ref) {
    throw new Error("project_control_push_remote_ref_invalid");
  }
  const commit = fields[0]!;
  assertFullCommit(commit, "project_control_push_remote_commit_invalid");
  return commit;
}

function assertFullCommit(value: string, errorCode: string): void {
  if (!/^[a-f0-9]{40}$/i.test(value)) throw new Error(errorCode);
}

function pushResult(
  input: Omit<ProjectControlPushBranchResult, "safeMessage">,
): ProjectControlPushBranchResult {
  return {
    ...input,
    safeMessage: `project_control_push_${input.outcome}`,
  };
}

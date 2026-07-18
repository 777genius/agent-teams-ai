import {
  assertGitCurrentBranch,
  execGit,
  execGitStdout,
  resolveCanonicalRemoteHead,
} from "./codex-goal-project-git";

export type ProjectExternalRewriteRecovery = {
  readonly expectedRemoteCommit: string;
  readonly expectedLocalCommit: string;
};

export type ProjectBranchPushInput = {
  readonly workspacePath: string;
  readonly branch: string;
  readonly remote: string;
  readonly force: boolean;
  readonly expectedRemoteCommit?: string;
  readonly expectedLocalCommit?: string;
  readonly confirmExternalRewriteRecovery?: boolean;
};

type ProjectExternalRewriteRecoveryRequest = {
  readonly force: boolean;
  readonly expectedRemoteCommit: string | undefined;
  readonly expectedLocalCommit: string | undefined;
  readonly confirmExternalRewriteRecovery: boolean;
};

export function resolveProjectExternalRewriteRecovery(
  input: ProjectExternalRewriteRecoveryRequest,
): ProjectExternalRewriteRecovery | undefined {
  const requested = input.expectedRemoteCommit !== undefined ||
    input.expectedLocalCommit !== undefined ||
    input.confirmExternalRewriteRecovery === true;
  if (!requested) return undefined;
  if (input.confirmExternalRewriteRecovery !== true) {
    throw new Error("project_control_confirm_external_rewrite_recovery_required");
  }
  if (!input.force) {
    throw new Error("project_control_external_rewrite_recovery_force_required");
  }
  if (!input.expectedRemoteCommit || !isFullSha1(input.expectedRemoteCommit)) {
    throw new Error("project_control_expected_remote_commit_invalid");
  }
  if (!input.expectedLocalCommit || !isFullSha1(input.expectedLocalCommit)) {
    throw new Error("project_control_expected_local_commit_invalid");
  }
  return {
    expectedRemoteCommit: input.expectedRemoteCommit.toLowerCase(),
    expectedLocalCommit: input.expectedLocalCommit.toLowerCase(),
  };
}

export async function pushProjectBranch(
  input: ProjectBranchPushInput,
): Promise<void> {
  const recovery = resolveProjectExternalRewriteRecovery({
    force: input.force,
    expectedRemoteCommit: input.expectedRemoteCommit,
    expectedLocalCommit: input.expectedLocalCommit,
    confirmExternalRewriteRecovery: input.confirmExternalRewriteRecovery === true,
  });
  await assertGitCurrentBranch(input);
  if (recovery) {
    const localHead = (await execGitStdout([
      "-C",
      input.workspacePath,
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ])).trim().toLowerCase();
    if (localHead !== recovery.expectedLocalCommit) {
      throw new Error("project_control_external_rewrite_local_commit_mismatch");
    }
    const remoteHead = await resolveCanonicalRemoteHead({
      workspacePath: input.workspacePath,
      remoteTrackingRef: `${input.remote}/${input.branch}`,
    });
    if (remoteHead.oid !== recovery.expectedRemoteCommit) {
      throw new Error("project_control_external_rewrite_remote_commit_mismatch");
    }
  }
  await execGit([
    "-C",
    input.workspacePath,
    "push",
    ...(recovery
      ? [`--force-with-lease=refs/heads/${input.branch}:${recovery.expectedRemoteCommit}`]
      : input.force
        ? ["--force-with-lease"]
        : []),
    input.remote,
    `HEAD:refs/heads/${input.branch}`,
  ]);
}

function isFullSha1(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

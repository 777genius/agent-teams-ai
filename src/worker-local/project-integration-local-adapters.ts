import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";

import {
  abortPendingMerge,
  adoptExistingReviewedMergeCommit,
  applyReviewedMerge,
  assertPendingMergeParents,
  commitParents,
  type LocalGitMergeRuntime,
} from "./project-integration-local-merge-coordinator";
import {
  inspectLocalPatchOutputTree,
  localWorkerOutputTargetCommit,
  rollbackLocalWorkerOutput,
} from "./project-integration-local-output-rollback";

import { LocalFileWorkspaceLockStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  CheckRunStatus,
  IntegrationAttemptStatus,
  IntegrationError,
  IntegrationErrorReason,
  assertCommitIdentity,
  assertFilesWithinExpected,
  normalizeProjectRelativePath,
  type CheckRun,
  type CheckRunnerPort,
  type CommitIdentity,
  type CommitIdentityPort,
  type GitApplyWorkerOutputResult,
  type GitCommitResult,
  type GitDiffCheckResult,
  type GitPort,
  type GitWorkspaceStatus,
  type IntegrationAttempt,
  type WorkspaceLock,
  type WorkspaceLockPort,
  type WorkerOutput,
} from "@vioxen/subscription-runtime/worker-core";

const execFileAsync = promisify(execFile);

export type LocalGitIntegrationAdapterOptions = {
  readonly gitBinaryPath?: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly allowedPatchRoots?: readonly string[];
  readonly workerJobRootParent?: string;
  readonly controllerArchiveRoot?: string;
};

type LocalGitWorkerOutput = Pick<WorkerOutput, "workspacePath"> &
  Partial<Omit<WorkerOutput, "workspacePath">>;

type LocalGitAttempt = Pick<
  IntegrationAttempt,
  "targetWorkspacePath" | "expectedFiles"
> & Partial<Omit<IntegrationAttempt, "targetWorkspacePath" | "expectedFiles">>;

export class LocalGitIntegrationAdapter implements GitPort {
  constructor(
    private readonly options: LocalGitIntegrationAdapterOptions = {},
  ) {}

  async getStatus(input: {
    readonly workspacePath: string;
  }): Promise<GitWorkspaceStatus> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    const branch = (
      await this.git(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath)
    ).stdout.trim();
    const dirtyFiles = uniqueSorted([
      ...(await this.gitLines(["diff", "--name-only"], workspacePath)),
      ...(await this.gitLines(
        ["diff", "--cached", "--name-only"],
        workspacePath,
      )),
      ...(await this.gitLines(
        ["ls-files", "--others", "--exclude-standard"],
        workspacePath,
      )),
    ]).map(normalizeProjectRelativePath);
    return { branch, dirtyFiles };
  }

  async applyWorkerOutput(input: {
    readonly workerOutput: LocalGitWorkerOutput;
    readonly attempt: LocalGitAttempt;
    readonly allowAlreadyApplied?: boolean;
  }): Promise<GitApplyWorkerOutputResult> {
    if (input.attempt.merge) {
      return applyReviewedMerge({
        runtime: this.mergeRuntime(),
        workspacePath: await canonicalDirectory(
          input.attempt.targetWorkspacePath,
        ),
        ...input,
      });
    }
    const workspacePath = await canonicalDirectory(
      input.attempt.targetWorkspacePath,
    );
    let changedFiles: readonly string[];
    if (input.workerOutput.commitSha) {
      changedFiles = await this.gitNullTerminatedPaths([
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "--no-renames",
        "-z",
        input.workerOutput.commitSha,
      ], workspacePath);
      assertFilesWithinExpected(changedFiles, input.attempt.expectedFiles);
      await this.git(
        ["cherry-pick", "--no-commit", input.workerOutput.commitSha],
        workspacePath,
      );
    } else if (input.workerOutput.patchPath) {
      const workerJobRoot =
        this.options.workerJobRootParent === undefined
          ? []
          : [
              workerJobRootPath(
                this.options.workerJobRootParent,
                input.workerOutput.workerJobId ?? "",
              ),
            ];
      const patchPath = await canonicalPatchPath({
        workspacePath: input.workerOutput.workspacePath,
        path: input.workerOutput.patchPath,
        ...(input.workerOutput.workerJobId === undefined
          ? {}
          : { workerJobId: input.workerOutput.workerJobId }),
        allowedPatchRoots: [
          ...(this.options.allowedPatchRoots ?? []),
          ...workerJobRoot,
        ],
        ...(this.options.controllerArchiveRoot === undefined
          ? {}
          : { controllerArchiveRoot: this.options.controllerArchiveRoot }),
      });
      await assertPatchSha256(patchPath, input.workerOutput.patchSha256);
      const targetCommit = input.workerOutput.targetCommit ??
        input.workerOutput.baseCommit ??
        (await this.git(["rev-parse", "HEAD"], workspacePath)).stdout.trim();
      const patchOutput = await inspectLocalPatchOutputTree({
        runtime: this.mergeRuntime(),
        workspacePath,
        baseCommit: localWorkerOutputTargetCommit({
          ...input.workerOutput,
          baseCommit: targetCommit,
        }),
        patchPath,
      });
      changedFiles = patchOutput.changedFiles;
      await assertPatchSha256(patchPath, input.workerOutput.patchSha256);
      assertFilesWithinExpected(changedFiles, input.attempt.expectedFiles);
      const forwardCheck = await this.tryGit(
        ["apply", "--check", "--whitespace=nowarn", patchPath],
        workspacePath,
      );
      if (forwardCheck.exitCode === 0) {
        await assertPatchSha256(patchPath, input.workerOutput.patchSha256);
        await this.git(
          ["apply", "--whitespace=nowarn", patchPath],
          workspacePath,
        );
      } else if (
        input.allowAlreadyApplied === true &&
        sameFiles(changedFiles, input.attempt.expectedFiles)
      ) {
        await assertPatchSha256(patchPath, input.workerOutput.patchSha256);
        const reverseCheck = await this.tryGit(
          ["apply", "--reverse", "--check", "--whitespace=nowarn", patchPath],
          workspacePath,
        );
        if (reverseCheck.exitCode !== 0) {
          throw new Error("local_git_integration_patch_not_fully_applied");
        }
      } else {
        throw new Error("local_git_integration_patch_not_applicable");
      }
    } else {
      throw new Error("local_git_integration_worker_output_source_required");
    }
    const status = await this.getStatus({ workspacePath });
    if (status.dirtyFiles.length > 0) {
      assertFilesWithinExpected(status.dirtyFiles, input.attempt.expectedFiles);
    }
    return { changedFiles };
  }

  private async canonicalWorkerPatch(
    workerOutput: LocalGitWorkerOutput,
  ): Promise<string> {
    if (!workerOutput.patchPath) {
      throw new Error("local_git_integration_worker_patch_required");
    }
    if (!workerOutput.workerJobId) {
      throw new Error("local_git_integration_worker_job_required");
    }
    const workerJobRoot = this.options.workerJobRootParent === undefined
      ? []
      : [
          workerJobRootPath(
            this.options.workerJobRootParent,
            workerOutput.workerJobId,
          ),
        ];
    return canonicalPatchPath({
      workspacePath: workerOutput.workspacePath,
      path: workerOutput.patchPath,
      workerJobId: workerOutput.workerJobId,
      allowedPatchRoots: [
        ...(this.options.allowedPatchRoots ?? []),
        ...workerJobRoot,
      ],
      ...(this.options.controllerArchiveRoot === undefined
        ? {}
        : { controllerArchiveRoot: this.options.controllerArchiveRoot }),
    });
  }

  async diffCheck(input: {
    readonly workspacePath: string;
  }): Promise<GitDiffCheckResult> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    const working = await this.tryGit(["diff", "--check"], workspacePath);
    const staged = await this.tryGit(
      ["diff", "--cached", "--check"],
      workspacePath,
    );
    if (working.exitCode === 0 && staged.exitCode === 0) return { ok: true };
    return {
      ok: false,
      safeMessage: safeTail(
        `${working.stdout}\n${working.stderr}\n${staged.stdout}\n${staged.stderr}`,
      ),
    };
  }

  async changedFilesSinceCommit(input: {
    readonly workspacePath: string;
    readonly commit: string;
  }): Promise<readonly string[]> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    if (!/^[a-f0-9]{40,64}$/i.test(input.commit)) {
      throw new Error("local_git_integration_commit_invalid");
    }
    const changedFiles = await this.gitNullTerminatedPaths(
      ["diff", "--name-only", "--no-renames", "-z", input.commit, "--"],
      workspacePath,
    );
    const untrackedFiles = await this.gitNullTerminatedPaths(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      workspacePath,
    );
    return uniqueSorted([...changedFiles, ...untrackedFiles]).map(
      normalizeProjectRelativePath,
    );
  }

  async commit(input: {
    readonly workspacePath: string;
    readonly message: string;
    readonly files: readonly string[];
    readonly identity: CommitIdentity;
    readonly expectedParentCommits?: readonly string[];
  }): Promise<GitCommitResult> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    const files = input.files.map(normalizeProjectRelativePath);
    if (files.length === 0) {
      throw new Error("local_git_integration_commit_files_required");
    }
    if (input.expectedParentCommits) {
      const existing = await adoptExistingReviewedMergeCommit({
        runtime: this.mergeRuntime(),
        workspacePath,
        expectedParentCommits: input.expectedParentCommits,
        files,
        message: input.message,
        identity: assertCommitIdentity(input.identity),
      });
      if (existing) return existing;
      await assertPendingMergeParents(
        this.mergeRuntime(),
        workspacePath,
        input.expectedParentCommits,
      );
    }
    const stagedDeletions = new Set(
      await this.gitNullTerminatedPaths(
        ["diff", "--cached", "--name-only", "--diff-filter=D", "-z", "--", ...files],
        workspacePath,
      ),
    );
    const filesToStage: string[] = [];
    for (const file of files) {
      if (
        !stagedDeletions.has(file) ||
        await pathExists(join(workspacePath, file))
      ) {
        filesToStage.push(file);
      }
    }
    if (filesToStage.length > 0) {
      await this.git(["add", "-A", "--", ...filesToStage], workspacePath);
    }
    const unmerged = await this.gitNullTerminatedPaths(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      workspacePath,
    );
    if (unmerged.length > 0) {
      throw new Error(
        `local_git_integration_unresolved_merge:${unmerged.join(",")}`,
      );
    }
    const identity = assertCommitIdentity(input.identity);
    await this.git([
      "-c",
      `user.name=${identity.name}`,
      "-c",
      `user.email=${identity.email}`,
      "commit",
      "-m",
      input.message,
    ], workspacePath, {
      ...process.env,
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    });
    const commitSha = (
      await this.git(["rev-parse", "HEAD"], workspacePath)
    ).stdout.trim();
    const parentCommits = await commitParents(
      this.mergeRuntime(),
      workspacePath,
      commitSha,
    );
    if (
      input.expectedParentCommits &&
      !sameCommits(parentCommits, input.expectedParentCommits)
    ) {
      throw new IntegrationError({
        reason: IntegrationErrorReason.MergeParentsMismatch,
        evidence: [
          `expected:${input.expectedParentCommits.join(",")}`,
          `actual:${parentCommits.join(",")}`,
        ],
      });
    }
    const diffStat = (
      await this.git(
        input.expectedParentCommits
          ? ["diff", "--stat", "--no-renames", `${commitSha}^1`, commitSha]
          : ["show", "--stat", "--format=", "--no-renames", "HEAD"],
        workspacePath,
      )
    ).stdout.trim();
    return {
      commitSha,
      ...(input.expectedParentCommits ? { parentCommits } : {}),
      ...(diffStat ? { diffStat } : {}),
    };
  }

  async abortMerge(input: {
    readonly attempt: IntegrationAttempt;
  }): Promise<void> {
    const workspacePath = await canonicalDirectory(
      input.attempt.targetWorkspacePath,
    );
    await abortPendingMerge(
      this.mergeRuntime(),
      workspacePath,
      input.attempt.merge?.expectedTargetCommit,
      input.attempt.expectedFiles,
      input.attempt.status === IntegrationAttemptStatus.Opened &&
        input.attempt.workerOutput.baseStatus === "stale",
    );
  }

  async rollbackWorkerOutput(input: {
    readonly attempt: IntegrationAttempt;
  }): Promise<void> {
    const workspacePath = await canonicalDirectory(
      input.attempt.targetWorkspacePath,
    );
    await rollbackLocalWorkerOutput({
      runtime: this.mergeRuntime(),
      attempt: input.attempt,
      workspacePath,
    });
  }

  async push(input: {
    readonly workspacePath: string;
    readonly remote: string;
    readonly branch: string;
    readonly commitSha: string;
    readonly force: boolean;
    readonly expectedRemoteCommit?: string;
  }): Promise<void> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    const head = (
      await this.git(["rev-parse", "HEAD"], workspacePath)
    ).stdout.trim();
    if (head !== input.commitSha) {
      throw new Error("local_git_integration_push_commit_mismatch");
    }
    if (input.expectedRemoteCommit) {
      if (input.force) {
        throw new Error("local_git_integration_promotion_force_forbidden");
      }
      if (!/^[a-f0-9]{40}$/i.test(input.expectedRemoteCommit)) {
        throw new Error("local_git_integration_expected_remote_commit_invalid");
      }
      const ancestor = await this.tryGit(
        [
          "merge-base",
          "--is-ancestor",
          input.expectedRemoteCommit,
          input.commitSha,
        ],
        workspacePath,
      );
      if (ancestor.exitCode !== 0) {
        throw new Error("local_git_integration_promotion_not_fast_forward");
      }
    }
    await this.git(
      [
        "push",
        ...(input.expectedRemoteCommit
          ? [
              `--force-with-lease=refs/heads/${input.branch}:${input.expectedRemoteCommit}`,
            ]
          : input.force
            ? ["--force-with-lease"]
            : []),
        input.remote,
        `HEAD:${input.branch}`,
      ],
      workspacePath,
    );
  }

  async remoteBranchCommit(input: {
    readonly workspacePath: string;
    readonly remote: string;
    readonly branch: string;
  }): Promise<string | null> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    const result = await this.git(
      ["ls-remote", "--refs", input.remote, `refs/heads/${input.branch}`],
      workspacePath,
    );
    const output = result.stdout.trim();
    if (!output) return null;
    const lines = output.split("\n");
    const [commit, ref, ...extraFields] = lines[0]!.trim().split(/\s+/);
    if (
      lines.length !== 1 ||
      extraFields.length > 0 ||
      !commit ||
      !/^[a-f0-9]{40}$/i.test(commit) ||
      ref !== `refs/heads/${input.branch}`
    ) {
      throw new Error("local_git_integration_remote_ref_invalid");
    }
    return commit;
  }

  async currentBranch(input: {
    readonly workspacePath: string;
  }): Promise<string> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    return (
      await this.git(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath)
    ).stdout.trim();
  }

  private mergeRuntime(): LocalGitMergeRuntime {
    return {
      git: (args, cwd, env) => this.git(args, cwd, env),
      tryGit: (args, cwd, env) => this.tryGit(args, cwd, env),
      gitNullTerminatedPaths: (args, cwd) =>
        this.gitNullTerminatedPaths(args, cwd),
      getStatus: (workspacePath) => this.getStatus({ workspacePath }),
      remoteBranchCommit: (input) => this.remoteBranchCommit(input),
      canonicalWorkerPatch: (workerOutput) =>
        this.canonicalWorkerPatch(workerOutput),
      assertPatchSha256,
      patchChangedFiles: (patchPath, cwd) =>
        this.patchChangedFiles(patchPath, cwd),
    };
  }

  private async git(
    args: readonly string[],
    cwd: string,
    env?: Readonly<Record<string, string | undefined>>,
  ): Promise<CommandResult> {
    const result = await this.tryGit(args, cwd, env);
    if (result.exitCode !== 0) {
      throw new Error(
        `local_git_integration_failed:${safeTail(result.stderr || result.stdout)}`,
      );
    }
    return result;
  }

  private async gitLines(
    args: readonly string[],
    cwd: string,
  ): Promise<readonly string[]> {
    const result = await this.git(args, cwd);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private async gitNullTerminatedPaths(
    args: readonly string[],
    cwd: string,
  ): Promise<readonly string[]> {
    const result = await this.git(args, cwd);
    return uniqueSorted(
      result.stdout.split("\0").filter(Boolean).map(normalizeProjectRelativePath),
    );
  }

  private async patchChangedFiles(
    patchPath: string,
    cwd: string,
  ): Promise<readonly string[]> {
    const result = await this.git(
      ["apply", "--numstat", "-z", patchPath],
      cwd,
    );
    const paths = result.stdout.split("\0").filter(Boolean).map((record) => {
      const fields = record.split("\t");
      const path = fields.slice(2).join("\t");
      if (!path) throw new Error("local_git_integration_patch_path_required");
      return normalizeProjectRelativePath(path);
    });
    return uniqueSorted(paths);
  }

  private async tryGit(
    args: readonly string[],
    cwd: string,
    env?: Readonly<Record<string, string | undefined>>,
  ): Promise<CommandResult> {
    return runCommand({
      command: this.options.gitBinaryPath ?? "git",
      args,
      cwd,
      ...(env ? { env } : {}),
      timeoutMs: this.options.timeoutMs ?? 60_000,
      maxBuffer: this.options.maxBuffer ?? 10 * 1024 * 1024,
    });
  }
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = uniqueSorted(left.map(normalizeProjectRelativePath));
  const normalizedRight = uniqueSorted(right.map(normalizeProjectRelativePath));
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((file, index) => file === normalizedRight[index]);
}

function sameCommits(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(
    (commit, index) => commit.toLowerCase() === right[index]?.toLowerCase(),
  );
}

async function assertPatchSha256(
  patchPath: string,
  expectedSha256: string | undefined,
): Promise<void> {
  if (expectedSha256 === undefined) return;
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("local_git_integration_patch_hash_invalid");
  }
  const actual = createHash("sha256")
    .update(await readFile(patchPath))
    .digest("hex");
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error("local_git_integration_patch_hash_mismatch");
  }
}

export class ConfiguredCommitIdentityAdapter implements CommitIdentityPort {
  constructor(
    private readonly identity: CommitIdentity | undefined,
    private readonly gitBinaryPath = "git",
  ) {}

  async approvedIdentity(input: {
    readonly projectId: string;
    readonly workspacePath: string;
  }): Promise<CommitIdentity> {
    if (this.identity !== undefined) return assertCommitIdentity(this.identity);

    const workspacePath = await canonicalDirectory(input.workspacePath);
    const [name, email] = await Promise.all([
      this.localGitConfig(workspacePath, "user.name"),
      this.localGitConfig(workspacePath, "user.email"),
    ]);
    return assertCommitIdentity(
      name && email ? { name, email } : undefined,
    );
  }

  private async localGitConfig(
    workspacePath: string,
    key: string,
  ): Promise<string | undefined> {
    const result = await runCommand({
      command: this.gitBinaryPath,
      args: ["config", "--local", "--get", key],
      cwd: workspacePath,
      timeoutMs: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (result.exitCode !== 0) return undefined;
    const value = result.stdout.trim();
    return value.length === 0 ? undefined : value;
  }
}

export type LocalProjectCheckRunnerOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
};

export class LocalProjectCheckRunner implements CheckRunnerPort {
  constructor(private readonly options: LocalProjectCheckRunnerOptions = {}) {}

  async runCheck(input: {
    readonly workspacePath: string;
    readonly check: {
      readonly checkId: string;
      readonly command: readonly string[];
      readonly cwd?: string;
      readonly timeoutMs?: number;
    };
    readonly startedAt: string;
  }): Promise<CheckRun> {
    const completedAt = () => new Date().toISOString();
    if (input.check.command.length === 0) {
      return {
        checkId: input.check.checkId,
        command: input.check.command,
        status: CheckRunStatus.Failed,
        startedAt: input.startedAt,
        completedAt: completedAt(),
        safeOutputTail: "check_command_required",
      };
    }
    let cwd: string;
    try {
      cwd = await checkCwd(input.workspacePath, input.check.cwd);
    } catch {
      return {
        checkId: input.check.checkId,
        command: input.check.command,
        status: CheckRunStatus.Failed,
        startedAt: input.startedAt,
        completedAt: completedAt(),
        safeOutputTail: "check_cwd_outside_workspace",
      };
    }
    const [rawCommand, ...rawArgs] = input.check.command;
    const { command, args } = resolveCheckCommand(rawCommand ?? "", rawArgs);
    const result = await runCommand({
      command,
      args,
      cwd,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      timeoutMs: input.check.timeoutMs ?? this.options.timeoutMs ?? 120_000,
      maxBuffer: this.options.maxBuffer ?? 10 * 1024 * 1024,
    });
    return {
      checkId: input.check.checkId,
      command: input.check.command,
      status: result.timedOut
        ? CheckRunStatus.TimedOut
        : result.exitCode === 0
          ? CheckRunStatus.Passed
          : CheckRunStatus.Failed,
      startedAt: input.startedAt,
      completedAt: completedAt(),
      exitCode: result.exitCode,
      safeOutputTail: safeTail(`${result.stdout}\n${result.stderr}`),
    };
  }
}

function resolveCheckCommand(
  command: string,
  args: readonly string[],
): { readonly command: string; readonly args: readonly string[] } {
  if (command === "pnpm" || command === "yarn") {
    return {
      command: "corepack",
      args: [command, ...args],
    };
  }
  return { command, args };
}

export {
  SimpleSecretScanner,
  type SimpleSecretScannerOptions,
} from "./simple-secret-scanner";

export type LocalWorkspaceIntegrationLockOptions = {
  readonly rootDir: string;
  readonly staleLockMs?: number;
};

export class LocalWorkspaceIntegrationLock implements WorkspaceLockPort {
  private readonly store: LocalFileWorkspaceLockStore;

  constructor(private readonly options: LocalWorkspaceIntegrationLockOptions) {
    this.store = new LocalFileWorkspaceLockStore(options.rootDir);
  }

  async acquire(input: {
    readonly workspacePath: string;
    readonly owner: string;
  }): Promise<WorkspaceLock> {
    const handle = await this.store.acquire({
      taskId: `integration:${input.owner}:${randomUUID()}`,
      workspacePath: input.workspacePath,
      ownerId: input.owner,
      ownerPid: process.pid,
      ...(this.options.staleLockMs === undefined
        ? {}
        : { staleLockMs: this.options.staleLockMs }),
    });
    return {
      lockId: handle.taskId,
      workspacePath: handle.workspacePath,
      owner: handle.ownerId,
      release: handle.release,
    } as WorkspaceLock & { readonly release: () => Promise<void> };
  }

  async release(lock: WorkspaceLock): Promise<void> {
    const maybeReleasable = lock as WorkspaceLock & {
      readonly release?: () => Promise<void>;
    };
    await maybeReleasable.release?.();
  }
}

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

async function runCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
}): Promise<CommandResult> {
  try {
    const result = await execFileAsync(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env === undefined ? process.env : dropUndefinedEnv(input.env),
      timeout: input.timeoutMs,
      maxBuffer: input.maxBuffer,
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false,
    };
  } catch (error) {
    const err = error as {
      readonly code?: number | string;
      readonly signal?: string;
      readonly killed?: boolean;
      readonly stdout?: string | Buffer;
      readonly stderr?: string | Buffer;
      readonly message?: string;
    };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: bufferToString(err.stdout),
      stderr: bufferToString(err.stderr) || err.message || "",
      timedOut: err.killed === true || err.signal === "SIGTERM",
    };
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  return await realpath(path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalPatchPath(input: {
  readonly workspacePath: string;
  readonly path: string;
  readonly workerJobId?: string;
  readonly allowedPatchRoots: readonly string[];
  readonly controllerArchiveRoot?: string;
}): Promise<string> {
  const workspaceRoot = await canonicalDirectory(input.workspacePath);
  const candidate =
    input.path && isAbsolute(input.path)
      ? input.path
      : resolve(workspaceRoot, input.path);
  const canonical = await realpath(candidate);
  if (isPathInside(canonical, workspaceRoot)) return canonical;

  for (const rootPath of input.allowedPatchRoots) {
    const root = await canonicalDirectoryIfExists(rootPath);
    if (root === undefined) continue;
    if (isPathInside(canonical, root)) return canonical;
  }

  if (input.controllerArchiveRoot !== undefined) {
    const archiveRoot = await canonicalDirectoryIfExists(
      input.controllerArchiveRoot,
    );
    if (
      archiveRoot !== undefined &&
      isControllerRejectedPatch({
        path: canonical,
        archiveRoot,
        ...(input.workerJobId === undefined
          ? {}
          : { workerJobId: input.workerJobId }),
      })
    ) {
      return canonical;
    }
  }

  throw new Error("local_project_integration_path_outside_root");
}

function isControllerRejectedPatch(input: {
  readonly path: string;
  readonly archiveRoot: string;
  readonly workerJobId?: string;
}): boolean {
  if (
    input.workerJobId === undefined ||
    basename(input.workerJobId) !== input.workerJobId ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.workerJobId)
  ) {
    return false;
  }
  const relativePath = relative(input.archiveRoot, input.path);
  if (
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    basename(relativePath) !== "tracked.diff"
  ) {
    return false;
  }
  const archiveDirectory = dirname(relativePath);
  const expectedPrefix = `${input.workerJobId}-rejected-`;
  return (
    dirname(archiveDirectory) === "." &&
    archiveDirectory.startsWith(expectedPrefix) &&
    archiveDirectory.length > expectedPrefix.length
  );
}

async function canonicalDirectoryIfExists(
  path: string,
): Promise<string | undefined> {
  try {
    return await canonicalDirectory(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function workerJobRootPath(
  parentPath: string,
  workerJobId: string,
): string {
  if (
    basename(workerJobId) !== workerJobId ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workerJobId)
  ) {
    throw new Error("local_project_integration_worker_job_id_invalid");
  }
  const parent = resolve(parentPath);
  const root = join(parent, workerJobId);
  if (dirname(root) !== parent) {
    throw new Error("local_project_integration_worker_job_root_outside_parent");
  }
  return root;
}

async function checkCwd(
  workspacePath: string,
  cwd: string | undefined,
): Promise<string> {
  const workspace = await canonicalDirectory(workspacePath);
  const candidate =
    cwd === undefined
      ? workspace
      : isAbsolute(cwd)
        ? cwd
        : resolve(workspace, cwd);
  const canonical = await realpath(candidate);
  if (!isPathInside(canonical, workspace)) {
    throw new Error("local_project_check_cwd_outside_workspace");
  }
  return canonical;
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function safeTail(value: string, maxLength = 4000): string {
  const redacted = redactSecrets(value);
  return redacted.length <= maxLength
    ? redacted
    : redacted.slice(redacted.length - maxLength);
}

function redactSecrets(value: string): string {
  return value
    .replaceAll(/sk-[A-Za-z0-9_-]{12,}/g, "sk-<redacted>")
    .replaceAll(/ghp_[A-Za-z0-9_]{12,}/g, "ghp_<redacted>")
    .replaceAll(/github_pat_[A-Za-z0-9_]{12,}/g, "github_pat_<redacted>")
    .replaceAll(/xox[baprs]-[A-Za-z0-9-]{12,}/g, "xox<redacted>")
    .replaceAll(
      /(api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*["']?[^"'\s]+/gi,
      "$1=<redacted>",
    );
}

function bufferToString(value: string | Buffer | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function dropUndefinedEnv(
  env: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

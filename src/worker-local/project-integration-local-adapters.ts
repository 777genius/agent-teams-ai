import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  CheckRunStatus,
  LocalFileWorkspaceLockStore,
  SecretScanStatus,
  normalizeProjectRelativePath,
  type CheckRun,
  type CheckRunnerPort,
  type GitApplyWorkerOutputResult,
  type GitCommitResult,
  type GitDiffCheckResult,
  type GitPort,
  type GitWorkspaceStatus,
  type SecretScannerPort,
  type SecretScanResult,
  type WorkspaceLock,
  type WorkspaceLockPort,
} from "@vioxen/subscription-runtime/worker-core";

const execFileAsync = promisify(execFile);

export type LocalGitIntegrationAdapterOptions = {
  readonly gitBinaryPath?: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
};

export class LocalGitIntegrationAdapter implements GitPort {
  constructor(private readonly options: LocalGitIntegrationAdapterOptions = {}) {}

  async getStatus(input: {
    readonly workspacePath: string;
  }): Promise<GitWorkspaceStatus> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    const branch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath))
      .stdout.trim();
    const dirtyFiles = uniqueSorted([
      ...await this.gitLines(["diff", "--name-only"], workspacePath),
      ...await this.gitLines(["diff", "--cached", "--name-only"], workspacePath),
      ...await this.gitLines(
        ["ls-files", "--others", "--exclude-standard"],
        workspacePath,
      ),
    ]).map(normalizeProjectRelativePath);
    return { branch, dirtyFiles };
  }

  async applyWorkerOutput(input: {
    readonly workerOutput: {
      readonly commitSha?: string;
      readonly patchPath?: string;
      readonly workspacePath: string;
    };
    readonly attempt: {
      readonly targetWorkspacePath: string;
    };
  }): Promise<GitApplyWorkerOutputResult> {
    const workspacePath = await canonicalDirectory(input.attempt.targetWorkspacePath);
    if (input.workerOutput.commitSha) {
      await this.git(["cherry-pick", "--no-commit", input.workerOutput.commitSha], workspacePath);
    } else if (input.workerOutput.patchPath) {
      const patchPath = await canonicalPathInsideRoot({
        rootPath: input.workerOutput.workspacePath,
        path: input.workerOutput.patchPath,
      });
      await this.git(["apply", "--whitespace=nowarn", patchPath], workspacePath);
    } else {
      throw new Error("local_git_integration_worker_output_source_required");
    }
    return {
      changedFiles: (await this.getStatus({ workspacePath })).dirtyFiles,
    };
  }

  async diffCheck(input: {
    readonly workspacePath: string;
  }): Promise<GitDiffCheckResult> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    const working = await this.tryGit(["diff", "--check"], workspacePath);
    const staged = await this.tryGit(["diff", "--cached", "--check"], workspacePath);
    if (working.exitCode === 0 && staged.exitCode === 0) return { ok: true };
    return {
      ok: false,
      safeMessage: safeTail(`${working.stdout}\n${working.stderr}\n${staged.stdout}\n${staged.stderr}`),
    };
  }

  async commit(input: {
    readonly workspacePath: string;
    readonly message: string;
    readonly files: readonly string[];
  }): Promise<GitCommitResult> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    const files = input.files.map(normalizeProjectRelativePath);
    await this.git(["add", "--", ...files], workspacePath);
    await this.git(["commit", "-m", input.message], workspacePath);
    const commitSha = (await this.git(["rev-parse", "HEAD"], workspacePath)).stdout.trim();
    const diffStat = (await this.git(
      ["show", "--stat", "--format=", "--no-renames", "HEAD"],
      workspacePath,
    )).stdout.trim();
    return {
      commitSha,
      ...(diffStat ? { diffStat } : {}),
    };
  }

  async push(input: {
    readonly workspacePath: string;
    readonly remote: string;
    readonly branch: string;
    readonly commitSha: string;
    readonly force: boolean;
  }): Promise<void> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    const head = (await this.git(["rev-parse", "HEAD"], workspacePath)).stdout.trim();
    if (head !== input.commitSha) {
      throw new Error("local_git_integration_push_commit_mismatch");
    }
    await this.git([
      "push",
      ...(input.force ? ["--force-with-lease"] : []),
      input.remote,
      `HEAD:${input.branch}`,
    ], workspacePath);
  }

  async currentBranch(input: {
    readonly workspacePath: string;
  }): Promise<string> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    return (await this.git(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath))
      .stdout.trim();
  }

  private async git(
    args: readonly string[],
    cwd: string,
  ): Promise<CommandResult> {
    const result = await this.tryGit(args, cwd);
    if (result.exitCode !== 0) {
      throw new Error(`local_git_integration_failed:${safeTail(result.stderr || result.stdout)}`);
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

  private async tryGit(
    args: readonly string[],
    cwd: string,
  ): Promise<CommandResult> {
    return runCommand({
      command: this.options.gitBinaryPath ?? "git",
      args,
      cwd,
      timeoutMs: this.options.timeoutMs ?? 60_000,
      maxBuffer: this.options.maxBuffer ?? 10 * 1024 * 1024,
    });
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
    const [command, ...args] = input.check.command;
    const result = await runCommand({
      command: command ?? "",
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

export type SimpleSecretScannerOptions = {
  readonly maxFileBytes?: number;
  readonly patterns?: readonly RegExp[];
};

export class SimpleSecretScanner implements SecretScannerPort {
  constructor(private readonly options: SimpleSecretScannerOptions = {}) {}

  async scanFiles(input: {
    readonly workspacePath: string;
    readonly files: readonly string[];
  }): Promise<SecretScanResult> {
    const workspacePath = await canonicalDirectory(input.workspacePath);
    const patterns = this.options.patterns ?? defaultSecretPatterns;
    const matches: string[] = [];
    for (const file of input.files.map(normalizeProjectRelativePath)) {
      const filePath = resolve(workspacePath, file);
      if (!isPathInside(filePath, workspacePath)) {
        return {
          status: SecretScanStatus.Failed,
          safeMessage: "secret_scan_file_outside_workspace",
        };
      }
      let contents: Buffer;
      try {
        const realFilePath = await realpath(filePath);
        if (!isPathInside(realFilePath, workspacePath)) {
          return {
            status: SecretScanStatus.Failed,
            safeMessage: "secret_scan_file_outside_workspace",
          };
        }
        contents = await readFile(realFilePath);
      } catch (error) {
        if (!isNodeErrorCode(error, "ENOENT")) {
          return {
            status: SecretScanStatus.Failed,
            safeMessage: `secret_scan_unreadable_file:${file}`,
          };
        }
        continue;
      }
      const sample = contents
        .subarray(0, this.options.maxFileBytes ?? 1024 * 1024)
        .toString("utf8");
      if (patterns.some((pattern) => pattern.test(sample))) {
        matches.push(file);
      }
    }
    if (matches.length > 0) {
      return {
        status: SecretScanStatus.Failed,
        safeMessage: `secret_like_content:${matches.join(",")}`,
      };
    }
    return { status: SecretScanStatus.Passed };
  }
}

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
      env: input.env === undefined
        ? process.env
        : dropUndefinedEnv(input.env),
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

async function canonicalPathInsideRoot(input: {
  readonly rootPath: string;
  readonly path: string;
}): Promise<string> {
  const root = await canonicalDirectory(input.rootPath);
  const candidate = input.path && isAbsolute(input.path)
    ? input.path
    : resolve(root, input.path);
  const canonical = await realpath(candidate);
  if (!isPathInside(canonical, root)) {
    throw new Error("local_project_integration_path_outside_root");
  }
  return canonical;
}

async function checkCwd(
  workspacePath: string,
  cwd: string | undefined,
): Promise<string> {
  const workspace = await canonicalDirectory(workspacePath);
  const candidate = cwd === undefined
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
    Object.entries(env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined
    ),
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

const defaultSecretPatterns: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
];

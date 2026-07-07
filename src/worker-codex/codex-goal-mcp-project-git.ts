import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function assertSafeGitRefName(value: string, fieldName: string): void {
  if (
    value.startsWith("-") ||
    value.includes("..") ||
    /[\s~^:?*\[\]\x00-\x1f\x7f]/.test(value) ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.length > 200
  ) {
    throw new Error(`project_control_${fieldName}_invalid`);
  }
}

export function assertSafeGitRemoteName(value: string, fieldName: string): void {
  if (
    value.startsWith("-") ||
    !/^[A-Za-z0-9._-]+$/.test(value) ||
    value.length > 100
  ) {
    throw new Error(`project_control_${fieldName}_invalid`);
  }
}

export function assertSafeGitCommitSha(value: string): void {
  if (!/^[0-9a-fA-F]{7,64}$/.test(value)) {
    throw new Error("project_control_commit_sha_invalid");
  }
}

export async function assertGitCurrentBranch(input: {
  readonly workspacePath: string;
  readonly branch: string;
}): Promise<void> {
  const current = await execGitStdout([
    "-C",
    input.workspacePath,
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (current.trim() !== input.branch) {
    throw new Error("project_control_branch_mismatch");
  }
}

export async function execGit(args: readonly string[]): Promise<void> {
  await execGitStdout(args);
}

export async function execGitStdout(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new Error(
      `project_control_git_failed:${gitOperationLabel(args)}:${gitErrorSummary(error)}`,
    );
  }
}

function gitOperationLabel(args: readonly string[]): string {
  const command = args.find((arg) =>
    arg === "worktree" ||
    arg === "cherry-pick" ||
    arg === "push" ||
    arg === "rev-parse"
  );
  return command ?? "unknown";
}

function gitErrorSummary(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const candidate = error as {
    readonly code?: unknown;
    readonly stderr?: unknown;
    readonly message?: unknown;
  };
  const raw = typeof candidate.stderr === "string" && candidate.stderr.trim()
    ? candidate.stderr
    : typeof candidate.message === "string"
    ? candidate.message
    : typeof candidate.code === "string"
    ? candidate.code
    : "unknown";
  return raw
    .replace(/\s+/g, " ")
    .replace(/["'`]/g, "")
    .slice(0, 240);
}

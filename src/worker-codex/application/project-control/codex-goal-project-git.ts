import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

export type CanonicalRemoteHead = {
  readonly remote: string;
  readonly branch: string;
  readonly fullRef: string;
  readonly oid: string;
};

export async function resolveCanonicalRemoteHead(input: {
  readonly workspacePath: string;
  readonly remoteTrackingRef: string;
}): Promise<CanonicalRemoteHead> {
  const parsed = parseRemoteTrackingRef(input.remoteTrackingRef);
  const fullRef = `refs/heads/${parsed.branch}`;
  const output = await execGitStdout([
    "-C",
    input.workspacePath,
    "ls-remote",
    "--exit-code",
    "--refs",
    parsed.remote,
    fullRef,
  ]);
  const records = output.trim().split(/\r?\n/).filter(Boolean);
  if (records.length !== 1) {
    throw new Error("project_control_canonical_remote_head_ambiguous");
  }
  const [oid, observedRef] = records[0]?.split(/\s+/) ?? [];
  if (!oid || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(oid) || observedRef !== fullRef) {
    throw new Error("project_control_canonical_remote_head_invalid");
  }
  return {
    remote: parsed.remote,
    branch: parsed.branch,
    fullRef,
    oid: oid.toLowerCase(),
  };
}

export function assertCanonicalRemoteRevision(input: {
  readonly canonical: CanonicalRemoteHead;
  readonly resolvedRevision: string;
}): void {
  if (input.canonical.oid !== input.resolvedRevision.toLowerCase()) {
    throw new Error("project_control_source_revision_stale");
  }
}

export async function applyVerifiedInputPatch(input: {
  readonly workspacePath: string;
  readonly patchPath: string;
  readonly expectedSha256: string;
  readonly expectedBaseCommit: string;
}): Promise<void> {
  const patch = await readFile(input.patchPath);
  const actualSha256 = createHash("sha256").update(patch).digest("hex");
  if (actualSha256 !== input.expectedSha256.toLowerCase()) {
    throw new Error("project_control_input_patch_hash_mismatch");
  }
  const head = (await execGitStdout([
    "-C",
    input.workspacePath,
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ])).trim();
  if (head !== input.expectedBaseCommit) {
    throw new Error("project_control_input_patch_base_mismatch");
  }
  await execGit([
    "-C",
    input.workspacePath,
    "apply",
    "--index",
    "--binary",
    input.patchPath,
  ]);
}

function parseRemoteTrackingRef(value: string): {
  readonly remote: string;
  readonly branch: string;
} {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("project_control_canonical_remote_ref_required");
  }
  const remote = value.slice(0, separator);
  const branch = value.slice(separator + 1);
  assertSafeGitRemoteName(remote, "canonicalRemote");
  assertSafeGitRefName(branch, "canonicalBranch");
  return { remote, branch };
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
    arg === "apply" ||
    arg === "ls-remote" ||
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

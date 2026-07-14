import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_STAGED_PATCH_BYTES = 16 * 1024 * 1024;

export async function stagedPatchSha256(
  workspacePath: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      workspacePath,
      "diff",
      "--cached",
      "--binary",
      "HEAD",
      "--",
    ], {
      encoding: "buffer",
      timeout: 120_000,
      maxBuffer: MAX_STAGED_PATCH_BYTES,
    });
    return createHash("sha256").update(stdout).digest("hex");
  } catch {
    throw new Error("project_control_staged_patch_digest_failed");
  }
}

export async function stagedPatchSha256ForRevision(input: {
  readonly workspacePath: string;
  readonly revision: string;
  readonly patchPath: string;
}): Promise<string> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "subscription-runtime-staged-index-"),
  );
  const indexPath = join(temporaryDirectory, "index");
  const options = {
    env: { ...process.env, GIT_INDEX_FILE: indexPath },
    encoding: "buffer" as const,
    timeout: 120_000,
    maxBuffer: MAX_STAGED_PATCH_BYTES,
  };
  try {
    await execFileAsync("git", [
      "-C",
      input.workspacePath,
      "read-tree",
      input.revision,
    ], options);
    await execFileAsync("git", [
      "-C",
      input.workspacePath,
      "apply",
      "--cached",
      "--binary",
      input.patchPath,
    ], options);
    const { stdout } = await execFileAsync("git", [
      "-C",
      input.workspacePath,
      "diff",
      "--cached",
      "--binary",
      input.revision,
      "--",
    ], options);
    return createHash("sha256").update(stdout).digest("hex");
  } catch {
    throw new Error("project_control_input_patch_staged_digest_failed");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

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

export function assertSafeGitRemoteName(
  value: string,
  fieldName: string,
): void {
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

function assertFullGitObjectId(value: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) {
    throw new Error("project_control_pinned_source_commit_invalid");
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
  if (
    !oid ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(oid) ||
    observedRef !== fullRef
  ) {
    throw new Error("project_control_canonical_remote_head_invalid");
  }
  return {
    remote: parsed.remote,
    branch: parsed.branch,
    fullRef,
    oid: oid.toLowerCase(),
  };
}

export async function materializePinnedRemoteCommit(input: {
  readonly workspacePath: string;
  readonly remoteTrackingRef: string;
  readonly expectedCommit: string;
}): Promise<CanonicalRemoteHead> {
  assertFullGitObjectId(input.expectedCommit);
  const expectedCommit = input.expectedCommit.toLowerCase();
  const beforeFetch = await resolveCanonicalRemoteHead({
    workspacePath: input.workspacePath,
    remoteTrackingRef: input.remoteTrackingRef,
  });
  if (beforeFetch.oid !== expectedCommit) {
    throw new Error("project_control_pinned_source_head_mismatch");
  }

  await execGitStdout([
    "-C",
    input.workspacePath,
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--refmap=",
    beforeFetch.remote,
    beforeFetch.fullRef,
  ]);

  const resolvedCommit = (
    await execGitStdout([
      "-C",
      input.workspacePath,
      "rev-parse",
      "--verify",
      `${expectedCommit}^{commit}`,
    ])
  )
    .trim()
    .toLowerCase();
  if (resolvedCommit !== expectedCommit) {
    throw new Error("project_control_pinned_source_object_mismatch");
  }

  const afterFetch = await resolveCanonicalRemoteHead({
    workspacePath: input.workspacePath,
    remoteTrackingRef: input.remoteTrackingRef,
  });
  if (afterFetch.oid !== expectedCommit) {
    throw new Error("project_control_pinned_source_changed_during_fetch");
  }
  return afterFetch;
}

export function canonicalRemoteWorktreeSourceRef(
  remoteTrackingRef: string,
): string {
  return parseRemoteTrackingRef(remoteTrackingRef).branch;
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
  readonly expectedTargetCommit: string;
  readonly changedPaths: readonly string[];
}): Promise<void> {
  await assertInputPatchHash(input.patchPath, input.expectedSha256);
  const head = (
    await execGitStdout([
      "-C",
      input.workspacePath,
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ])
  ).trim();
  if (head !== input.expectedTargetCommit) {
    throw new Error("project_control_input_patch_target_mismatch");
  }
  const status = await execGitStdout([
    "-C",
    input.workspacePath,
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (status.length > 0) {
    throw new Error("project_control_input_patch_target_dirty");
  }
  if (input.changedPaths.length === 0) {
    throw new Error("project_control_input_patch_changed_paths_required");
  }
  if (input.expectedBaseCommit !== input.expectedTargetCommit) {
    await execGitGuard(
      [
        "-C",
        input.workspacePath,
        "merge-base",
        "--is-ancestor",
        input.expectedBaseCommit,
        input.expectedTargetCommit,
      ],
      "project_control_input_patch_base_not_ancestor",
    );
    await execGitGuard(
      [
        "--literal-pathspecs",
        "-C",
        input.workspacePath,
        "diff",
        "--quiet",
        "--no-ext-diff",
        "--no-renames",
        input.expectedBaseCommit,
        input.expectedTargetCommit,
        "--",
        ...input.changedPaths,
      ],
      "project_control_input_patch_changed_paths_advanced",
    );
  }
  await execGitGuard(
    [
      "-C",
      input.workspacePath,
      "apply",
      "--check",
      "--index",
      "--binary",
      input.patchPath,
    ],
    "project_control_input_patch_not_applicable",
  );
  await assertInputPatchHash(input.patchPath, input.expectedSha256);
  const confirmedHead = (
    await execGitStdout([
      "-C",
      input.workspacePath,
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ])
  ).trim();
  if (confirmedHead !== input.expectedTargetCommit) {
    throw new Error("project_control_input_patch_target_changed");
  }
  await execGitGuard(
    [
      "-C",
      input.workspacePath,
      "apply",
      "--index",
      "--binary",
      input.patchPath,
    ],
    "project_control_input_patch_apply_failed",
  );
}

async function assertInputPatchHash(
  patchPath: string,
  expectedSha256: string,
): Promise<void> {
  const patch = await readFile(patchPath);
  const actualSha256 = createHash("sha256").update(patch).digest("hex");
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error("project_control_input_patch_hash_mismatch");
  }
}

async function execGitGuard(
  args: readonly string[],
  errorCode: string,
): Promise<void> {
  try {
    await execFileAsync("git", [...args], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error(errorCode);
  }
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
  const command = args.find(
    (arg) =>
      arg === "worktree" ||
      arg === "cherry-pick" ||
      arg === "push" ||
      arg === "apply" ||
      arg === "fetch" ||
      arg === "ls-remote" ||
      arg === "rev-parse",
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
  const raw =
    typeof candidate.stderr === "string" && candidate.stderr.trim()
      ? candidate.stderr
      : typeof candidate.message === "string"
        ? candidate.message
        : typeof candidate.code === "string"
          ? candidate.code
          : "unknown";
  return raw.replace(/\s+/g, " ").replace(/["'`]/g, "").slice(0, 240);
}

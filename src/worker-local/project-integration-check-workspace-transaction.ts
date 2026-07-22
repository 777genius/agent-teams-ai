import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  CheckWorkspaceIntegrityDisposition,
  normalizeProjectRelativePath,
} from "@vioxen/subscription-runtime/worker-core";

const execFileAsync = promisify(execFile);

export type CheckWorkspaceCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly processTreeStopped?: boolean;
};

export type CheckWorkspaceTransactionResult =
  | {
      readonly status: "completed";
      readonly commandResult: CheckWorkspaceCommandResult;
      readonly workspaceIntegrity: CheckWorkspaceIntegrityDisposition.Unchanged;
    }
  | {
      readonly status: "hygiene_failed";
      readonly safeError: string;
      readonly commandResult?: CheckWorkspaceCommandResult;
      readonly workspaceIntegrity: CheckWorkspaceIntegrityDisposition;
    };

type CandidateEntry =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly mode: number; readonly bytes: Buffer }
  | { readonly kind: "symlink"; readonly mode: number; readonly target: string };

type IndexSnapshot =
  | { readonly kind: "missing"; readonly path: string }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly mode: number;
      readonly bytes: Buffer;
    };

type WorkspaceSnapshot = {
  readonly worktreePatchSha256: string;
  readonly indexPatchSha256: string;
  readonly untrackedFiles: ReadonlySet<string>;
  readonly changedTrackedOrIndexFiles: ReadonlySet<string>;
  readonly trackedFiles: ReadonlySet<string>;
  readonly candidateEntries: ReadonlyMap<string, CandidateEntry>;
};

export async function runCheckWorkspaceTransaction(input: {
  readonly workspacePath: string;
  readonly allowedWorkspaceFiles: readonly string[];
  readonly gitBinaryPath?: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly runCommand: () => Promise<CheckWorkspaceCommandResult>;
}): Promise<CheckWorkspaceTransactionResult> {
  const git = new CheckWorkspaceGit({
    binaryPath: input.gitBinaryPath ?? "git",
    timeoutMs: input.timeoutMs ?? 30_000,
    maxBuffer: input.maxBuffer ?? 10 * 1024 * 1024,
  });
  let workspacePath: string;
  let allowedWorkspaceFiles: readonly string[];
  let baseline: WorkspaceSnapshot;
  let baselineIndex: IndexSnapshot;
  try {
    workspacePath = await realpath(input.workspacePath);
    allowedWorkspaceFiles = uniqueSorted(
      input.allowedWorkspaceFiles.map(normalizeProjectRelativePath),
    );
    baseline = await captureWorkspaceSnapshot({
      git,
      workspacePath,
      allowedWorkspaceFiles,
    });
    assertBaselineWithinAllowedFiles(baseline, allowedWorkspaceFiles);
    baselineIndex = await captureIndexSnapshot(
      await git.indexPath(workspacePath),
    );
  } catch {
    return hygieneFailure(
      "check_workspace_hygiene_baseline_failed",
      CheckWorkspaceIntegrityDisposition.Unverified,
    );
  }

  let commandResult: CheckWorkspaceCommandResult | undefined;
  let commandThrew = false;
  try {
    commandResult = await input.runCommand();
  } catch {
    commandThrew = true;
  }
  if (commandResult?.processTreeStopped === false) {
    return hygieneFailure(
      "check_workspace_hygiene_process_tree_unterminated",
      CheckWorkspaceIntegrityDisposition.Unverified,
      commandResult,
    );
  }

  let violation: string | undefined;
  let after: WorkspaceSnapshot | undefined;
  try {
    await removeNewlyCreatedUntrackedPaths({
      workspacePath,
      paths: difference(
        await git.untrackedFiles(workspacePath),
        baseline.untrackedFiles,
      ),
    });
  } catch {
    violation = "check_workspace_hygiene_cleanup_failed";
  }
  try {
    after = await captureWorkspaceSnapshot({
      git,
      workspacePath,
      allowedWorkspaceFiles,
    });
    violation ??= workspaceViolation(baseline, after);
  } catch {
    violation ??= "check_workspace_hygiene_verification_failed";
  }

  if (violation !== undefined) {
    const restored = await tryRestoreWorkspaceSnapshot({
      git,
      workspacePath,
      allowedWorkspaceFiles,
      baseline,
      baselineIndex,
      ...(after === undefined ? {} : { after }),
    });
    return hygieneFailure(
      restored
        ? violation
        : "check_workspace_hygiene_restore_failed",
      restored
        ? CheckWorkspaceIntegrityDisposition.Restored
        : CheckWorkspaceIntegrityDisposition.Unverified,
      commandResult,
    );
  }
  if (commandThrew || commandResult === undefined) {
    return hygieneFailure(
      "check_workspace_hygiene_command_failed",
      CheckWorkspaceIntegrityDisposition.Unchanged,
    );
  }
  return {
    status: "completed",
    commandResult,
    workspaceIntegrity: CheckWorkspaceIntegrityDisposition.Unchanged,
  };
}

function hygieneFailure(
  safeError: string,
  workspaceIntegrity: CheckWorkspaceIntegrityDisposition,
  commandResult?: CheckWorkspaceCommandResult,
): CheckWorkspaceTransactionResult {
  return {
    status: "hygiene_failed",
    safeError,
    workspaceIntegrity,
    ...(commandResult === undefined ? {} : { commandResult }),
  };
}

async function tryRestoreWorkspaceSnapshot(input: {
  readonly git: CheckWorkspaceGit;
  readonly workspacePath: string;
  readonly allowedWorkspaceFiles: readonly string[];
  readonly baseline: WorkspaceSnapshot;
  readonly baselineIndex: IndexSnapshot;
  readonly after?: WorkspaceSnapshot;
}): Promise<boolean> {
  try {
    await restoreWorkspaceSnapshot(input);
    const restored = await captureWorkspaceSnapshot({
      git: input.git,
      workspacePath: input.workspacePath,
      allowedWorkspaceFiles: input.allowedWorkspaceFiles,
    });
    return workspaceViolation(input.baseline, restored) === undefined;
  } catch {
    return false;
  }
}

async function captureWorkspaceSnapshot(input: {
  readonly git: CheckWorkspaceGit;
  readonly workspacePath: string;
  readonly allowedWorkspaceFiles: readonly string[];
}): Promise<WorkspaceSnapshot> {
  const [
    worktreePatch,
    indexPatch,
    untrackedFiles,
    changedTrackedOrIndexFiles,
    trackedFiles,
    candidateEntries,
  ] = await Promise.all([
    input.git.diff(input.workspacePath, false),
    input.git.diff(input.workspacePath, true),
    input.git.untrackedFiles(input.workspacePath),
    input.git.changedTrackedOrIndexFiles(input.workspacePath),
    input.git.trackedFiles(input.workspacePath),
    captureCandidateEntries(input.workspacePath, input.allowedWorkspaceFiles),
  ]);
  return {
    worktreePatchSha256: sha256(worktreePatch),
    indexPatchSha256: sha256(indexPatch),
    untrackedFiles,
    changedTrackedOrIndexFiles,
    trackedFiles,
    candidateEntries,
  };
}

function assertBaselineWithinAllowedFiles(
  baseline: WorkspaceSnapshot,
  allowedWorkspaceFiles: readonly string[],
): void {
  const allowed = new Set(allowedWorkspaceFiles);
  for (const path of [
    ...baseline.changedTrackedOrIndexFiles,
    ...baseline.untrackedFiles,
  ]) {
    if (!allowed.has(path)) {
      throw new Error("check_workspace_baseline_outside_allowed_files");
    }
  }
}

function workspaceViolation(
  baseline: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): string | undefined {
  if (
    after.worktreePatchSha256 !== baseline.worktreePatchSha256 ||
    after.indexPatchSha256 !== baseline.indexPatchSha256
  ) {
    return "check_workspace_hygiene_tracked_or_index_changed";
  }
  if (!candidateEntriesEqual(after.candidateEntries, baseline.candidateEntries)) {
    return "check_workspace_hygiene_candidate_bytes_changed";
  }
  if (!setsEqual(after.untrackedFiles, baseline.untrackedFiles)) {
    return "check_workspace_hygiene_untracked_cleanup_incomplete";
  }
  return undefined;
}

async function restoreWorkspaceSnapshot(input: {
  readonly git: CheckWorkspaceGit;
  readonly workspacePath: string;
  readonly allowedWorkspaceFiles: readonly string[];
  readonly baseline: WorkspaceSnapshot;
  readonly baselineIndex: IndexSnapshot;
  readonly after?: WorkspaceSnapshot;
}): Promise<void> {
  await restoreIndexSnapshot(input.baselineIndex);
  for (const path of input.allowedWorkspaceFiles) {
    const entry = input.baseline.candidateEntries.get(path);
    if (entry === undefined) throw new Error("candidate_snapshot_missing");
    await restoreCandidateEntry(input.workspacePath, path, entry);
  }
  const currentChangedFiles = await input.git.changedTrackedOrIndexFiles(
    input.workspacePath,
  );
  const allowed = new Set(input.allowedWorkspaceFiles);
  const paths = uniqueSorted([
    ...input.baseline.changedTrackedOrIndexFiles,
    ...(input.after?.changedTrackedOrIndexFiles ?? []),
    ...currentChangedFiles,
    ...input.allowedWorkspaceFiles,
  ]);
  for (const path of paths) {
    if (allowed.has(path)) continue;
    await removeWorkspacePath(input.workspacePath, path);
    if (input.baseline.trackedFiles.has(path)) {
      await input.git.checkoutIndex(input.workspacePath, path);
    }
  }
  await removeNewlyCreatedUntrackedPaths({
    workspacePath: input.workspacePath,
    paths: difference(
      await input.git.untrackedFiles(input.workspacePath),
      input.baseline.untrackedFiles,
    ),
  });
}

async function captureIndexSnapshot(path: string): Promise<IndexSnapshot> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", path };
    }
    throw error;
  }
  if (!stat.isFile()) throw new Error("check_workspace_index_not_regular");
  return {
    kind: "file",
    path,
    mode: stat.mode & 0o7777,
    bytes: await readFile(path),
  };
}

async function restoreIndexSnapshot(snapshot: IndexSnapshot): Promise<void> {
  if (snapshot.kind === "missing") {
    await rm(snapshot.path, { force: true });
    return;
  }
  const tempPath = `${snapshot.path}.check-restore-${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, snapshot.bytes, {
      flag: "wx",
      mode: snapshot.mode,
    });
    await chmod(tempPath, snapshot.mode);
    await rename(tempPath, snapshot.path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function captureCandidateEntries(
  workspacePath: string,
  files: readonly string[],
): Promise<ReadonlyMap<string, CandidateEntry>> {
  return new Map(
    await Promise.all(
      files.map(async (file) => [
        file,
        await captureCandidateEntry(workspacePath, file),
      ] as const),
    ),
  );
}

async function captureCandidateEntry(
  workspacePath: string,
  relativePath: string,
): Promise<CandidateEntry> {
  const path = resolveWorkspacePath(workspacePath, relativePath);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    await assertSafeParentChain(workspacePath, dirname(path));
    return { kind: "symlink", mode, target: await readlink(path) };
  }
  if (!stat.isFile()) throw new Error("check_workspace_candidate_not_file");
  const canonical = await realpath(path);
  assertPathInside(canonical, workspacePath);
  return { kind: "file", mode, bytes: await readFile(canonical) };
}

async function restoreCandidateEntry(
  workspacePath: string,
  relativePath: string,
  entry: CandidateEntry,
): Promise<void> {
  const path = resolveWorkspacePath(workspacePath, relativePath);
  await assertSafeParentChain(workspacePath, dirname(path));
  await rm(path, { recursive: true, force: true });
  if (entry.kind === "missing") return;
  await mkdir(dirname(path), { recursive: true });
  await assertSafeParentChain(workspacePath, dirname(path));
  if (entry.kind === "symlink") {
    await symlink(entry.target, path);
    return;
  }
  await writeFile(path, entry.bytes, { mode: entry.mode });
  await chmod(path, entry.mode);
}

async function removeNewlyCreatedUntrackedPaths(input: {
  readonly workspacePath: string;
  readonly paths: readonly string[];
}): Promise<void> {
  for (const relativePath of [...input.paths].sort().reverse()) {
    await removeWorkspacePath(input.workspacePath, relativePath);
  }
}

async function removeWorkspacePath(
  workspacePath: string,
  relativePath: string,
): Promise<void> {
  const path = resolveWorkspacePath(workspacePath, relativePath);
  await assertSafeParentChain(workspacePath, dirname(path));
  await rm(path, { recursive: true, force: true });
}

async function assertSafeParentChain(
  workspacePath: string,
  parentPath: string,
): Promise<void> {
  assertPathInside(parentPath, workspacePath);
  const relativeParent = relative(workspacePath, parentPath);
  let current = workspacePath;
  for (const segment of relativeParent.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("check_workspace_parent_not_directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

class CheckWorkspaceGit {
  constructor(
    private readonly options: {
      readonly binaryPath: string;
      readonly timeoutMs: number;
      readonly maxBuffer: number;
    },
  ) {}

  async diff(workspacePath: string, cached: boolean): Promise<Buffer> {
    return await this.run([
      "diff",
      ...(cached ? ["--cached"] : []),
      "--binary",
      "--no-ext-diff",
      "--full-index",
      "--no-renames",
      "--",
      ".",
    ], workspacePath);
  }

  async untrackedFiles(workspacePath: string): Promise<ReadonlySet<string>> {
    return parseNullTerminatedPaths(await this.run([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
    ], workspacePath));
  }

  async trackedFiles(workspacePath: string): Promise<ReadonlySet<string>> {
    return parseNullTerminatedPaths(await this.run([
      "ls-files",
      "-z",
      "--",
      ".",
    ], workspacePath));
  }

  async changedTrackedOrIndexFiles(
    workspacePath: string,
  ): Promise<ReadonlySet<string>> {
    const [worktree, index] = await Promise.all([
      this.run(["diff", "--name-only", "--no-renames", "-z", "--", "."], workspacePath),
      this.run([
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
        "-z",
        "--",
        ".",
      ], workspacePath),
    ]);
    return new Set([
      ...parseNullTerminatedPaths(worktree),
      ...parseNullTerminatedPaths(index),
    ]);
  }

  async indexPath(workspacePath: string): Promise<string> {
    const output = await this.run([
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ], workspacePath);
    const path = output.toString("utf8").trim();
    if (!isAbsolute(path)) throw new Error("check_workspace_index_path_invalid");
    return path;
  }

  async checkoutIndex(workspacePath: string, path: string): Promise<void> {
    await this.run(["checkout-index", "--force", "--", path], workspacePath);
  }

  private async run(args: readonly string[], cwd: string): Promise<Buffer> {
    const result = await execFileAsync(this.options.binaryPath, [...args], {
      cwd,
      encoding: "buffer",
      timeout: this.options.timeoutMs,
      maxBuffer: this.options.maxBuffer,
    });
    return result.stdout;
  }
}

function parseNullTerminatedPaths(value: Buffer): ReadonlySet<string> {
  return new Set(
    value
      .toString("utf8")
      .split("\0")
      .filter((path) => path.length > 0)
      .map(normalizeProjectRelativePath),
  );
}

function resolveWorkspacePath(workspacePath: string, path: string): string {
  const resolved = resolve(workspacePath, normalizeProjectRelativePath(path));
  assertPathInside(resolved, workspacePath);
  return resolved;
}

function assertPathInside(path: string, root: string): void {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error("check_workspace_path_outside_root");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function difference(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): readonly string[] {
  return [...left].filter((value) => !right.has(value));
}

function candidateEntriesEqual(
  left: ReadonlyMap<string, CandidateEntry>,
  right: ReadonlyMap<string, CandidateEntry>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, entry] of left) {
    const other = right.get(path);
    if (other === undefined || candidateEntryHash(entry) !== candidateEntryHash(other)) {
      return false;
    }
  }
  return true;
}

function candidateEntryHash(entry: CandidateEntry): string {
  if (entry.kind === "missing") return "missing";
  if (entry.kind === "symlink") {
    return `symlink:${entry.mode}:${sha256(Buffer.from(entry.target))}`;
  }
  return `file:${entry.mode}:${sha256(entry.bytes)}`;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

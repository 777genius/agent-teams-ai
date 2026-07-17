import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

type GitWorkspace = {
  readonly rootPath: string;
  readonly workspacePath: string;
  readonly pathspec: string;
  readonly indexPath: string;
};

type WorkspaceEntry = {
  readonly path: string;
  readonly kind: "file" | "symlink" | "missing";
  readonly mode?: number;
  readonly digest?: string;
  readonly linkTarget?: string;
};

type WorkspaceState = {
  readonly status: Buffer;
  readonly indexEntries: Buffer;
  readonly entries: ReadonlyMap<string, WorkspaceEntry>;
};

type WorkspaceBaseline = WorkspaceState & {
  readonly backupRoot: string;
  readonly indexExisted: boolean;
  readonly indexMode?: number;
};

export async function withDependencyBootstrapWorkspaceTransaction<T>(input: {
  readonly workspacePath: string;
  readonly action: () => Promise<T>;
}): Promise<T> {
  const workspace = await resolveGitWorkspace(input.workspacePath);
  if (!workspace) return input.action();

  const backupRoot = await mkdtemp(
    join(tmpdir(), "subscription-runtime-dependency-bootstrap-"),
  );
  try {
    const baseline = await captureBaseline(workspace, backupRoot);
    let value: T;
    try {
      value = await input.action();
    } catch (error) {
      const current = await captureAfterAction(workspace, baseline, error);
      await rollbackWorkspace(workspace, baseline, current, error);
      throw error;
    }

    const current = await captureAfterAction(workspace, baseline);
    const mutations = workspaceMutations(baseline, current);
    if (mutations.length === 0) return value;

    const mutationError = new Error(
      `dependency_bootstrap_workspace_mutation_detected:${mutations.join(",")}`,
    );
    await rollbackWorkspace(workspace, baseline, current, mutationError);
    throw mutationError;
  } finally {
    await rm(backupRoot, { recursive: true, force: true });
  }
}

async function captureAfterAction(
  workspace: GitWorkspace,
  baseline: WorkspaceBaseline,
  originalError?: unknown,
): Promise<WorkspaceState> {
  try {
    return await captureWorkspaceState(workspace);
  } catch (error) {
    await rollbackWorkspace(workspace, baseline, undefined, error);
    throw new Error(
      `dependency_bootstrap_workspace_post_action_inspection_failed:${safeErrorMessage(error)}${
        originalError === undefined
          ? ""
          : `:original=${safeErrorMessage(originalError)}`
      }`,
    );
  }
}

async function resolveGitWorkspace(
  requestedWorkspacePath: string,
): Promise<GitWorkspace | undefined> {
  const workspacePath = await realpath(requestedWorkspacePath);
  let output: Buffer;
  try {
    output = await git(workspacePath, [
      "rev-parse",
      "--is-inside-work-tree",
      "--show-toplevel",
      "--path-format=absolute",
      "--git-path",
      "index",
    ]);
  } catch (error) {
    if (gitRepositoryMissing(error)) return undefined;
    throw new Error(
      `dependency_bootstrap_workspace_transaction_git_inspection_failed:${safeErrorMessage(error)}`,
    );
  }
  const lines = output.toString("utf8").trimEnd().split("\n");
  if (lines[0] !== "true" || !lines[1] || !lines[2]) {
    throw new Error("dependency_bootstrap_workspace_transaction_git_invalid");
  }
  const rootPath = await realpath(lines[1]);
  const workspaceRelative = normalizeGitPath(relative(rootPath, workspacePath));
  if (workspaceRelative === ".." || workspaceRelative.startsWith("../")) {
    throw new Error("dependency_bootstrap_workspace_transaction_scope_invalid");
  }
  const rawIndexPath = lines[2];
  return {
    rootPath,
    workspacePath,
    pathspec:
      workspaceRelative.length === 0
        ? "."
        : `:(top,literal)${workspaceRelative}`,
    indexPath: isAbsolute(rawIndexPath)
      ? rawIndexPath
      : resolve(workspacePath, rawIndexPath),
  };
}

async function captureBaseline(
  workspace: GitWorkspace,
  backupRoot: string,
): Promise<WorkspaceBaseline> {
  const state = await captureWorkspaceState(workspace);
  for (const entry of state.entries.values()) {
    if (entry.kind === "file") {
      const source = workspaceEntryPath(workspace, entry.path);
      const destination = join(backupRoot, "entries", entry.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      if (entry.mode !== undefined) await chmod(destination, entry.mode);
    }
  }

  const indexStat = await lstatOrUndefined(workspace.indexPath);
  if (indexStat?.isDirectory()) {
    throw new Error("dependency_bootstrap_workspace_transaction_index_invalid");
  }
  if (indexStat) {
    const indexBackupPath = join(backupRoot, "index");
    await copyFile(workspace.indexPath, indexBackupPath);
    await chmod(indexBackupPath, indexStat.mode & 0o7777);
  }
  return {
    ...state,
    backupRoot,
    indexExisted: indexStat !== undefined,
    ...(indexStat ? { indexMode: indexStat.mode & 0o7777 } : {}),
  };
}

async function captureWorkspaceState(
  workspace: GitWorkspace,
): Promise<WorkspaceState> {
  const [status, indexEntries, tracked, untracked] = await Promise.all([
    git(workspace.rootPath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      workspace.pathspec,
    ]),
    git(workspace.rootPath, [
      "ls-files",
      "--stage",
      "--full-name",
      "-z",
      "--",
      workspace.pathspec,
    ]),
    gitPaths(workspace, ["ls-files", "--cached", "--full-name", "-z"]),
    gitPaths(workspace, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--full-name",
      "-z",
    ]),
  ]);
  const paths = [...new Set([...tracked, ...untracked])].sort((left, right) =>
    left.localeCompare(right),
  );
  const entries = new Map<string, WorkspaceEntry>();
  for (const path of paths) {
    entries.set(path, await inspectWorkspaceEntry(workspace, path));
  }
  return { status, indexEntries, entries };
}

async function inspectWorkspaceEntry(
  workspace: GitWorkspace,
  path: string,
): Promise<WorkspaceEntry> {
  const absolutePath = workspaceEntryPath(workspace, path);
  const entryStat = await lstatOrUndefined(absolutePath);
  if (!entryStat) return { path, kind: "missing" };
  if (entryStat.isSymbolicLink()) {
    return {
      path,
      kind: "symlink",
      mode: entryStat.mode & 0o7777,
      linkTarget: await readlink(absolutePath),
    };
  }
  if (entryStat.isFile()) {
    return {
      path,
      kind: "file",
      mode: entryStat.mode & 0o7777,
      digest: createHash("sha256")
        .update(await readFile(absolutePath))
        .digest("hex"),
    };
  }
  throw new Error(
    `dependency_bootstrap_workspace_transaction_entry_unsupported:${path}`,
  );
}

async function rollbackWorkspace(
  workspace: GitWorkspace,
  baseline: WorkspaceBaseline,
  current: WorkspaceState | undefined,
  originalError: unknown,
): Promise<void> {
  try {
    await restoreIndex(workspace, baseline);
    await removeExtraEntries(
      workspace,
      baseline,
      current?.entries.keys() ?? [],
    );
    await restoreBaselineEntries(workspace, baseline);

    const restoredView = await captureWorkspaceState(workspace);
    await removeExtraEntries(
      workspace,
      baseline,
      restoredView.entries.keys(),
    );
    await restoreBaselineEntries(workspace, baseline);

    const verified = await captureWorkspaceState(workspace);
    const remaining = workspaceMutations(baseline, verified);
    if (remaining.length > 0) {
      throw new Error(
        `rollback_verification_failed:${remaining.join(",")}`,
      );
    }
  } catch (rollbackError) {
    throw new Error(
      `dependency_bootstrap_workspace_rollback_failed:${safeErrorMessage(rollbackError)}:original=${safeErrorMessage(originalError)}`,
    );
  }
}

async function restoreIndex(
  workspace: GitWorkspace,
  baseline: WorkspaceBaseline,
): Promise<void> {
  if (!baseline.indexExisted) {
    await rm(workspace.indexPath, { force: true });
    return;
  }
  await mkdir(dirname(workspace.indexPath), { recursive: true });
  const temporaryIndexPath = `${workspace.indexPath}.dependency-bootstrap-${process.pid}`;
  await copyFile(join(baseline.backupRoot, "index"), temporaryIndexPath);
  if (baseline.indexMode !== undefined) {
    await chmod(temporaryIndexPath, baseline.indexMode);
  }
  await rename(temporaryIndexPath, workspace.indexPath);
}

async function removeExtraEntries(
  workspace: GitWorkspace,
  baseline: WorkspaceBaseline,
  observedPaths: Iterable<string>,
): Promise<void> {
  const baselinePaths = new Set(baseline.entries.keys());
  const extras = [...observedPaths]
    .filter((path) => !baselinePaths.has(path))
    .sort((left, right) => pathDepth(right) - pathDepth(left));
  for (const path of extras) {
    await rm(workspaceEntryPath(workspace, path), {
      recursive: true,
      force: true,
    });
  }
}

async function restoreBaselineEntries(
  workspace: GitWorkspace,
  baseline: WorkspaceBaseline,
): Promise<void> {
  const entries = [...baseline.entries.values()].sort(
    (left, right) => pathDepth(left.path) - pathDepth(right.path),
  );
  for (const entry of entries) {
    const destination = workspaceEntryPath(workspace, entry.path);
    await rm(destination, { recursive: true, force: true });
    if (entry.kind === "missing") continue;
    await mkdir(dirname(destination), { recursive: true });
    if (entry.kind === "symlink") {
      await symlink(entry.linkTarget ?? "", destination);
      continue;
    }
    const source = join(baseline.backupRoot, "entries", entry.path);
    await copyFile(source, destination);
    if (entry.mode !== undefined) await chmod(destination, entry.mode);
  }
}

function workspaceMutations(
  baseline: WorkspaceState,
  current: WorkspaceState,
): readonly string[] {
  const mutations = new Set<string>();
  const paths = new Set([...baseline.entries.keys(), ...current.entries.keys()]);
  for (const path of paths) {
    if (!sameEntry(baseline.entries.get(path), current.entries.get(path))) {
      mutations.add(path);
    }
  }
  if (!baseline.indexEntries.equals(current.indexEntries)) {
    mutations.add("<git-index>");
  }
  if (!baseline.status.equals(current.status)) mutations.add("<git-status>");
  return [...mutations].sort((left, right) => left.localeCompare(right));
}

function sameEntry(
  left: WorkspaceEntry | undefined,
  right: WorkspaceEntry | undefined,
): boolean {
  return (
    left?.kind === right?.kind &&
    left?.mode === right?.mode &&
    left?.digest === right?.digest &&
    left?.linkTarget === right?.linkTarget
  );
}

async function gitPaths(
  workspace: GitWorkspace,
  args: readonly string[],
): Promise<readonly string[]> {
  const output = await git(workspace.rootPath, [
    ...args,
    "--",
    workspace.pathspec,
  ]);
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((path) => assertWorkspaceGitPath(workspace, path));
}

async function git(cwd: string, args: readonly string[]): Promise<Buffer> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "buffer",
    timeout: 30_000,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
}

function assertWorkspaceGitPath(
  workspace: GitWorkspace,
  rawPath: string,
): string {
  const path = normalizeGitPath(rawPath);
  if (
    path.length === 0 ||
    path === ".." ||
    path.startsWith("../") ||
    path.startsWith("/") ||
    path.includes("\0")
  ) {
    throw new Error("dependency_bootstrap_workspace_transaction_path_invalid");
  }
  workspaceEntryPath(workspace, path);
  return path;
}

function workspaceEntryPath(workspace: GitWorkspace, path: string): string {
  const absolutePath = resolve(workspace.rootPath, path);
  const relativeToWorkspace = relative(workspace.workspacePath, absolutePath);
  if (
    relativeToWorkspace === ".." ||
    relativeToWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(relativeToWorkspace)
  ) {
    throw new Error("dependency_bootstrap_workspace_transaction_path_outside_scope");
  }
  return absolutePath;
}

function normalizeGitPath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function gitRepositoryMissing(error: unknown): boolean {
  return /not a git repository/i.test(safeErrorMessage(error));
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type {
  SafeExecutionCommandRunner,
  WorkspaceDiffFileStat,
  WorkspaceSnapshot,
  WorkspaceSnapshotter,
} from "@vioxen/subscription-runtime/worker-core";
import { NodeSafeExecutionCommandRunner } from "./node-safe-execution-command-runner";

export type DefaultWorkspaceSnapshotterOptions = {
  readonly commandRunner?: SafeExecutionCommandRunner;
  readonly gitBinaryPath?: string;
  readonly commandTimeoutMs?: number;
  readonly maxDiffBytes?: number;
  readonly maxFilesystemEntries?: number;
  readonly ignoredDirectories?: readonly string[];
};

export class DefaultWorkspaceSnapshotter implements WorkspaceSnapshotter {
  private readonly commandRunner: SafeExecutionCommandRunner;
  private readonly gitBinaryPath: string;
  private readonly commandTimeoutMs: number;
  private readonly maxDiffBytes: number;
  private readonly maxFilesystemEntries: number;
  private readonly ignoredDirectories: readonly string[];

  constructor(options: DefaultWorkspaceSnapshotterOptions = {}) {
    this.commandRunner =
      options.commandRunner ?? new NodeSafeExecutionCommandRunner();
    this.gitBinaryPath = options.gitBinaryPath ?? "git";
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
    this.maxDiffBytes = options.maxDiffBytes ?? 24_000;
    this.maxFilesystemEntries = options.maxFilesystemEntries ?? 2_000;
    this.ignoredDirectories = options.ignoredDirectories ?? [
      ".git",
      "node_modules",
      "dist",
      ".next",
      ".turbo",
      "coverage",
    ];
  }

  async capture(input: {
    readonly workspacePath: string;
    readonly includeDiff?: boolean;
    readonly abortSignal?: AbortSignal;
  }): Promise<WorkspaceSnapshot> {
    const workspacePath = await canonicalWorkspacePath(input.workspacePath);
    const capturedAt = new Date();
    const gitWorkspace = await this.gitWorkspaceInfo(
      workspacePath,
      input.abortSignal,
    );
    if (gitWorkspace) {
      return this.captureGit({
        ...input,
        workspacePath,
        capturedAt,
        workspaceRelativePrefix: gitWorkspace.relativePrefix,
        gitRootPath: gitWorkspace.rootPath,
      });
    }
    return this.captureFilesystem({ ...input, workspacePath, capturedAt });
  }

  private async captureGit(input: {
    readonly workspacePath: string;
    readonly includeDiff?: boolean;
    readonly abortSignal?: AbortSignal;
    readonly capturedAt: Date;
    readonly workspaceRelativePrefix: string;
    readonly gitRootPath: string;
  }): Promise<WorkspaceSnapshot> {
    const status = await this.git(
      input.workspacePath,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
      input.abortSignal,
    );
    const statusEntries = status.stdout.split("\0").filter(Boolean);
    const headTree = await this.gitHeadTree(
      input.gitRootPath,
      input.workspaceRelativePrefix,
      input.abortSignal,
    );
    const changedFiles = mergeChangedFiles(
      gitStatusChangedFiles(statusEntries, input.workspaceRelativePrefix),
      await this.gitDiffNameOnly(input.workspacePath, input.abortSignal),
    );
    const diffStat = await this.gitDiffStat(
      input.workspacePath,
      input.abortSignal,
    );
    const diffNumstat = await this.gitDiffNumstat(
      input.workspacePath,
      input.abortSignal,
    );
    const shortDiff = input.includeDiff
      ? await this.shortGitDiff(input.workspacePath, input.abortSignal)
      : undefined;
    return {
      mode: "git",
      workspacePath: input.workspacePath,
      capturedAt: input.capturedAt,
      dirty: changedFiles.length > 0,
      changedFiles,
      ...(diffNumstat.length === 0 ? {} : { diffNumstat }),
      fingerprint: hashText(
        [`head-tree:${headTree}`, ...statusEntries].join("\n"),
      ),
      summary:
        changedFiles.length === 0
          ? "Git workspace is clean."
          : `Git workspace has ${changedFiles.length} changed file(s).`,
      ...(diffStat ? { diffStat } : {}),
      ...(shortDiff === undefined ? {} : { shortDiff: shortDiff.value }),
      ...(shortDiff?.truncated ? { truncated: true } : {}),
    };
  }

  private async captureFilesystem(input: {
    readonly workspacePath: string;
    readonly capturedAt: Date;
  }): Promise<WorkspaceSnapshot> {
    const files = await this.scanFilesystem(input.workspacePath);
    return {
      mode: "filesystem",
      workspacePath: input.workspacePath,
      capturedAt: input.capturedAt,
      dirty: false,
      changedFiles: files.map((file) => file.path),
      fingerprint: hashText(
        files
          .map((file) => `${file.path}:${file.size}:${file.mtimeMs}`)
          .join("\n"),
      ),
      summary: `Filesystem snapshot captured ${files.length} entries.`,
      ...(files.length >= this.maxFilesystemEntries
        ? {
            truncated: true,
            warnings: ["filesystem_snapshot_entry_limit_reached"],
          }
        : {}),
    };
  }

  private async gitWorkspaceInfo(
    workspacePath: string,
    abortSignal?: AbortSignal,
  ): Promise<{
    readonly relativePrefix: string;
    readonly rootPath: string;
  } | null> {
    const result = await this.git(
      workspacePath,
      [
        "rev-parse",
        "--is-inside-work-tree",
        "--show-prefix",
        "--show-toplevel",
      ],
      abortSignal,
    ).catch(() => null);
    const lines =
      result?.stdout.split("\n").map((line) => line.trimEnd()) ?? [];
    if (lines[0] !== "true") return null;
    const prefix = normalizeRelativePath(lines[1] ?? "").replace(/\/$/, "");
    return { relativePrefix: prefix, rootPath: lines[2] || workspacePath };
  }

  private async git(
    cwd: string,
    args: readonly string[],
    abortSignal?: AbortSignal,
  ): Promise<{ readonly stdout: string; readonly stderr: string }> {
    return this.commandRunner.run({
      command: this.gitBinaryPath,
      args,
      cwd,
      timeoutMs: this.commandTimeoutMs,
      maxBufferBytes: Math.max(1024 * 1024, this.maxDiffBytes * 2),
      ...(abortSignal === undefined ? {} : { abortSignal }),
    });
  }

  private async shortGitDiff(
    workspacePath: string,
    abortSignal?: AbortSignal,
  ): Promise<{ readonly value: string; readonly truncated: boolean }> {
    const value = await this.gitDiffOutputs(workspacePath, [], abortSignal);
    if (value.length <= this.maxDiffBytes) {
      return { value, truncated: false };
    }
    return {
      value: value.slice(0, this.maxDiffBytes),
      truncated: true,
    };
  }

  private async gitDiffNameOnly(
    workspacePath: string,
    abortSignal?: AbortSignal,
  ): Promise<readonly string[]> {
    const value = await this.gitDiffOutputs(
      workspacePath,
      ["--name-only"],
      abortSignal,
    );
    return value
      .split("\n")
      .map((line) => normalizeRelativePath(line.trim()))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  }

  private async gitDiffNumstat(
    workspacePath: string,
    abortSignal?: AbortSignal,
  ): Promise<readonly WorkspaceDiffFileStat[]> {
    return parseGitNumstat(
      await this.gitDiffOutputs(workspacePath, ["--numstat"], abortSignal),
    );
  }

  private async gitHeadTree(
    workspacePath: string,
    workspaceRelativePrefix: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    if (!workspaceRelativePrefix) {
      const result = await this.git(
        workspacePath,
        ["rev-parse", "HEAD^{tree}"],
        abortSignal,
      ).catch(() => ({ stdout: "", stderr: "" }));
      return result.stdout.trim();
    }

    const result = await this.git(
      workspacePath,
      ["ls-tree", "HEAD", "--", workspaceRelativePrefix],
      abortSignal,
    ).catch(() => ({ stdout: "", stderr: "" }));
    const match = result.stdout.match(/\s([0-9a-f]{40,64})\t/);
    return match?.[1] ?? "";
  }

  private async gitDiffStat(
    workspacePath: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    return (
      await this.gitDiffOutputs(workspacePath, ["--stat"], abortSignal)
    ).trim();
  }

  private async gitDiffOutputs(
    workspacePath: string,
    args: readonly string[],
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const outputs = [
      await this.gitDiffOutput(workspacePath, args, false, abortSignal),
      await this.gitDiffOutput(workspacePath, args, true, abortSignal),
    ];
    return outputs.filter(Boolean).join("\n");
  }

  private async gitDiffOutput(
    workspacePath: string,
    args: readonly string[],
    cached: boolean,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const result = await this.git(
      workspacePath,
      [
        "diff",
        "--relative",
        ...(cached ? ["--cached"] : []),
        ...args,
        "--no-ext-diff",
        "--",
        ".",
      ],
      abortSignal,
    ).catch(() => ({ stdout: "", stderr: "" }));
    return result.stdout;
  }

  private async scanFilesystem(
    workspacePath: string,
  ): Promise<
    readonly {
      readonly path: string;
      readonly size: number;
      readonly mtimeMs: number;
    }[]
  > {
    const files: { path: string; size: number; mtimeMs: number }[] = [];
    const visit = async (dir: string): Promise<void> => {
      if (files.length >= this.maxFilesystemEntries) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        if (files.length >= this.maxFilesystemEntries) return;
        if (entry.isSymbolicLink()) continue;
        const fullPath = join(dir, entry.name);
        const rel = normalizeRelativePath(relative(workspacePath, fullPath));
        if (entry.isDirectory()) {
          if (this.ignoredDirectories.includes(entry.name)) continue;
          await visit(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const fileStat = await stat(fullPath).catch(() => null);
        if (!fileStat) continue;
        files.push({
          path: rel,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        });
      }
    };
    await visit(workspacePath);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }
}

function gitStatusChangedFiles(
  entries: readonly string[],
  workspaceRelativePrefix = "",
): readonly string[] {
  const files = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
    const relativePath = stripWorkspacePrefix(path, workspaceRelativePrefix);
    if (relativePath) files.add(relativePath);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function stripWorkspacePrefix(
  path: string,
  workspaceRelativePrefix: string,
): string | null {
  const normalizedPath = normalizeRelativePath(path);
  const normalizedPrefix = normalizeRelativePath(workspaceRelativePrefix);
  if (!normalizedPrefix) return normalizedPath;
  if (normalizedPath === normalizedPrefix) return basename(normalizedPath);
  const prefix = `${normalizedPrefix}/`;
  if (!normalizedPath.startsWith(prefix)) return null;
  return normalizedPath.slice(prefix.length);
}

function mergeChangedFiles(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  return [...new Set([...left, ...right])]
    .filter(Boolean)
    .sort((leftFile, rightFile) => leftFile.localeCompare(rightFile));
}

function parseGitNumstat(value: string): readonly WorkspaceDiffFileStat[] {
  const byPath = new Map<string, WorkspaceDiffFileStat>();
  for (const line of value.split("\n")) {
    if (!line.trim()) continue;
    const [rawAdditions, rawDeletions, ...pathParts] = line.split("\t");
    const path = normalizeRelativePath(pathParts.join("\t").trim());
    if (!path) continue;
    const binary = rawAdditions === "-" || rawDeletions === "-";
    const additions = binary ? 0 : Number(rawAdditions);
    const deletions = binary ? 0 : Number(rawDeletions);
    if (
      !binary &&
      (!Number.isFinite(additions) || !Number.isFinite(deletions))
    ) {
      continue;
    }
    const existing = byPath.get(path);
    byPath.set(path, {
      path,
      additions: (existing?.additions ?? 0) + additions,
      deletions: (existing?.deletions ?? 0) + deletions,
      ...(binary || existing?.binary ? { binary: true } : {}),
    });
  }
  return [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

async function canonicalWorkspacePath(path: string): Promise<string> {
  const resolved = resolve(path);
  return realpath(resolved).catch(() => resolved);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const tempRoots: string[] = [];

export async function createGitFixture(): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly workerCommitSha: string;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "project-integration-adapters-"));
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const remotePath = join(rootDir, "remote.git");
  await mkdir(workspacePath);
  try {
    await git(workspacePath, ["init"]);
    await git(workspacePath, ["checkout", "-b", "main"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await mkdir(join(workspacePath, "src"));
    await writeFile(join(workspacePath, "src", "memory.ts"), "export const value = 1;\n");
    await git(workspacePath, ["add", "."]);
    await git(workspacePath, ["commit", "-m", "chore: initial"]);
    await execFileAsync("git", ["init", "--bare", remotePath]);
    await git(workspacePath, ["remote", "add", "origin", remotePath]);
    await git(workspacePath, ["checkout", "-b", "worker"]);
    await writeFile(join(workspacePath, "src", "memory.ts"), "export const value = 2;\n");
    await git(workspacePath, ["add", "."]);
    await git(workspacePath, ["commit", "-m", "fix: worker output"]);
    const workerCommitSha = (await gitOutput(workspacePath, ["rev-parse", "HEAD"])).trim();
    await git(workspacePath, ["checkout", "main"]);
    return { rootDir, workspacePath, workerCommitSha };
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

export async function createMergeFixture(): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly sourceCommit: string;
  readonly targetCommit: string;
  readonly patchPath: string;
  readonly patchSha256: string;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "project-integration-merge-"));
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const remotePath = join(rootDir, "remote.git");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  await writeFile(
    join(workspacePath, "src", "memory.ts"),
    "export const value = 1;\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "chore: initial"]);
  await execFileAsync("git", ["init", "--bare", remotePath]);
  await git(workspacePath, ["remote", "add", "origin", remotePath]);
  await git(workspacePath, ["checkout", "-b", "base"]);
  await writeFile(
    join(workspacePath, "src", "memory.ts"),
    "export const value = 2;\n",
  );
  await writeFile(
    join(workspacePath, "src", "base-change.ts"),
    "export const baseChange = true;\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: update base"]);
  const sourceCommit = (await gitOutput(
    workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await git(workspacePath, ["push", "origin", "base"]);
  await git(workspacePath, ["checkout", "main"]);
  await writeFile(
    join(workspacePath, "src", "memory.ts"),
    "export const value = 4;\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: update target"]);
  const targetCommit = (await gitOutput(
    workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await git(workspacePath, ["push", "origin", "main"]);
  await writeFile(
    join(workspacePath, "src", "memory.ts"),
    "export const value = 3;\n",
  );
  const patch = await gitOutput(workspacePath, ["diff", "--binary"]);
  const patchPath = join(rootDir, "reviewed-resolution.patch");
  await writeFile(patchPath, patch);
  const patchSha256 = createHash("sha256").update(patch).digest("hex");
  await git(workspacePath, ["checkout", "--", "src/memory.ts"]);
  return {
    rootDir,
    workspacePath,
    sourceCommit,
    targetCommit,
    patchPath,
    patchSha256,
  };
}

export async function createSemanticMergeFixture(input: {
  readonly includeUnrelatedPath?: boolean;
} = {}): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly sourceCommit: string;
  readonly targetCommit: string;
  readonly patchPath: string;
  readonly patchSha256: string;
  readonly changedFiles: readonly string[];
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "project-integration-semantic-merge-"));
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const remotePath = join(rootDir, "remote.git");
  await mkdir(join(workspacePath, ".github", "workflows"), { recursive: true });
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  await writeFile(join(workspacePath, "package.json"), '{"policy":"initial"}\n');
  await writeFile(
    join(workspacePath, ".github", "workflows", "ci.yml"),
    "name: CI\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
  );
  await writeFile(
    join(workspacePath, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  await writeFile(join(workspacePath, "README.md"), "initial\n");
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "chore: initial"]);
  await execFileAsync("git", ["init", "--bare", remotePath]);
  await git(workspacePath, ["remote", "add", "origin", remotePath]);

  await git(workspacePath, ["checkout", "-b", "base"]);
  await writeFile(join(workspacePath, "package.json"), '{"policy":"base"}\n');
  await writeFile(
    join(workspacePath, ".github", "workflows", "ci.yml"),
    "name: CI\njobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n",
  );
  await writeFile(
    join(workspacePath, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\nallowBuilds:\n  better-sqlite3: true\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: update base policy"]);
  const sourceCommit = (await gitOutput(workspacePath, ["rev-parse", "HEAD"])).trim();
  await git(workspacePath, ["push", "origin", "base"]);

  await git(workspacePath, ["checkout", "main"]);
  await writeFile(join(workspacePath, "package.json"), '{"policy":"target"}\n');
  await writeFile(
    join(workspacePath, ".github", "workflows", "ci.yml"),
    "name: Hosted Web CI\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
  );
  await writeFile(
    join(workspacePath, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n  - apps/*\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: update target policy"]);
  const targetCommit = (await gitOutput(workspacePath, ["rev-parse", "HEAD"])).trim();
  await git(workspacePath, ["push", "origin", "main"]);

  await writeFile(
    join(workspacePath, "package.json"),
    '{"policy":"hosted-web-merged"}\n',
  );
  await writeFile(
    join(workspacePath, ".github", "workflows", "ci.yml"),
    "name: Hosted Web CI\njobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n",
  );
  await writeFile(
    join(workspacePath, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n  - apps/*\nallowBuilds:\n  better-sqlite3: true\n",
  );
  const changedFiles = [
    ".github/workflows/ci.yml",
    "package.json",
    "pnpm-workspace.yaml",
    ...(input.includeUnrelatedPath ? ["README.md"] : []),
  ];
  if (input.includeUnrelatedPath) {
    await writeFile(join(workspacePath, "README.md"), "unrelated semantic edit\n");
  }
  const patch = await gitOutput(workspacePath, ["diff", "--binary", "--", ...changedFiles]);
  const patchPath = join(rootDir, "reviewed-semantic-resolution.patch");
  await writeFile(patchPath, patch);
  const patchSha256 = createHash("sha256").update(patch).digest("hex");
  await git(workspacePath, ["checkout", "--", ...changedFiles]);
  return {
    rootDir,
    workspacePath,
    sourceCommit,
    targetCommit,
    patchPath,
    patchSha256,
    changedFiles,
  };
}

export async function createCleanMergeFixture(input: {
  readonly deleteSourcePath?: boolean;
} = {}): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly sourceCommit: string;
  readonly targetCommit: string;
  readonly patchPath: string;
  readonly patchSha256: string;
}> {
  const rootDir = await mkdtemp(
    join(tmpdir(), "project-integration-clean-merge-"),
  );
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const remotePath = join(rootDir, "remote.git");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  await writeFile(
    join(workspacePath, "src", "shared.ts"),
    "export const shared = true;\n",
  );
  if (input.deleteSourcePath) {
    await writeFile(
      join(workspacePath, "src", "deleted-by-base.ts"),
      "export const deletedByBase = true;\n",
    );
  }
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "chore: initial"]);
  await execFileAsync("git", ["init", "--bare", remotePath]);
  await git(workspacePath, ["remote", "add", "origin", remotePath]);

  await git(workspacePath, ["checkout", "-b", "base"]);
  await writeFile(
    join(workspacePath, "src", "from-base.ts"),
    "export const fromBase = true;\n",
  );
  if (input.deleteSourcePath) {
    await git(workspacePath, ["rm", "src/deleted-by-base.ts"]);
  }
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: add base source"]);
  const sourceCommit = (await gitOutput(
    workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await git(workspacePath, ["push", "origin", "base"]);

  await git(workspacePath, ["checkout", "main"]);
  await writeFile(
    join(workspacePath, "src", "from-target.ts"),
    "export const fromTarget = true;\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: add target source"]);
  const targetCommit = (await gitOutput(
    workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await git(workspacePath, ["push", "origin", "main"]);

  const patchPath = join(rootDir, "reviewed-empty.patch");
  await writeFile(patchPath, "");
  return {
    rootDir,
    workspacePath,
    sourceCommit,
    targetCommit,
    patchPath,
    patchSha256: createHash("sha256").update("").digest("hex"),
  };
}

export async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

export async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout;
}

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
  const rootDir = await mkdtemp(
    join(tmpdir(), "project-integration-adapters-"),
  );
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
    await writeFile(
      join(workspacePath, "src", "memory.ts"),
      "export const value = 1;\n",
    );
    await git(workspacePath, ["add", "."]);
    await git(workspacePath, ["commit", "-m", "chore: initial"]);
    await execFileAsync("git", ["init", "--bare", remotePath]);
    await git(workspacePath, ["remote", "add", "origin", remotePath]);
    await git(workspacePath, ["checkout", "-b", "worker"]);
    await writeFile(
      join(workspacePath, "src", "memory.ts"),
      "export const value = 2;\n",
    );
    await git(workspacePath, ["add", "."]);
    await git(workspacePath, ["commit", "-m", "fix: worker output"]);
    const workerCommitSha = (
      await gitOutput(workspacePath, ["rev-parse", "HEAD"])
    ).trim();
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
  const sourceCommit = (
    await gitOutput(workspacePath, ["rev-parse", "HEAD"])
  ).trim();
  await git(workspacePath, ["push", "origin", "base"]);
  await git(workspacePath, ["checkout", "main"]);
  await writeFile(
    join(workspacePath, "src", "memory.ts"),
    "export const value = 4;\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: update target"]);
  const targetCommit = (
    await gitOutput(workspacePath, ["rev-parse", "HEAD"])
  ).trim();
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

export async function createTargetOnlyConflictMergeFixture(): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly sourceCommit: string;
  readonly targetCommit: string;
  readonly patchPath: string;
  readonly patchSha256: string;
  readonly approvedFiles: readonly string[];
  readonly patchFiles: readonly string[];
  readonly expectedAppliedFiles: readonly string[];
}> {
  const rootDir = await mkdtemp(
    join(tmpdir(), "project-integration-target-only-conflict-"),
  );
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const remotePath = join(rootDir, "remote.git");
  const approvedFiles = [
    "src/member-lifecycle.ts",
    "src/safe-e2e.ts",
    "src/service.ts",
    "src/source-added-facade.ts",
    "src/stop-flow.ts",
  ];
  const patchFiles = [
    "src/member-lifecycle.ts",
    "src/safe-e2e.ts",
    "src/service.ts",
    "src/source-added-facade.ts",
  ];
  const expectedAppliedFiles = ["src/base-change.ts", ...patchFiles].sort();

  await mkdir(join(workspacePath, "src"), { recursive: true });
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  for (const file of approvedFiles.filter(
    (file) => file !== "src/source-added-facade.ts",
  )) {
    await writeFile(
      join(workspacePath, file),
      file === "src/member-lifecycle.ts"
        ? memberLifecycleContent()
        : `${file}: initial\n`,
    );
  }
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "chore: initial"]);
  await execFileAsync("git", ["init", "--bare", remotePath]);
  await git(workspacePath, ["remote", "add", "origin", remotePath]);

  await git(workspacePath, ["checkout", "-b", "base"]);
  for (const file of approvedFiles) {
    await writeFile(
      join(workspacePath, file),
      file === "src/member-lifecycle.ts"
        ? memberLifecycleContent({ baseLine: "base-side lifecycle policy" })
        : `${file}: base\n`,
    );
  }
  await writeFile(
    join(workspacePath, "src", "base-change.ts"),
    "export const baseChange = true;\n",
  );
  await writeFile(
    join(workspacePath, "src", "source-added-facade.ts"),
    "src/source-added-facade.ts: base\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: update base"]);
  const sourceCommit = (
    await gitOutput(workspacePath, ["rev-parse", "HEAD"])
  ).trim();
  await git(workspacePath, ["push", "origin", "base"]);

  await git(workspacePath, ["checkout", "main"]);
  for (const file of approvedFiles.filter(
    (file) =>
      file !== "src/member-lifecycle.ts" &&
      file !== "src/source-added-facade.ts",
  )) {
    await writeFile(join(workspacePath, file), `${file}: target\n`);
  }
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: update target"]);
  const targetCommit = (
    await gitOutput(workspacePath, ["rev-parse", "HEAD"])
  ).trim();
  await git(workspacePath, ["push", "origin", "main"]);

  for (const file of patchFiles) {
    await writeFile(
      join(workspacePath, file),
      file === "src/member-lifecycle.ts"
        ? memberLifecycleContent({
            workerLine: "worker-side lifecycle assertion",
          })
        : `${file}: reviewed merge\n`,
    );
  }
  await git(workspacePath, [
    "add",
    "--intent-to-add",
    "--",
    "src/source-added-facade.ts",
  ]);
  const patch = await gitOutput(workspacePath, [
    "diff",
    "--binary",
    "--",
    ...patchFiles,
  ]);
  const patchPath = join(rootDir, "reviewed-target-only-resolution.patch");
  await writeFile(patchPath, patch);
  const patchSha256 = createHash("sha256").update(patch).digest("hex");
  await git(workspacePath, ["reset", "--", "src/source-added-facade.ts"]);
  await rm(join(workspacePath, "src", "source-added-facade.ts"));
  await git(workspacePath, [
    "checkout",
    "--",
    ...patchFiles.filter((file) => file !== "src/source-added-facade.ts"),
  ]);

  return {
    rootDir,
    workspacePath,
    sourceCommit,
    targetCommit,
    patchPath,
    patchSha256,
    approvedFiles,
    patchFiles,
    expectedAppliedFiles,
  };
}

function memberLifecycleContent(
  input: {
    readonly baseLine?: string;
    readonly workerLine?: string;
  } = {},
): string {
  return (
    [
      "member lifecycle",
      input.baseLine ?? "initial lifecycle policy",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      input.workerLine ?? "initial lifecycle assertion",
      "line 10",
    ].join("\n") + "\n"
  );
}

export async function createSemanticMergeFixture(
  input: {
    readonly includeUnrelatedPath?: boolean;
    readonly includeSourceChangedSemanticPath?: boolean;
  } = {},
): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly sourceCommit: string;
  readonly targetCommit: string;
  readonly patchPath: string;
  readonly patchSha256: string;
  readonly changedFiles: readonly string[];
}> {
  const rootDir = await mkdtemp(
    join(tmpdir(), "project-integration-semantic-merge-"),
  );
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const remotePath = join(rootDir, "remote.git");
  await mkdir(join(workspacePath, ".github", "workflows"), { recursive: true });
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  await writeFile(
    join(workspacePath, "package.json"),
    '{"policy":"initial"}\n',
  );
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
  if (input.includeSourceChangedSemanticPath) {
    await writeFile(
      join(workspacePath, "README.md"),
      "base automatic change\n",
    );
  }
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: update base policy"]);
  const sourceCommit = (
    await gitOutput(workspacePath, ["rev-parse", "HEAD"])
  ).trim();
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
  const targetCommit = (
    await gitOutput(workspacePath, ["rev-parse", "HEAD"])
  ).trim();
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
    ...(input.includeUnrelatedPath || input.includeSourceChangedSemanticPath
      ? ["README.md"]
      : []),
  ];
  if (input.includeUnrelatedPath || input.includeSourceChangedSemanticPath) {
    await writeFile(
      join(workspacePath, "README.md"),
      input.includeSourceChangedSemanticPath
        ? "reviewed semantic resolution\n"
        : "unrelated semantic edit\n",
    );
  }
  const patch = await gitOutput(workspacePath, [
    "diff",
    "--binary",
    "--",
    ...changedFiles,
  ]);
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

export async function createCleanMergeFixture(
  input: {
    readonly deleteSourcePath?: boolean;
  } = {},
): Promise<{
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
  const sourceCommit = (
    await gitOutput(workspacePath, ["rev-parse", "HEAD"])
  ).trim();
  await git(workspacePath, ["push", "origin", "base"]);

  await git(workspacePath, ["checkout", "main"]);
  await writeFile(
    join(workspacePath, "src", "from-target.ts"),
    "export const fromTarget = true;\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: add target source"]);
  const targetCommit = (
    await gitOutput(workspacePath, ["rev-parse", "HEAD"])
  ).trim();
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

export async function gitOutput(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout;
}

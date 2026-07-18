import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createLinkedGitWorktree(
  root: string,
  worktreePath: string,
): Promise<void> {
  const repoPath = join(root, "repo");
  await mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoPath,
  });
  await execFileAsync("git", ["config", "user.name", "Test User"], {
    cwd: repoPath,
  });
  await writeFile(join(repoPath, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "test fixture"], {
    cwd: repoPath,
  });
  await execFileAsync("git", ["worktree", "add", "-b", "worker", worktreePath], {
    cwd: repoPath,
  });
}

export async function waitForProgressStatus(
  progressPath: string,
  status: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(progressPath, "utf8")) as
        Record<string, unknown>;
      if (parsed.status === status) return parsed;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `progress status ${status} was not observed: ${String(lastError)}`,
  );
}

export async function readJsonLines(
  path: string,
): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

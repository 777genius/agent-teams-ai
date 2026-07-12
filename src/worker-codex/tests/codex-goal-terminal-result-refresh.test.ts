import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileCodexGoalRuntimeResult } from "../codex-goal-ops";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

describe("completed Codex goal result refresh", () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  it("refreshes artifacts without downgrading a completed strict result", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-terminal-refresh-"));
    cleanup.push(root);
    const workspacePath = join(root, "workspace");
    const jobRootDir = join(root, "job");
    const outputPath = join(jobRootDir, "task-1.latest-result.json");
    await mkdir(workspacePath);
    await mkdir(jobRootDir);
    await git(workspacePath, ["init"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, "tracked.txt"), "before\n");
    await git(workspacePath, ["add", "tracked.txt"]);
    await git(workspacePath, ["commit", "-m", "test fixture"]);
    await writeFile(join(workspacePath, "tracked.txt"), "after\n");
    await writeFile(outputPath, `${JSON.stringify({
      status: "done",
      changedFiles: ["tracked.txt"],
      evidence: ["worker_completed"],
      blockers: [],
      nextAction: "review_completed",
      reason: "completed",
    })}\n`);

    const reconciliation = await reconcileCodexGoalRuntimeResult({
      config: {
        jobId: "job-1",
        jobRootDir,
        outputPath,
        taskId: "task-1",
        workspacePath,
      },
      status: {
        tmuxAlive: false,
        resultExists: true,
        resultStatus: "done",
        workspaceExists: true,
        workspaceDirty: true,
        changedFiles: ["tracked.txt"],
        recommendedAction: "review_completed",
        warnings: [],
      },
      forceWrite: true,
    });
    const result = JSON.parse(await readFile(outputPath, "utf8")) as
      Record<string, unknown>;

    expect(reconciliation).toMatchObject({
      wrote: true,
      reason: "terminal_result_artifacts_refreshed",
      recommendedAction: "review_completed",
    });
    expect(result).toMatchObject({
      status: "done",
      reason: "completed",
      blockers: [],
      nextAction: "review_completed",
      changedFiles: ["tracked.txt"],
      artifacts: [{
        kind: "patch",
        path: join(jobRootDir, "task-1.preserved.patch"),
      }],
    });
    expect(result.evidence).toEqual(expect.arrayContaining([
      "worker_completed",
      "supervisor_refreshed_terminal_result_artifacts",
      `patch_preserved:${join(jobRootDir, "task-1.preserved.patch")}`,
    ]));
  });
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

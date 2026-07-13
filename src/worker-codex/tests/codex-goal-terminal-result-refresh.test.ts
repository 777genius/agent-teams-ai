import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileCodexGoalRuntimeResult } from "../codex-goal-ops";
import { ensureTerminalCodexGoalHandoffArtifacts } from "../application/ensure-codex-goal-handoff-artifacts";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

describe("completed Codex goal result refresh", () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  it("refreshes artifacts without downgrading a completed strict result", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "codex-terminal-refresh-")),
    );
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
        changedFiles: ["./"],
        recommendedAction: "review_completed",
        warnings: [],
      },
      forceWrite: true,
    });
    const result = JSON.parse(await readFile(outputPath, "utf8")) as
      Record<string, unknown>;
    const canonicalJobRoot = await realpath(jobRootDir);

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
        path: join(canonicalJobRoot, "task-1.handoff.patch"),
      }, {
        kind: "summary",
        path: join(canonicalJobRoot, "task-1.handoff.summary.json"),
      }, {
        kind: "manifest",
        path: join(canonicalJobRoot, "task-1.handoff.manifest.json"),
      }],
    });
    expect(result.evidence).toEqual(expect.arrayContaining([
      "worker_completed",
      "supervisor_refreshed_terminal_result_artifacts",
      `patch_preserved:${join(canonicalJobRoot, "task-1.handoff.patch")}`,
    ]));
  });

  it("lazily backfills an already-completed untracked-only job for handoff review", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "codex-terminal-backfill-")),
    );
    cleanup.push(root);
    const workspacePath = join(root, "workspace");
    const jobRootDir = join(root, "worker-jobs", "worker-1");
    const outputPath = join(jobRootDir, "task-1.latest-result.json");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(jobRootDir, { recursive: true });
    await git(workspacePath, ["init"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, "README.md"), "fixture\n");
    await git(workspacePath, ["add", "README.md"]);
    await git(workspacePath, ["commit", "-m", "fixture"]);
    await writeFile(join(workspacePath, "S0.md"), "completed output\n");
    await writeFile(outputPath, `${JSON.stringify({
      schemaVersion: 1,
      status: "done",
      changedFiles: ["S0.md"],
      evidence: ["worker_completed"],
      blockers: [],
      nextAction: "review_completed",
    })}\n`);

    const status = await ensureTerminalCodexGoalHandoffArtifacts({
      launch: {
        cwd: workspacePath,
        logPath: join(jobRootDir, "task-1.log"),
        cliCommand: ["subscription-runtime-codex-goal"],
        config: {
          jobId: "worker-1",
          jobRootDir,
          authRootDir: join(root, "auth"),
          workspacePath,
          promptPath: join(jobRootDir, "prompt.md"),
          taskId: "task-1",
          accounts: [],
          outputPath,
        },
      },
    });
    const result = JSON.parse(await readFile(outputPath, "utf8")) as
      Record<string, unknown>;
    const canonicalJobRoot = await realpath(jobRootDir);

    expect(status).toMatchObject({
      resultStatus: "done",
      changedFiles: ["S0.md"],
    });
    expect(result).toMatchObject({
      status: "done",
      changedFiles: ["S0.md"],
      details: { baseCommit: expect.stringMatching(/^[a-f0-9]{40}$/) },
      artifacts: [
        { kind: "patch", path: join(canonicalJobRoot, "task-1.handoff.patch") },
        { kind: "summary", path: join(canonicalJobRoot, "task-1.handoff.summary.json") },
        { kind: "manifest", path: join(canonicalJobRoot, "task-1.handoff.manifest.json") },
      ],
    });
  });
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexGoalAccountSlots,
  codexGoalProgressPath,
  runCodexGoal,
  type CodexGoalRunConfig,
} from "../codex-goal-runner";

describe("codex goal runner", () => {
  it("writes heartbeat progress while a sandbox executor is still running", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-runner-"));
    const promptPath = join(root, "prompt.md");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspace"),
      promptPath,
      taskId: "task-heartbeat",
      accounts: codexGoalAccountSlots(["account-a"]),
      outputPath: join(root, "job", "task-heartbeat.latest-result.json"),
      progressHeartbeatMs: 1000,
    };
    let releaseRun: (() => void) | undefined;
    let startedRun: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      startedRun = resolve;
    });

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(config.workspacePath, { recursive: true });
      await writeFile(promptPath, "Do a sandbox task.\n");

      const running = runCodexGoal(config, {
        createExecutor: () => ({
          async run() {
            startedRun?.();
            await new Promise<void>((resolve) => {
              releaseRun = resolve;
            });
            return {
              status: "completed",
              attempts: [],
              task: {
                outputText: "done",
              },
            } as never;
          },
          async dispose() {},
        }),
      });

      await runStarted;
      const runningProgress = await waitForProgressStatus(
        codexGoalProgressPath(config),
        "running",
      );
      expect(runningProgress).toMatchObject({
        schemaVersion: 1,
        taskId: "task-heartbeat",
        status: "running",
        pid: process.pid,
      });

      releaseRun?.();
      await running;

      const finalProgress = JSON.parse(
        await readFile(codexGoalProgressPath(config), "utf8"),
      ) as Record<string, unknown>;
      expect(finalProgress).toMatchObject({
        taskId: "task-heartbeat",
        status: "completed",
        resultStatus: "completed",
        attemptCount: 0,
      });
      const result = JSON.parse(await readFile(config.outputPath!, "utf8")) as
        Record<string, unknown>;
      expect(result.status).toBe("completed");
    } finally {
      releaseRun?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitForProgressStatus(
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
  throw new Error(`progress status ${status} was not observed: ${String(lastError)}`);
}

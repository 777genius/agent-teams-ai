import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isCodexGoalAttemptProcess,
  resolveVisibleCodexGoalResult,
} from "../application/codex-goal-visible-result";
import { collectCodexGoalStatus, summarizeCodexGoalProcessTree } from "../codex-goal-ops";

describe("visible Codex goal result", () => {
  it("ignores a terminal result that predates a newer live worker attempt", () => {
    expect(
      resolveVisibleCodexGoalResult({
        exists: true,
        status: "done",
        updatedAt: "2026-07-13T15:32:56.694Z",
        progress: {
          status: "running",
          updatedAt: "2026-07-13T15:37:31.796Z",
        },
        workerAlive: true,
      }),
    ).toEqual({
      exists: false,
      warning:
        "terminal result predates the active worker attempt and was ignored",
    });
  });

  it("keeps a current terminal result visible after the worker stops", () => {
    expect(
      resolveVisibleCodexGoalResult({
        exists: true,
        status: "done",
        reason: "completed",
        updatedAt: "2026-07-13T15:40:00.000Z",
        progress: {
          status: "completed",
          updatedAt: "2026-07-13T15:40:00.000Z",
        },
        workerAlive: false,
      }),
    ).toEqual({
      exists: true,
      status: "done",
      reason: "completed",
      updatedAt: "2026-07-13T15:40:00.000Z",
    });
  });

  it.each([undefined, "invalid", "2026-07-13T15:37:31.796Z"])(
    "keeps the result visible when its timestamp is not strictly older: %s",
    (updatedAt) => {
      expect(
        resolveVisibleCodexGoalResult({
          exists: true,
          status: "done",
          updatedAt,
          progress: {
            status: "running",
            updatedAt: "2026-07-13T15:37:31.796Z",
          },
          workerAlive: true,
        }).exists,
      ).toBe(true);
    },
  );

  it("binds direct process liveness to the exact task and progress path", () => {
    const command =
      "node codex-goal-cli.js run --task-id task-a --progress /tmp/task-a.progress.json";
    expect(
      isCodexGoalAttemptProcess({
        alive: true,
        command,
        taskId: "task-a",
        progressPath: "/tmp/task-a.progress.json",
      }),
    ).toBe(true);
    expect(
      isCodexGoalAttemptProcess({
        alive: true,
        command,
        taskId: "task-b",
        progressPath: "/tmp/task-a.progress.json",
      }),
    ).toBe(false);
    for (const executable of [
      "subscription-runtime-codex-goal-wrapper",
      "codex-goal-cli.js.bak",
    ]) {
      expect(isCodexGoalAttemptProcess({
        alive: true,
        command: `${executable} run --task-id task-a --progress /tmp/task-a.progress.json`,
        taskId: "task-a",
        progressPath: "/tmp/task-a.progress.json",
      })).toBe(false);
    }
  });

  it("keeps the root supervisor identity while observing an active child", () => {
    expect(summarizeCodexGoalProcessTree(10, [
      {
        pid: 10,
        ppid: 1,
        cpu: 0,
        command: "node codex-goal-cli.js run --task-id task-a --progress /tmp/progress",
      },
      { pid: 11, ppid: 10, cpu: 5, command: "vitest run" },
    ])).toMatchObject({
      command: "vitest run",
      supervisorCommand:
        "node codex-goal-cli.js run --task-id task-a --progress /tmp/progress",
    });
  });

  it("projects the active attempt without a stale terminal result", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-goal-visible-result-"));
    const resultPath = join(root, "task.latest-result.json");
    const progressPath = join(root, "task.progress.json");
    try {
      await writeFile(resultPath, '{"status":"done"}\n');
      await utimes(
        resultPath,
        new Date("2026-07-13T15:32:56.694Z"),
        new Date("2026-07-13T15:32:56.694Z"),
      );
      await writeFile(
        progressPath,
        JSON.stringify({
          status: "running",
          updatedAt: "2026-07-13T15:37:31.796Z",
          pid: 42,
        }),
      );

      const status = await collectCodexGoalStatus(
        {
          taskId: "task",
          resultPath,
          progressPath,
        },
        {
          processSnapshot: async () => ({
            alive: true,
            supervisorCommand: `node codex-goal-cli.js run --task-id task --progress ${progressPath}`,
          }),
          workspaceStatus: async () => ({}),
        },
      );

      expect(status).toMatchObject({
        resultExists: false,
        progressStatus: "running",
        recommendedAction: "wait_for_worker",
      });
      expect(status.resultStatus).toBeUndefined();
      expect(status.warnings).toContain(
        "terminal result predates the active worker attempt and was ignored",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not trust a reused PID owned by another task", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-goal-reused-pid-"));
    const resultPath = join(root, "task.latest-result.json");
    const progressPath = join(root, "task.progress.json");
    try {
      await writeFile(resultPath, '{"status":"done"}\n');
      await utimes(
        resultPath,
        new Date("2026-07-13T15:32:56.694Z"),
        new Date("2026-07-13T15:32:56.694Z"),
      );
      await writeFile(
        progressPath,
        JSON.stringify({
          status: "running",
          updatedAt: "2026-07-13T15:37:31.796Z",
          pid: 42,
        }),
      );
      const status = await collectCodexGoalStatus(
        {
          taskId: "task",
          resultPath,
          progressPath,
        },
        {
          processSnapshot: async () => ({
            alive: true,
            supervisorCommand: `node codex-goal-cli.js run --task-id other --progress ${progressPath}`,
          }),
          workspaceStatus: async () => ({}),
        },
      );
      expect(status).toMatchObject({
        resultExists: true,
        resultStatus: "done",
        recommendedAction: "review_completed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

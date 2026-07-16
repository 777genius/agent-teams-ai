import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectControlOperationRunDisposition,
  ProjectControlOperationStatus,
  createProjectControlOperation,
  projectControlOperationExecutionMode,
  projectControlOperationsRoot,
  readProjectControlOperation,
  runProjectControlOperationFile,
} from "../project-control-operation-lifecycle";
import { recoverProjectControlOperations } from "../project-control-operation-recovery";

describe("project control operation recovery and terminal replay", () => {
  it("recovers a queued operation that never reached its original runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-queued-"));
    const operationsRootDir = projectControlOperationsRoot(root);
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir,
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });

      const summary = await recoverProjectControlOperations({
        operationsRootDir,
        invokeTool: async () => ({ ok: true }),
      });

      expect(summary.recovered).toBe(1);
      expect(await readProjectControlOperation(operation.operationFilePath)).toMatchObject({
        status: ProjectControlOperationStatus.Completed,
        attemptCount: 1,
        lastAttempt: {
          recovery: true,
          recoveredFromStatus: ProjectControlOperationStatus.Queued,
        },
        recovery: {
          count: 1,
          lastRecoveredFromStatus: ProjectControlOperationStatus.Queued,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays a terminal operation without invoking or rewriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-terminal-"));
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir: projectControlOperationsRoot(root),
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });
      let invocations = 0;
      const invokeTool = async () => {
        invocations += 1;
        return { ok: true };
      };
      const completed = await runProjectControlOperationFile({
        operationFilePath: operation.operationFilePath,
        invokeTool,
      });
      const replayed = await runProjectControlOperationFile({
        operationFilePath: operation.operationFilePath,
        invokeTool,
      });

      expect(invocations).toBe(1);
      expect(replayed.disposition).toBe(
        ProjectControlOperationRunDisposition.TerminalReplay,
      );
      expect(replayed.operation.updatedAt).toBe(completed.operation.updatedAt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses bounded execution mode without changing the default sync mode", () => {
    expect(projectControlOperationExecutionMode(undefined)).toBe("sync");
    expect(projectControlOperationExecutionMode("sync")).toBe("sync");
    expect(projectControlOperationExecutionMode("bounded")).toBe("bounded");
    expect(projectControlOperationExecutionMode("async")).toBe("bounded");
    expect(() => projectControlOperationExecutionMode("background")).toThrow(
      "executionMode must be sync, bounded or async",
    );
  });
});

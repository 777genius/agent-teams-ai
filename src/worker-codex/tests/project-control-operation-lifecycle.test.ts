import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectControlOperationStatus,
  createProjectControlOperation,
  projectControlOperationExecutionMode,
  projectControlOperationView,
  projectControlOperationsRoot,
  readProjectControlOperation,
  runProjectControlOperationFile,
} from "../project-control-operation-lifecycle";

describe("project control operation lifecycle", () => {
  it("persists and completes a durable operation through the runner contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-"));
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir: projectControlOperationsRoot(root),
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        targetJobId: "worker-v1",
        args: {
          registryRootDir: join(root, "registry"),
          controllerJobId: "controller-v1",
          jobId: "worker-v1",
          confirmRefill: true,
        },
      });

      expect(operation.status).toBe(ProjectControlOperationStatus.Queued);
      const result = await runProjectControlOperationFile({
        operationFilePath: operation.operationFilePath,
        invokeTool: async (toolName, args) => ({
          ok: true,
          toolName,
          args,
        }),
      });

      expect(result.ok).toBe(true);
      expect(result.operation.status).toBe(ProjectControlOperationStatus.Completed);
      expect(result.operation.result).toMatchObject({
        ok: true,
        toolName: "codex_goal_project_refill_worker",
        args: { executionMode: "sync" },
      });

      const persisted = await readProjectControlOperation(operation.operationFilePath);
      expect(projectControlOperationView({ operation: persisted })).not.toHaveProperty("args");
      expect(projectControlOperationView({
        operation: persisted,
        includeResult: true,
      })).toMatchObject({
        operationId: operation.operationId,
        result: { ok: true },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks operations failed when the wrapped MCP tool returns ok false", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-fail-"));
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir: projectControlOperationsRoot(root),
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });

      const result = await runProjectControlOperationFile({
        operationFilePath: operation.operationFilePath,
        invokeTool: async () => ({ ok: false, error: "refill_failed" }),
      });

      expect(result.ok).toBe(false);
      expect(result.operation.status).toBe(ProjectControlOperationStatus.Failed);
      expect(result.operation.error).toBe("refill_failed");
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

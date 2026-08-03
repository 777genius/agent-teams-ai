import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { describe, expect, it } from "vitest";
import {
  ProjectControlOperationStatus,
  createProjectControlOperation,
  projectControlOperationView,
  projectControlOperationRunnerCommand,
  projectControlOperationsRoot,
  readProjectControlOperation,
  runProjectControlOperationFile,
} from "../project-control-operation-lifecycle";

describe("project control operation runner", () => {
  it("launches a bounded operation through current after a runtime release switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-current-"));
    const runtimeRoot = join(root, "subscription-runtime");
    const oldRelease = "58f17bf87";
    const currentRelease = "f3e8e9d2f";
    const oldModulePath = join(
      runtimeRoot,
      oldRelease,
      "repo",
      "dist",
      "worker-codex",
      "project-control-operation-lifecycle.js",
    );
    const currentCliPath = join(
      runtimeRoot,
      "current",
      "repo",
      "dist",
      "worker-codex",
      "codex-goal-cli.js",
    );
    try {
      await mkdir(dirname(oldModulePath), { recursive: true });
      await writeFile(oldModulePath, "");
      const releasedCliPath = join(
        runtimeRoot,
        currentRelease,
        "repo",
        "dist",
        "worker-codex",
        "codex-goal-cli.js",
      );
      await mkdir(dirname(releasedCliPath), { recursive: true });
      await writeFile(releasedCliPath, "");
      await symlink(join(runtimeRoot, currentRelease), join(runtimeRoot, "current"));

      await expect(projectControlOperationRunnerCommand({
        operationFilePath: join(root, "operation.json"),
        runtimeModulePath: oldModulePath,
      })).resolves.toEqual([
        execPath,
        currentCliPath,
        "project-control-operation-run",
        "--operation-file",
        join(root, "operation.json"),
        "--format",
        "json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow a current runtime link outside the runtime root", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-current-"));
    const runtimeRoot = join(root, "subscription-runtime");
    const externalRelease = join(root, "external-release");
    const oldModulePath = join(
      runtimeRoot,
      "58f17bf87",
      "repo",
      "dist",
      "worker-codex",
      "project-control-operation-lifecycle.js",
    );
    const externalCliPath = join(
      externalRelease,
      "repo",
      "dist",
      "worker-codex",
      "codex-goal-cli.js",
    );
    try {
      await mkdir(dirname(oldModulePath), { recursive: true });
      await writeFile(oldModulePath, "");
      await mkdir(dirname(externalCliPath), { recursive: true });
      await writeFile(externalCliPath, "");
      await symlink(externalRelease, join(runtimeRoot, "current"));

      const command = await projectControlOperationRunnerCommand({
        operationFilePath: join(root, "operation.json"),
        runtimeModulePath: oldModulePath,
      });
      expect(command[1]).toBe(join(dirname(oldModulePath), "codex-goal-cli.js"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an explicit runner CLI path", async () => {
    const command = await projectControlOperationRunnerCommand({
      operationFilePath: "/tmp/operation.json",
      cliPath: "/tmp/explicit-codex-goal-cli.js",
    });
    expect(command.slice(0, 2)).toEqual([
      execPath,
      "/tmp/explicit-codex-goal-cli.js",
    ]);
  });

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

  it("preserves prepare-verifier identity through the durable runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-verifier-"));
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir: projectControlOperationsRoot(root),
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_prepare_verifier",
        targetJobId: "reviewer-v1",
        args: {
          registryRootDir: join(root, "registry"),
          controllerJobId: "controller-v1",
          jobId: "reviewer-v1",
          executionMode: "bounded",
        },
      });
      const invocations: Array<{ toolName: string; args: unknown }> = [];

      const result = await runProjectControlOperationFile({
        operationFilePath: operation.operationFilePath,
        invokeTool: async (toolName, args) => {
          invocations.push({ toolName, args });
          return { ok: true };
        },
      });

      expect(result.ok).toBe(true);
      expect(invocations).toEqual([{
        toolName: "codex_goal_project_prepare_verifier",
        args: expect.objectContaining({
          jobId: "reviewer-v1",
          executionMode: "sync",
        }),
      }]);
      expect(await readdir(projectControlOperationsRoot(root))).toHaveLength(1);
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
});

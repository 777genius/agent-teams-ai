import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectControlOperationRunDisposition,
  ProjectControlOperationStatus,
  createProjectControlOperation,
  patchProjectControlOperation,
  projectControlOperationExecutionMode,
  projectControlOperationView,
  projectControlOperationsRoot,
  readProjectControlOperation,
  runProjectControlOperationFile,
} from "../project-control-operation-lifecycle";
import {
  projectControlOperationClaimDirectory,
  tryAcquireProjectControlOperationClaim,
} from "../project-control-operation-file-store";
import { recoverProjectControlOperations } from "../project-control-operation-recovery";

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

  it("blocks an identical admission retry until the request changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-breaker-"));
    const operationsRootDir = projectControlOperationsRoot(root);
    const baseInput = {
      operationsRootDir,
      controllerJobId: "controller-v1",
      toolName: "codex_goal_project_refill_worker" as const,
      targetJobId: "worker-v1",
      args: {
        jobId: "worker-v1",
        preStartAdmission: {
          contract: {
            kind: "worker-launch",
            format: 1,
            inputPatchHash: "a".repeat(64),
          },
        },
      },
    };
    try {
      const failed = await createProjectControlOperation(baseInput);
      await runProjectControlOperationFile({
        operationFilePath: failed.operationFilePath,
        invokeTool: async () => ({
          ok: false,
          error: "worker_launch_request_invalid:missing_field_phaseStartSha",
        }),
      });

      await expect(createProjectControlOperation(baseInput)).rejects.toThrow(
        `project_control_operation_identical_failed_request_blocked:${failed.operationId}`,
      );

      const corrected = await createProjectControlOperation({
        ...baseInput,
        args: {
          ...baseInput.args,
          preStartAdmission: {
            contract: {
              ...baseInput.args.preStartAdmission.contract,
              inputPatchHash: "b".repeat(64),
            },
          },
        },
      });
      expect(corrected.status).toBe(ProjectControlOperationStatus.Queued);
      expect(corrected.requestDigest).not.toBe(failed.requestDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows retry after external source state changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-retry-"));
    const input = {
      operationsRootDir: projectControlOperationsRoot(root),
      controllerJobId: "controller-v1",
      toolName: "codex_goal_project_refill_worker" as const,
      targetJobId: "worker-v1",
      args: { sourceRef: "main", confirmRefill: true },
    };
    try {
      const failed = await createProjectControlOperation(input);
      await runProjectControlOperationFile({
        operationFilePath: failed.operationFilePath,
        invokeTool: async () => ({
          ok: false,
          error: "project_control_pre_start_source_revision_mismatch",
        }),
      });

      await expect(createProjectControlOperation(input)).resolves.toMatchObject({
        status: ProjectControlOperationStatus.Queued,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent runner to invoke the side effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-race-"));
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir: projectControlOperationsRoot(root),
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });
      let invocations = 0;
      let releaseInvocation: (() => void) | undefined;
      const invocationBlocked = new Promise<void>((resolve) => {
        releaseInvocation = resolve;
      });
      let markStarted: (() => void) | undefined;
      const invocationStarted = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const invokeTool = async () => {
        invocations += 1;
        markStarted?.();
        await invocationBlocked;
        return { ok: true };
      };

      const first = runProjectControlOperationFile({
        operationFilePath: operation.operationFilePath,
        invokeTool,
      });
      await invocationStarted;
      const second = await runProjectControlOperationFile({
        operationFilePath: operation.operationFilePath,
        invokeTool,
      });

      expect(second.disposition).toBe(
        ProjectControlOperationRunDisposition.AlreadyRunning,
      );
      expect(invocations).toBe(1);
      releaseInvocation?.();
      await expect(first).resolves.toMatchObject({
        ok: true,
        disposition: ProjectControlOperationRunDisposition.Executed,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prevents a stale holder from renewing or releasing a replacement claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-lease-"));
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir: projectControlOperationsRoot(root),
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });
      const first = await tryAcquireProjectControlOperationClaim({
        operationId: operation.operationId,
        operationFilePath: operation.operationFilePath,
        environment: {
          hostname: "host-a",
          pid: 101,
          leaseDurationMs: 1_000,
          now: () => new Date("2026-07-13T10:00:00.000Z"),
        },
      });
      const replacement = await tryAcquireProjectControlOperationClaim({
        operationId: operation.operationId,
        operationFilePath: operation.operationFilePath,
        environment: {
          hostname: "host-b",
          pid: 202,
          leaseDurationMs: 1_000,
          now: () => new Date("2026-07-13T10:00:02.000Z"),
        },
      });

      expect(first).toBeDefined();
      expect(replacement).toBeDefined();
      await expect(first?.renew()).resolves.toBe(false);
      await first?.release();
      const contender = await tryAcquireProjectControlOperationClaim({
        operationId: operation.operationId,
        operationFilePath: operation.operationFilePath,
        environment: {
          hostname: "host-c",
          pid: 303,
          leaseDurationMs: 1_000,
          now: () => new Date("2026-07-13T10:00:02.500Z"),
        },
      });
      expect(contender).toBeUndefined();
      await replacement?.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("recovers a running operation whose local runner and claim owner are dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-recover-"));
    const operationsRootDir = projectControlOperationsRoot(root);
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir,
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });
      await patchProjectControlOperation({
        operationFilePath: operation.operationFilePath,
        patch: {
          status: ProjectControlOperationStatus.Running,
          runningAt: "2026-07-13T10:00:00.000Z",
          runner: {
            hostname: hostname(),
            pid: 987_654,
            command: ["node", "runner"],
            startedAt: "2026-07-13T10:00:00.000Z",
          },
        },
      });
      const claimDirectory = projectControlOperationClaimDirectory(
        operation.operationFilePath,
      );
      await mkdir(claimDirectory, { recursive: true });
      await writeFile(join(claimDirectory, "claim.json"), JSON.stringify({
        format: 1,
        operationId: operation.operationId,
        claimId: "dead-claim",
        hostname: hostname(),
        pid: 987_654,
        acquiredAt: "2026-07-13T10:00:00.000Z",
        renewedAt: "2026-07-13T10:00:00.000Z",
        expiresAt: "2026-07-13T10:05:00.000Z",
      }));

      const summary = await recoverProjectControlOperations({
        operationsRootDir,
        invokeTool: async () => ({ ok: true, recovered: true }),
        claimEnvironment: {
          hostname: hostname(),
          pid: process.pid,
          isProcessAlive: (pid) => pid === process.pid,
          now: () => new Date("2026-07-13T10:01:00.000Z"),
        },
      });

      expect(summary).toMatchObject({
        scanned: 1,
        attempted: 1,
        recovered: 1,
        reconciled: 0,
        alreadyRunning: 0,
      });
      const persisted = await readProjectControlOperation(operation.operationFilePath);
      expect(persisted).toMatchObject({
        status: ProjectControlOperationStatus.Completed,
        attemptCount: 1,
        lastAttempt: {
          number: 1,
          recovery: true,
          recoveredFromStatus: ProjectControlOperationStatus.Running,
        },
        recovery: {
          count: 1,
          lastRecoveredFromStatus: ProjectControlOperationStatus.Running,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not recover a running operation while its local runner is alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-live-"));
    const operationsRootDir = projectControlOperationsRoot(root);
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir,
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });
      await patchProjectControlOperation({
        operationFilePath: operation.operationFilePath,
        patch: {
          status: ProjectControlOperationStatus.Running,
          runner: {
            hostname: hostname(),
            pid: 456_789,
            command: ["node", "runner"],
            startedAt: new Date().toISOString(),
          },
        },
      });
      let invocations = 0;
      const summary = await recoverProjectControlOperations({
        operationsRootDir,
        invokeTool: async () => {
          invocations += 1;
          return { ok: true };
        },
        claimEnvironment: {
          hostname: hostname(),
          isProcessAlive: () => true,
        },
      });

      expect(invocations).toBe(0);
      expect(summary.alreadyRunning).toBe(1);
      expect(summary.recovered).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles a durable result left behind before terminal status was written", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-result-"));
    const operationsRootDir = projectControlOperationsRoot(root);
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir,
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });
      await patchProjectControlOperation({
        operationFilePath: operation.operationFilePath,
        patch: {
          status: ProjectControlOperationStatus.Running,
          runner: {
            hostname: hostname(),
            pid: 876_543,
            command: ["node", "runner"],
            startedAt: "2026-07-13T10:00:00.000Z",
          },
        },
      });
      await mkdir(dirname(operation.resultPath), { recursive: true });
      await writeFile(operation.resultPath, JSON.stringify({ ok: true, jobId: "worker-v1" }));
      let invocations = 0;

      const summary = await recoverProjectControlOperations({
        operationsRootDir,
        invokeTool: async () => {
          invocations += 1;
          return { ok: true };
        },
        claimEnvironment: {
          hostname: hostname(),
          isProcessAlive: () => false,
        },
      });

      expect(invocations).toBe(0);
      expect(summary.reconciled).toBe(1);
      expect(await readProjectControlOperation(operation.operationFilePath)).toMatchObject({
        status: ProjectControlOperationStatus.Completed,
        result: { ok: true, jobId: "worker-v1" },
        recovery: {
          count: 1,
          lastRecoveredFromStatus: ProjectControlOperationStatus.Running,
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

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectControlOperationRunDisposition,
  ProjectControlOperationStatus,
  createOrReuseProjectControlOperation,
  createProjectControlOperation,
  patchProjectControlOperation,
  projectControlOperationExecutionMode,
  projectControlOperationView,
  projectControlOperationsRoot,
  readProjectControlOperation,
  runProjectControlOperationFile,
  updateProjectControlOperation,
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

  it("converges concurrent identical requests on one deterministic operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-create-race-"));
    const input = {
      operationsRootDir: projectControlOperationsRoot(root),
      controllerJobId: "controller-v1",
      toolName: "codex_goal_project_refill_worker" as const,
      targetJobId: "worker-v1",
      args: { confirmRefill: true, jobId: "worker-v1" },
    };
    try {
      const creations = await Promise.all(
        Array.from({ length: 16 }, () =>
          createOrReuseProjectControlOperation(input)),
      );

      expect(new Set(creations.map(({ operation }) => operation.operationId)).size)
        .toBe(1);
      expect(creations.filter(({ created }) => created)).toHaveLength(1);
      expect(creations[0]?.operation.operationId).toBe(
        `project-control-${creations[0]?.operation.requestDigest}-1`,
      );
      expect(await readdir(input.operationsRootDir)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes metadata, running, and terminal updates monotonically", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-update-race-"));
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir: projectControlOperationsRoot(root),
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });
      let enterMetadata: (() => void) | undefined;
      const metadataEntered = new Promise<void>((resolve) => {
        enterMetadata = resolve;
      });
      let releaseMetadata: (() => void) | undefined;
      const metadataBlocked = new Promise<void>((resolve) => {
        releaseMetadata = resolve;
      });
      const metadata = updateProjectControlOperation({
        operationFilePath: operation.operationFilePath,
        update: async () => {
          enterMetadata?.();
          await metadataBlocked;
          return {
            runner: {
              hostname: "parent-host",
              pid: 101,
              command: ["node", "runner"],
              startedAt: "2026-07-14T00:00:00.000Z",
            },
          };
        },
      });
      await metadataEntered;
      const running = patchProjectControlOperation({
        operationFilePath: operation.operationFilePath,
        patch: {
          status: ProjectControlOperationStatus.Running,
          runningAt: "2026-07-14T00:00:01.000Z",
          attemptCount: 1,
        },
      });
      const terminal = patchProjectControlOperation({
        operationFilePath: operation.operationFilePath,
        patch: {
          status: ProjectControlOperationStatus.Completed,
          completedAt: "2026-07-14T00:00:02.000Z",
          result: { ok: true },
        },
      });
      releaseMetadata?.();
      await Promise.all([metadata, running, terminal]);

      const persisted = await readProjectControlOperation(
        operation.operationFilePath,
      );
      expect(persisted).toMatchObject({
        status: ProjectControlOperationStatus.Completed,
        runner: { hostname: "parent-host", pid: 101 },
        completedAt: "2026-07-14T00:00:02.000Z",
        result: { ok: true },
      });
      expect(Date.parse(persisted.updatedAt)).toBeGreaterThan(
        Date.parse(operation.updatedAt),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fences a stale update-lock holder after successor takeover", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-lock-fence-"));
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir: projectControlOperationsRoot(root),
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });
      let markOldEntered: (() => void) | undefined;
      const oldEntered = new Promise<void>((resolve) => {
        markOldEntered = resolve;
      });
      let releaseOld: (() => void) | undefined;
      const oldBlocked = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      const staleUpdate = updateProjectControlOperation({
        operationFilePath: operation.operationFilePath,
        updateLockEnvironment: {
          hostname: "lock-host-a",
          pid: 101,
          now: () => new Date("2026-07-14T10:00:00.000Z"),
        },
        update: async () => {
          markOldEntered?.();
          await oldBlocked;
          return {
            runner: {
              hostname: "stale-holder",
              pid: 101,
              command: ["node", "stale"],
              startedAt: "2026-07-14T10:00:00.000Z",
            },
          };
        },
      });
      await oldEntered;

      await updateProjectControlOperation({
        operationFilePath: operation.operationFilePath,
        updateLockEnvironment: {
          hostname: "lock-host-b",
          pid: 202,
          staleDurationMs: 1_000,
          retryMs: 1,
          now: () => new Date("2026-07-14T10:00:02.000Z"),
        },
        update: () => ({
          runner: {
            hostname: "successor",
            pid: 202,
            command: ["node", "successor"],
            startedAt: "2026-07-14T10:00:02.000Z",
          },
        }),
      });
      releaseOld?.();

      await expect(staleUpdate).rejects.toThrow(
        "project_control_operation_update_lock_lost",
      );
      await expect(readProjectControlOperation(operation.operationFilePath))
        .resolves.toMatchObject({
          runner: { hostname: "successor", pid: 202 },
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not rename a fresh operation-lock successor after a stale ABA observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-lock-aba-"));
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir: projectControlOperationsRoot(root),
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });
      let markOldEntered: (() => void) | undefined;
      const oldEntered = new Promise<void>((resolve) => {
        markOldEntered = resolve;
      });
      let releaseOld: (() => void) | undefined;
      const oldBlocked = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      const oldUpdate = updateProjectControlOperation({
        operationFilePath: operation.operationFilePath,
        updateLockEnvironment: {
          hostname: "old-lock-host",
          pid: 101,
          now: () => new Date("2026-07-14T10:00:00.000Z"),
        },
        update: async () => {
          markOldEntered?.();
          await oldBlocked;
          return {};
        },
      });
      await oldEntered;

      let markStaleObserved: (() => void) | undefined;
      const staleObserved = new Promise<void>((resolve) => {
        markStaleObserved = resolve;
      });
      let continueTakeover: (() => void) | undefined;
      const takeoverBlocked = new Promise<void>((resolve) => {
        continueTakeover = resolve;
      });
      const contender = updateProjectControlOperation({
        operationFilePath: operation.operationFilePath,
        updateLockEnvironment: {
          hostname: "contender-lock-host",
          pid: 202,
          staleDurationMs: 1_000,
          retryMs: 1,
          maxAttempts: 1,
          now: () => new Date("2026-07-14T10:00:02.000Z"),
          onStaleOwnerObserved: async () => {
            markStaleObserved?.();
            await takeoverBlocked;
          },
        },
        update: () => ({ error: "contender_must_not_persist" }),
      });
      await staleObserved;

      releaseOld?.();
      await oldUpdate;
      let markSuccessorEntered: (() => void) | undefined;
      const successorEntered = new Promise<void>((resolve) => {
        markSuccessorEntered = resolve;
      });
      let releaseSuccessor: (() => void) | undefined;
      const successorBlocked = new Promise<void>((resolve) => {
        releaseSuccessor = resolve;
      });
      const successor = updateProjectControlOperation({
        operationFilePath: operation.operationFilePath,
        updateLockEnvironment: {
          hostname: "successor-lock-host",
          pid: 303,
          now: () => new Date("2026-07-14T10:00:02.000Z"),
        },
        update: async () => {
          markSuccessorEntered?.();
          await successorBlocked;
          return { error: "successor_owned" };
        },
      });
      await successorEntered;
      const successorOwner = JSON.parse(await readFile(
        join(dirname(operation.operationFilePath), ".update-lock", "owner.json"),
        "utf8",
      )) as { readonly lockId: string };

      continueTakeover?.();
      await expect(contender).rejects.toThrow(
        "project_control_operation_update_lock_timeout",
      );
      await expect(readFile(
        join(dirname(operation.operationFilePath), ".update-lock", "owner.json"),
        "utf8",
      )).resolves.toContain(successorOwner.lockId);

      releaseSuccessor?.();
      await successor;
      await expect(readProjectControlOperation(operation.operationFilePath))
        .resolves.toMatchObject({ error: "successor_owned" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["before", 999, true],
    ["exactly at", 1_000, false],
    ["after", 1_001, false],
  ] as const)(
    "%s expiry, execution claims revalidate, renew, and fence effects consistently",
    async (_boundary, offsetMs, expectedCurrent) => {
      const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-expiry-"));
      try {
        const operation = await createProjectControlOperation({
          operationsRootDir: projectControlOperationsRoot(root),
          controllerJobId: "controller-v1",
          toolName: "codex_goal_project_refill_worker",
          args: { confirmRefill: true },
        });
        let clock = new Date("2026-07-14T10:00:00.000Z");
        let clockReads = 0;
        const claim = await tryAcquireProjectControlOperationClaim({
          operationId: operation.operationId,
          operationFilePath: operation.operationFilePath,
          environment: {
            hostname: "expiry-host",
            pid: 101,
            leaseDurationMs: 1_000,
            now: () => {
              clockReads += 1;
              return clock;
            },
          },
        });
        expect(claim).toBeDefined();
        expect(clockReads).toBe(1);
        clock = new Date(clock.getTime() + offsetMs);

        await expect(claim?.revalidate()).resolves.toBe(expectedCurrent);
        expect(clockReads).toBe(2);
        await expect(claim?.renew()).resolves.toBe(expectedCurrent);
        expect(clockReads).toBe(3);
        let effects = 0;
        const fenced = await claim?.runIfCurrent(async () => {
          effects += 1;
          return "effect";
        });
        expect(fenced?.executed).toBe(expectedCurrent);
        expect(clockReads).toBe(4);
        expect(effects).toBe(expectedCurrent ? 1 : 0);
        await claim?.release();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not invoke a runner effect after its claim reaches expiry", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-expired-runner-"));
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir: projectControlOperationsRoot(root),
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });
      const acquiredAt = new Date("2026-07-14T10:00:00.000Z");
      const expiresAt = new Date(acquiredAt.getTime() + 1_000);
      let clockReads = 0;
      let invocations = 0;

      await expect(runProjectControlOperationFile({
        operationFilePath: operation.operationFilePath,
        claimEnvironment: {
          hostname: "expired-runner-host",
          pid: 101,
          leaseDurationMs: 1_000,
          now: () => {
            clockReads += 1;
            return clockReads === 1 ? acquiredAt : expiresAt;
          },
        },
        heartbeatIntervalMs: 60_000,
        invokeTool: async () => {
          invocations += 1;
          return { ok: true };
        },
      })).rejects.toThrow("project_control_operation_execution_claim_lost");
      expect(invocations).toBe(0);
      await expect(readFile(operation.resultPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
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

  it("does not rename a fresh execution-claim successor after a stale ABA observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-claim-aba-"));
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
          hostname: "old-claim-host",
          pid: 101,
          leaseDurationMs: 1_000,
          now: () => new Date("2026-07-14T10:00:00.000Z"),
        },
      });
      let markStaleObserved: (() => void) | undefined;
      const staleObserved = new Promise<void>((resolve) => {
        markStaleObserved = resolve;
      });
      let continueTakeover: (() => void) | undefined;
      const takeoverBlocked = new Promise<void>((resolve) => {
        continueTakeover = resolve;
      });
      const contenderPromise = tryAcquireProjectControlOperationClaim({
        operationId: operation.operationId,
        operationFilePath: operation.operationFilePath,
        environment: {
          hostname: "contender-claim-host",
          pid: 202,
          leaseDurationMs: 1_000,
          now: () => new Date("2026-07-14T10:00:02.000Z"),
          onStaleOwnerObserved: async () => {
            markStaleObserved?.();
            await takeoverBlocked;
          },
        },
      });
      await staleObserved;

      await first?.release();
      const successor = await tryAcquireProjectControlOperationClaim({
        operationId: operation.operationId,
        operationFilePath: operation.operationFilePath,
        environment: {
          hostname: "successor-claim-host",
          pid: 303,
          leaseDurationMs: 10_000,
          now: () => new Date("2026-07-14T10:00:02.000Z"),
        },
      });
      expect(successor).toBeDefined();
      continueTakeover?.();

      await expect(contenderPromise).resolves.toBeUndefined();
      const persistedOwner = JSON.parse(await readFile(
        join(projectControlOperationClaimDirectory(operation.operationFilePath), "claim.json"),
        "utf8",
      )) as { readonly claimId: string };
      expect(persistedOwner.claimId).toBe(successor?.record.claimId);
      await expect(successor?.revalidate()).resolves.toBe(true);
      await expect(successor?.renew()).resolves.toBe(true);
      await successor?.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prevents a stale runner from publishing after claim takeover", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-runner-fence-"));
    try {
      const operation = await createProjectControlOperation({
        operationsRootDir: projectControlOperationsRoot(root),
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_refill_worker",
        args: { confirmRefill: true },
      });
      let markStaleInvoked: (() => void) | undefined;
      const staleInvoked = new Promise<void>((resolve) => {
        markStaleInvoked = resolve;
      });
      let releaseStaleInvocation: (() => void) | undefined;
      const staleInvocationBlocked = new Promise<void>((resolve) => {
        releaseStaleInvocation = resolve;
      });
      const staleRunner = runProjectControlOperationFile({
        operationFilePath: operation.operationFilePath,
        claimEnvironment: {
          hostname: "runner-host-a",
          pid: 101,
          leaseDurationMs: 1_000,
          now: () => new Date("2026-07-14T10:00:00.000Z"),
        },
        heartbeatIntervalMs: 60_000,
        invokeTool: async () => {
          markStaleInvoked?.();
          await staleInvocationBlocked;
          return { ok: true, publisher: "stale" };
        },
      });
      await staleInvoked;

      const successor = await runProjectControlOperationFile({
        operationFilePath: operation.operationFilePath,
        claimEnvironment: {
          hostname: "runner-host-b",
          pid: 202,
          leaseDurationMs: 1_000,
          now: () => new Date("2026-07-14T10:00:02.000Z"),
        },
        heartbeatIntervalMs: 60_000,
        invokeTool: async () => ({ ok: true, publisher: "successor" }),
      });
      expect(successor).toMatchObject({
        ok: true,
        operation: {
          status: ProjectControlOperationStatus.Completed,
          result: { publisher: "successor" },
        },
      });

      releaseStaleInvocation?.();
      await expect(staleRunner).rejects.toThrow(
        "project_control_operation_execution_claim_lost",
      );
      await expect(readProjectControlOperation(operation.operationFilePath))
        .resolves.toMatchObject({
          status: ProjectControlOperationStatus.Completed,
          result: { publisher: "successor" },
        });
      await expect(readFile(operation.resultPath, "utf8")).resolves.toContain(
        '"publisher": "successor"',
      );
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

  it("preserves prepare-verifier identity when recovering a queued operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-verifier-recovery-"));
    const operationsRootDir = projectControlOperationsRoot(root);
    try {
      await createProjectControlOperation({
        operationsRootDir,
        controllerJobId: "controller-v1",
        toolName: "codex_goal_project_prepare_verifier",
        targetJobId: "reviewer-v1",
        args: {
          jobId: "reviewer-v1",
          executionMode: "bounded",
        },
      });
      const invocations: Array<{ toolName: string; args: unknown }> = [];

      const summary = await recoverProjectControlOperations({
        operationsRootDir,
        invokeTool: async (toolName, args) => {
          invocations.push({ toolName, args });
          return { ok: true };
        },
      });

      expect(summary).toMatchObject({ recovered: 1, failed: 0 });
      expect(invocations).toEqual([{
        toolName: "codex_goal_project_prepare_verifier",
        args: expect.objectContaining({
          jobId: "reviewer-v1",
          executionMode: "sync",
        }),
      }]);
      expect(await readdir(operationsRootDir)).toHaveLength(1);
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

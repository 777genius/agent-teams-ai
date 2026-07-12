import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryObservability } from "../../core/testing";
import { LocalFileWorkerAccountCapacityStore } from "../../store-local-file";
import {
  WorkerAccountCapacityClaimStatus,
  WorkerAccountCapacityPhase,
  WorkerAccountCapacityRecheckMode,
  WorkerAccountCapacityResolutionType,
  WorkerAccountCapacityMetric,
} from "../../worker-core";
import {
  codexAccountCapacityRootDir,
  codexAccountCapacityStore,
  migrateLegacyCodexAccountCapacity,
} from "../application/codex-account-capacity-store";
import {
  buildCodexGoalExecutorOptions,
  type CodexGoalRunConfig,
} from "../codex-goal-runner";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";

describe("Codex shared account capacity store", () => {
  it("shares capacity across jobs using one auth pool", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-shared-capacity-"));
    const authRootDir = join(root, "auth");
    try {
      const firstJobStore = codexAccountCapacityStore(authRootDir);
      const secondJobStore = codexAccountCapacityStore(authRootDir);
      firstJobStore.observe({
        accountId: "account-a",
        observedAt: new Date("2026-07-12T10:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-07-12T12:00:00.000Z"),
        },
      });

      expect(
        secondJobStore.read({
          accountId: "account-a",
          now: new Date("2026-07-12T10:30:00.000Z"),
        }),
      ).toMatchObject({ reason: "quota_limited" });
      expect(codexAccountCapacityRootDir(authRootDir)).not.toContain(
        "worker-jobs",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects the shared auth-pool store into different goal executors", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-goal-shared-capacity-"));
    const authRootDir = join(root, "auth");
    try {
      const first = buildCodexGoalExecutorOptions({
        config: goalConfig(root, authRootDir, "job-a"),
        stateRootDir: join(root, "jobs", "job-a", "state"),
        encryptionKey: new Uint8Array(32),
      });
      const second = buildCodexGoalExecutorOptions({
        config: goalConfig(root, authRootDir, "job-b"),
        stateRootDir: join(root, "jobs", "job-b", "state"),
        encryptionKey: new Uint8Array(32),
      });
      first.accountCapacityStore!.observe({
        accountId: "account-a",
        observedAt: new Date("2026-07-12T10:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          cooldownUntil: new Date("2026-07-12T12:00:00.000Z"),
        },
      });
      expect(
        second.accountCapacityStore!.read({
          accountId: "account-a",
          now: new Date("2026-07-12T10:30:00.000Z"),
        }),
      ).toMatchObject({ availability: "quota_exhausted" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("wires goal observability into the shared capacity store", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-goal-capacity-metrics-"));
    const authRootDir = join(root, "auth");
    const observability = new MemoryObservability();
    try {
      await writeAuth(authRootDir, "account-a", "physical-a", "refresh-a");
      const options = buildCodexGoalExecutorOptions({
        config: goalConfig(root, authRootDir, "job-a"),
        stateRootDir: join(root, "jobs", "job-a", "state"),
        encryptionKey: new Uint8Array(32),
        observability,
      });
      options.accountCapacityStore!.observe({
        accountId: "account-a",
        observedAt: new Date("2026-07-12T10:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-07-12T12:00:00.000Z"),
        },
      });
      expect(observability.timings).toContainEqual({
        metric: WorkerAccountCapacityMetric.TimeToResetMs,
        durationMs: 2 * 60 * 60_000,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates identical slot names from different auth pools", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-isolated-capacity-"));
    try {
      const first = codexAccountCapacityStore(join(root, "auth-a"));
      const second = codexAccountCapacityStore(join(root, "auth-b"));
      first.observe({
        accountId: "account-a",
        observedAt: new Date("2026-07-12T10:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          cooldownUntil: new Date("2026-07-12T12:00:00.000Z"),
        },
      });
      expect(
        second.read({
          accountId: "account-a",
          now: new Date("2026-07-12T10:30:00.000Z"),
        }),
      ).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares quota across different slot aliases for one provider account", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-alias-capacity-"));
    const authRootDir = join(root, "auth");
    const rawAccountId = "physical-account-secret";
    try {
      await writeAuth(authRootDir, "slot-a", rawAccountId, "refresh-a-secret");
      await writeAuth(authRootDir, "slot-b", rawAccountId, "refresh-b-secret");
      const store = codexAccountCapacityStore(authRootDir);
      const observedAt = new Date("2026-07-12T10:00:00.000Z");
      const resetAt = new Date("2026-07-12T12:00:00.000Z");
      store.observe({
        accountId: "slot-a",
        observedAt,
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: resetAt,
        },
      });

      expect(store.read({ accountId: "slot-b", now: observedAt })).toMatchObject({
        reason: "quota_limited",
        cooldownUntil: resetAt,
      });
      const persisted = await readTree(codexAccountCapacityRootDir(authRootDir));
      expect(persisted).not.toContain(rawAccountId);
      expect(persisted).not.toContain("refresh-a-secret");
      expect(persisted).not.toContain("refresh-b-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("single-flights a due recheck across aliases of one provider account", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-alias-recheck-"));
    const authRootDir = join(root, "auth");
    const now = new Date("2026-07-12T12:00:00.001Z");
    try {
      await writeAuth(authRootDir, "slot-a", "physical-a", "refresh-a");
      await writeAuth(authRootDir, "slot-b", "physical-a", "refresh-b");
      const first = codexAccountCapacityStore(authRootDir);
      const second = codexAccountCapacityStore(authRootDir);
      first.observe({
        accountId: "slot-a",
        observedAt: new Date("2026-07-12T10:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-07-12T12:00:00.000Z"),
        },
      });
      const stateA = first.readState({ accountId: "slot-a", now })!;
      const stateB = second.readState({ accountId: "slot-b", now })!;
      const claimed = first.tryClaimRecheck({
        state: stateA,
        ownerId: "worker-a",
        now,
        ttlMs: 30_000,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      });
      const busy = second.tryClaimRecheck({
        state: stateB,
        ownerId: "worker-b",
        now,
        ttlMs: 30_000,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      });

      expect(claimed.status).toBe(WorkerAccountCapacityClaimStatus.Claimed);
      expect(busy.status).toBe(WorkerAccountCapacityClaimStatus.Busy);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps different provider accounts isolated inside one auth pool", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-alias-isolation-"));
    const authRootDir = join(root, "auth");
    try {
      await writeAuth(authRootDir, "slot-a", "physical-a", "refresh-a");
      await writeAuth(authRootDir, "slot-b", "physical-b", "refresh-b");
      const store = codexAccountCapacityStore(authRootDir);
      const now = new Date("2026-07-12T10:00:00.000Z");
      store.observe({
        accountId: "slot-a",
        observedAt: now,
        capacity: {
          availability: "quota_exhausted",
          cooldownUntil: new Date("2026-07-12T12:00:00.000Z"),
        },
      });
      expect(store.read({ accountId: "slot-b", now })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes inline aliases in the direct safe executor API", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-direct-alias-"));
    const stateRootDir = join(root, "state");
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir,
      workspacePath: join(root, "workspace"),
      accounts: ["slot-a", "slot-b"].map((slot, index) => ({
        codexAuthJson: JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: "physical-inline-account",
            refresh_token: `refresh-${index}`,
          },
        }),
        worker: {
          providerInstanceId: `provider-${slot}`,
          stateRootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 1),
        },
      })),
    });
    try {
      const now = new Date("2026-07-12T10:00:00.000Z");
      executor.accountCapacityStore.observe({
        accountId: "provider-slot-a",
        observedAt: now,
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-07-12T12:00:00.000Z"),
        },
      });
      expect(
        executor.accountCapacityStore.read({
          accountId: "provider-slot-b",
          now,
        }),
      ).toMatchObject({ reason: "quota_limited" });
    } finally {
      await executor.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("follows auth rotation without freezing a direct worker to the old identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-direct-rotation-"));
    const authRootDir = join(root, "auth");
    const authJsonPath = join(authRootDir, "slot-a", "auth.json");
    const stateRootDir = join(root, "state");
    await writeAuth(authRootDir, "slot-a", "physical-a", "refresh-a");
    await writeAuth(authRootDir, "stable-a", "physical-a", "refresh-stable-a");
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir,
      authRootDir,
      workspacePath: join(root, "workspace"),
      accounts: [{
        codexAuthJsonPath: authJsonPath,
        worker: {
          providerInstanceId: "provider-slot-a",
          stateRootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(7),
        },
      }],
    });
    const now = new Date("2026-07-12T10:00:00.000Z");
    const oldReset = new Date("2026-07-12T11:00:00.000Z");
    const newReset = new Date("2026-07-12T12:00:00.000Z");
    try {
      executor.accountCapacityStore.observe({
        accountId: "provider-slot-a",
        observedAt: now,
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: oldReset,
        },
      });
      await writeAuth(
        authRootDir,
        "slot-a",
        "physical-b-rotated",
        "refresh-b-rotated",
      );
      executor.accountCapacityStore.observe({
        accountId: "provider-slot-a",
        observedAt: new Date(now.getTime() + 1),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: newReset,
        },
      });

      expect(executor.accountCapacityStore.read({
        accountId: "stable-a",
        now,
      })).toMatchObject({ cooldownUntil: oldReset });
      expect(executor.accountCapacityStore.read({
        accountId: "provider-slot-a",
        now,
      })).toMatchObject({ cooldownUntil: newReset });
    } finally {
      await executor.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates due legacy quota once without reimporting it after clear", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-legacy-capacity-"));
    const authRootDir = join(root, "auth");
    const stateRootDir = join(root, "job-state");
    const now = new Date("2026-07-12T12:00:00.000Z");
    try {
      new LocalFileWorkerAccountCapacityStore({
        rootDir: join(stateRootDir, "worker-account-capacity"),
      }).observe({
        accountId: "account-a",
        observedAt: new Date("2026-07-12T10:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-07-12T11:00:00.000Z"),
        },
      });
      const shared = migrateLegacyCodexAccountCapacity({
        authRootDir,
        stateRootDir,
        accountIds: ["account-a"],
        now,
      });
      const due = shared.readState({ accountId: "account-a", now });
      expect(due?.phase).toBe(WorkerAccountCapacityPhase.RecheckDue);
      const claim = shared.tryClaimRecheck({
        state: due!,
        ownerId: "migration-test",
        now,
        ttlMs: 30_000,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      });
      expect(claim.status).toBe(WorkerAccountCapacityClaimStatus.Claimed);
      shared.resolveRecheck({
        claim: claim.status === WorkerAccountCapacityClaimStatus.Claimed
          ? claim.claim
          : (() => { throw new Error("claim expected"); })(),
        observedAt: now,
        resolution: { type: WorkerAccountCapacityResolutionType.Available },
      });

      const restarted = migrateLegacyCodexAccountCapacity({
        authRootDir,
        stateRootDir,
        accountIds: ["account-a"],
        now,
      });
      expect(restarted.readState({ accountId: "account-a", now })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function goalConfig(
  root: string,
  authRootDir: string,
  taskId: string,
): CodexGoalRunConfig {
  return {
    jobRootDir: join(root, "jobs", taskId),
    authRootDir,
    workspacePath: join(root, "workspaces", taskId),
    promptPath: join(root, "jobs", taskId, "prompt.md"),
    taskId,
    accounts: [{ name: "account-a" }],
  };
}

async function writeAuth(
  authRootDir: string,
  slot: string,
  accountId: string,
  refreshToken: string,
): Promise<void> {
  const dir = join(authRootDir, slot);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "auth.json"),
    `${JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: accountId,
        refresh_token: refreshToken,
      },
    })}\n`,
  );
}

async function readTree(root: string): Promise<string> {
  const chunks: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      chunks.push(await readTree(path));
    } else {
      chunks.push(await readFile(path, "utf8"));
    }
  }
  return chunks.join("\n");
}

import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSubscriptionRuntime,
  DefaultRedactor,
  DeterministicIdGenerator,
  type RuntimeDeps,
  type SessionArtifact,
} from "@vioxen/subscription-runtime/core";
import {
  FakeAgentDriver,
  FakeProviderSessionDriver,
  FakeRunner,
  FakeWorkspace,
  MemoryObservability,
} from "@vioxen/subscription-runtime/testing";
import {
  createLocalFileBackendRuntimeAdapters,
  decodeLocalFileBackendEncryptionKey,
  LocalFileLeaseStore,
  localFileLeaseStoreManifest,
} from "../index";

const providerInstanceId = "codex-rotating:backend-file";
const encryptionKey = new Uint8Array(32).fill(9);

describe("Local file lease store", () => {
  it("declares local-only lease-store capabilities", () => {
    expect(localFileLeaseStoreManifest).toMatchObject({
      adapterId: "lease.local-file",
      adapterKind: "lease-store",
      custody: "local-only",
    });
  });

  it("acquires a lease and blocks another active lease until commit", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-lease-"),
    );
    const store = new LocalFileLeaseStore({ rootDir });

    try {
      const first = await store.acquire({
        providerInstanceId,
        runId: "run-1",
        attempt: 1,
        ttlMs: 60_000,
        restoredGenerationHash: "generation-1",
      });
      expect(first.status).toBe("granted");
      if (first.status !== "granted") throw new Error("lease_not_granted");

      await expect(
        store.acquire({
          providerInstanceId,
          runId: "run-2",
          attempt: 1,
          ttlMs: 60_000,
          restoredGenerationHash: "generation-1",
        }),
      ).resolves.toMatchObject({ status: "denied" });

      await store.finalize({
        leaseId: first.leaseId,
        restoredGenerationHash: "generation-1",
      });
      await expect(
        store.acquire({
          providerInstanceId,
          runId: "run-3",
          attempt: 1,
          ttlMs: 60_000,
          restoredGenerationHash: "generation-1",
        }),
      ).resolves.toMatchObject({ status: "denied" });

      await store.markWritebackStarted({ leaseId: first.leaseId });
      await expect(
        store.markWritebackCommitted({
          leaseId: first.leaseId,
          nextGenerationHash: "generation-2",
          idempotencyKey: "idem-1",
        }),
      ).resolves.toEqual({ status: "committed" });

      await expect(
        store.acquire({
          providerInstanceId,
          runId: "run-4",
          attempt: 1,
          ttlMs: 60_000,
          restoredGenerationHash: "generation-2",
        }),
      ).resolves.toMatchObject({ status: "granted" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("replaces expired active leases", async () => {
    let nowMs = Date.parse("2026-05-30T00:00:00.000Z");
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-lease-"),
    );
    const store = new LocalFileLeaseStore({
      rootDir,
      now: () => new Date(nowMs),
    });

    try {
      const first = await store.acquire({
        providerInstanceId,
        runId: "run-1",
        attempt: 1,
        ttlMs: 1_000,
        restoredGenerationHash: "generation-1",
      });
      expect(first.status).toBe("granted");

      nowMs += 1_001;
      await expect(
        store.acquire({
          providerInstanceId,
          runId: "run-2",
          attempt: 1,
          ttlMs: 1_000,
          restoredGenerationHash: "generation-1",
        }),
      ).resolves.toMatchObject({ status: "granted" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("fails closed when another process holds the provider lock", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-lease-"),
    );
    const store = new LocalFileLeaseStore({
      rootDir,
      lockAcquireTimeoutMs: 20,
      lockPollMs: 5,
    });
    const lockDir = join(rootDir, "leases", "locks");
    const lockPath = join(
      lockDir,
      `${hashTextForTest(providerInstanceId)}.lock`,
    );

    try {
      await mkdir(lockDir, { recursive: true });
      await writeFile(
        lockPath,
        `${JSON.stringify({
          storageVersion: "local-file-lease-lock-v1",
          lockId: "other-process",
          providerInstanceIdHash: hashTextForTest(providerInstanceId),
          pid: 999_999,
          acquiredAt: "2026-05-30T00:00:00.000Z",
          expiresAt: "2999-01-01T00:00:00.000Z",
        })}\n`,
      );

      await expect(
        store.acquire({
          providerInstanceId,
          runId: "run-locked",
          attempt: 1,
          ttlMs: 60_000,
          restoredGenerationHash: "generation-1",
        }),
      ).rejects.toThrow("local_file_lease_lock_timeout");
      await expect(readFile(lockPath, "utf8")).resolves.toContain(
        "other-process",
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("replaces stale provider lock files", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-lease-"),
    );
    const store = new LocalFileLeaseStore({
      rootDir,
      now: () => new Date("2026-05-30T00:00:00.000Z"),
    });
    const lockDir = join(rootDir, "leases", "locks");
    const lockPath = join(
      lockDir,
      `${hashTextForTest(providerInstanceId)}.lock`,
    );

    try {
      await mkdir(lockDir, { recursive: true });
      await writeFile(
        lockPath,
        `${JSON.stringify({
          storageVersion: "local-file-lease-lock-v1",
          lockId: "stale-process",
          providerInstanceIdHash: hashTextForTest(providerInstanceId),
          pid: 999_999,
          acquiredAt: "2026-05-29T23:00:00.000Z",
          expiresAt: "2026-05-29T23:00:01.000Z",
        })}\n`,
      );

      await expect(
        store.acquire({
          providerInstanceId,
          runId: "run-after-stale-lock",
          attempt: 1,
          ttlMs: 60_000,
          restoredGenerationHash: "generation-1",
        }),
      ).resolves.toMatchObject({ status: "granted" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not remove a newer provider lock after waiting on stale cleanup", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-lease-"),
    );
    const now = "2026-05-30T00:00:00.000Z";
    const store = new LocalFileLeaseStore({
      rootDir,
      now: () => new Date(now),
      lockAcquireTimeoutMs: 120,
      lockPollMs: 5,
    });
    const lockDir = join(rootDir, "leases", "locks");
    const lockPath = join(
      lockDir,
      `${hashTextForTest(providerInstanceId)}.lock`,
    );
    const staleLockId = "stale-process";
    const freshLockId = "fresh-process";
    const cleanupLockPath = `${lockPath}.${hashTextForTest(staleLockId)}.cleanup.lock`;

    try {
      await mkdir(lockDir, { recursive: true });
      await writeLockRecordForTest({
        path: lockPath,
        lockId: staleLockId,
        providerInstanceId,
        acquiredAt: "2026-05-29T23:00:00.000Z",
        expiresAt: "2026-05-29T23:00:01.000Z",
      });
      await writeLockRecordForTest({
        path: cleanupLockPath,
        lockId: "cleanup-holder",
        providerInstanceId: `${providerInstanceId}:lock-cleanup:${staleLockId}`,
        acquiredAt: now,
        expiresAt: "2026-05-30T00:01:00.000Z",
      });

      const acquire = store.acquire({
        providerInstanceId,
        runId: "run-after-stale-cleanup-race",
        attempt: 1,
        ttlMs: 60_000,
        restoredGenerationHash: "generation-1",
      });

      await delayForTest(25);
      await writeLockRecordForTest({
        path: lockPath,
        lockId: freshLockId,
        providerInstanceId,
        acquiredAt: now,
        expiresAt: "2026-05-30T00:01:00.000Z",
      });
      await rm(cleanupLockPath, { force: true });

      await expect(acquire).rejects.toThrow("local_file_lease_lock_timeout");
      await expect(readFile(lockPath, "utf8")).resolves.toContain(freshLockId);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("validates generation hash and keeps committed metadata idempotent", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-lease-"),
    );
    const store = new LocalFileLeaseStore({ rootDir });

    try {
      const lease = await store.acquire({
        providerInstanceId,
        runId: "run-1",
        attempt: 1,
        ttlMs: 60_000,
        restoredGenerationHash: "generation-1",
      });
      if (lease.status !== "granted") throw new Error("lease_not_granted");

      await expect(
        store.finalize({
          leaseId: lease.leaseId,
          restoredGenerationHash: "wrong-generation",
        }),
      ).rejects.toThrow("local_file_lease_generation_hash_mismatch");

      await store.finalize({
        leaseId: lease.leaseId,
        restoredGenerationHash: "generation-1",
      });
      await store.markWritebackStarted({
        leaseId: lease.leaseId,
        keyId: "key-1",
      });
      await store.markWritebackCommitted({
        leaseId: lease.leaseId,
        nextGenerationHash: "generation-2",
        idempotencyKey: "idem-1",
      });

      await expect(
        store.markWritebackCommitted({
          leaseId: lease.leaseId,
          nextGenerationHash: "generation-2",
          idempotencyKey: "idem-1",
        }),
      ).resolves.toEqual({ status: "idempotent_replay" });
      await expect(
        store.markWritebackCommitted({
          leaseId: lease.leaseId,
          nextGenerationHash: "generation-3",
          idempotencyKey: "idem-2",
        }),
      ).resolves.toMatchObject({ status: "stale_generation" });

      const serialized = (await readStoredFiles(rootDir)).join("\n");
      expect(serialized).toContain("generation-2");
      expect(serialized).toContain("idem-1");
      expect(serialized).not.toContain("refresh_token");
      expect(serialized).not.toContain("access_token");
      expect(serialized).not.toContain("id_token");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("releases active leases without deleting committed records", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-lease-"),
    );
    const store = new LocalFileLeaseStore({ rootDir });

    try {
      const lease = await store.acquire({
        providerInstanceId,
        runId: "run-1",
        attempt: 1,
        ttlMs: 60_000,
        restoredGenerationHash: "generation-1",
      });
      if (lease.status !== "granted") throw new Error("lease_not_granted");

      await store.release?.({
        leaseId: lease.leaseId,
        reason: "validation_failed",
      });
      const reacquiredSameRun = await store.acquire({
        providerInstanceId,
        runId: "run-1",
        attempt: 1,
        ttlMs: 60_000,
        restoredGenerationHash: "generation-1",
      });
      expect(reacquiredSameRun.status).toBe("granted");
      if (reacquiredSameRun.status !== "granted") {
        throw new Error("lease_not_granted");
      }
      await store.release?.({
        leaseId: reacquiredSameRun.leaseId,
        reason: "test-cleanup",
      });
      await expect(
        store.acquire({
          providerInstanceId,
          runId: "run-2",
          attempt: 1,
          ttlMs: 60_000,
          restoredGenerationHash: "generation-1",
        }),
      ).resolves.toMatchObject({ status: "granted" });

      const serialized = (await readStoredFiles(rootDir)).join("\n");
      expect(serialized).toContain("validation_failed");
      expect(serialized).toContain("released");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe("Local file backend runtime adapters", () => {
  it("creates session and lease stores from a single backend config", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-local-"),
    );
    const encodedKey = Buffer.from(encryptionKey).toString("base64url");
    const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
      providerId: "fake",
      rootDir,
      encryptionKey: encodedKey,
      metadata: { environment: "test" },
    });

    try {
      expect(decodeLocalFileBackendEncryptionKey(encodedKey)).toHaveLength(32);
      expect(sessionStore.storeId).toBe("local-encrypted-file");
      expect(leaseStore.leaseStoreId).toBe("local-file-lease-store");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("runs refresh and writeback through local file session and lease stores", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-local-"),
    );
    const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
      providerId: "fake",
      rootDir,
      encryptionKey,
    });
    const provider = new SlowRefreshProviderSessionDriver();
    provider.refreshText = "session-v2";
    const agent = new FakeAgentDriver();

    try {
      await sessionStore.write({
        providerInstanceId,
        expectedGeneration: 0,
        nextArtifact: makeArtifact("session-v1"),
        idempotencyKey: "seed",
        leaseId: "seed-lease",
      });

      const runtime = createSubscriptionRuntime(
        makeLocalRuntimeDeps({
          provider,
          agent,
          sessionStore,
          leaseStore,
        }),
      );
      const result = await runtime.refreshThenRunTask({
        providerInstanceId,
        task: { kind: "review", prompt: "inspect this" },
        runContext: {
          runId: "run-1",
          attempt: 1,
          abortSignal: new AbortController().signal,
        },
      });

      expect(result).toMatchObject({
        status: "completed",
        refresh: {
          status: "ready",
          writeback: { status: "accepted", generation: 2 },
        },
        task: { status: "completed", outputText: "review:inspect this" },
      });
      const envelope = await sessionStore.read({
        providerInstanceId,
        expectedProviderId: "fake",
        purpose: "run",
      });
      expect(new TextDecoder().decode(envelope?.artifact.bytes)).toBe(
        "session-v2",
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent local file refresh writeback", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-local-"),
    );
    const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
      providerId: "fake",
      rootDir,
      encryptionKey,
    });
    const provider = new FakeProviderSessionDriver();
    provider.refreshText = "session-v2";

    try {
      await sessionStore.write({
        providerInstanceId,
        expectedGeneration: 0,
        nextArtifact: makeArtifact("session-v1"),
        idempotencyKey: "seed",
        leaseId: "seed-lease",
      });

      const run = (runId: string) =>
        createSubscriptionRuntime(
          makeLocalRuntimeDeps({
            provider,
            agent: new FakeAgentDriver(),
            sessionStore,
            leaseStore,
          }),
        ).refreshThenRunTask({
          providerInstanceId,
          task: { kind: "review", prompt: runId },
          runContext: {
            runId,
            attempt: 1,
            abortSignal: new AbortController().signal,
          },
        });

      const results = await Promise.all([run("run-1"), run("run-2")]);
      const accepted = results.filter(
        (result) =>
          result.status === "completed" &&
          result.refresh.status === "ready" &&
          result.refresh.writeback.status === "accepted",
      );
      const blocked = results.filter((result) => result.status === "blocked");

      expect(accepted).toHaveLength(1);
      expect(blocked).toHaveLength(1);
      const envelope = await sessionStore.read({
        providerInstanceId,
        expectedProviderId: "fake",
        purpose: "run",
      });
      expect(envelope?.generation).toBe(2);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("releases the local file lease when refresh leaves the session unchanged", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-local-"),
    );
    const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
      providerId: "fake",
      rootDir,
      encryptionKey,
    });
    const provider = new FakeProviderSessionDriver();
    provider.refreshText = "session-v1";

    try {
      await sessionStore.write({
        providerInstanceId,
        expectedGeneration: 0,
        nextArtifact: makeArtifact("session-v1"),
        idempotencyKey: "seed",
        leaseId: "seed-lease",
      });

      const run = (runId: string) =>
        createSubscriptionRuntime(
          makeLocalRuntimeDeps({
            provider,
            agent: new FakeAgentDriver(),
            sessionStore,
            leaseStore,
          }),
        ).refreshThenRunTask({
          providerInstanceId,
          task: { kind: "review", prompt: runId },
          runContext: {
            runId,
            attempt: 1,
            abortSignal: new AbortController().signal,
          },
        });

      await expect(run("run-1")).resolves.toMatchObject({
        status: "completed",
        refresh: { status: "skipped", reason: "session_unchanged" },
      });
      await expect(run("run-2")).resolves.toMatchObject({
        status: "completed",
        refresh: { status: "skipped", reason: "session_unchanged" },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("releases the local file lease when validation blocks refresh", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-local-"),
    );
    const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
      providerId: "fake",
      rootDir,
      encryptionKey,
    });
    const provider = new FakeProviderSessionDriver();
    provider.validation = {
      status: "invalid",
      failure: {
        code: "needs_reconnect",
        retryable: false,
        reconnectRequired: true,
        safeMessage: "Reconnect required.",
      },
    };

    try {
      await sessionStore.write({
        providerInstanceId,
        expectedGeneration: 0,
        nextArtifact: makeArtifact("session-v1"),
        idempotencyKey: "seed",
        leaseId: "seed-lease",
      });

      const run = (runId: string) =>
        createSubscriptionRuntime(
          makeLocalRuntimeDeps({
            provider,
            agent: new FakeAgentDriver(),
            sessionStore,
            leaseStore,
          }),
        ).refreshThenRunTask({
          providerInstanceId,
          task: { kind: "review", prompt: runId },
          runContext: {
            runId,
            attempt: 1,
            abortSignal: new AbortController().signal,
          },
        });

      await expect(run("run-1")).resolves.toMatchObject({
        status: "blocked",
        reason: "provider_reconnect_required",
      });

      provider.validation = { status: "valid", warnings: [] };
      provider.refreshText = "session-v2";
      await expect(run("run-2")).resolves.toMatchObject({
        status: "completed",
        refresh: {
          status: "ready",
          writeback: { status: "accepted", generation: 2 },
        },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

function makeLocalRuntimeDeps(input: {
  readonly provider: FakeProviderSessionDriver;
  readonly agent: FakeAgentDriver;
  readonly sessionStore: NonNullable<RuntimeDeps["sessionStore"]>;
  readonly leaseStore: NonNullable<RuntimeDeps["leaseStore"]>;
}): RuntimeDeps {
  return {
    policy: {
      custodyMode: "local-only",
      requireNoBackendPlaintext: false,
      requireWritebackBeforeTask: true,
      requireCompareAndSwap: true,
      allowInteractiveSetupInRuntime: false,
      allowedProviderIds: [input.provider.providerId],
      allowedAgentIds: [input.agent.agentId],
      allowedStoreIds: [input.sessionStore.storeId],
      allowedRunnerIds: ["memory-runner"],
    },
    sessionDriver: input.provider,
    agentDriver: input.agent,
    sessionStore: input.sessionStore,
    leaseStore: input.leaseStore,
    runner: new FakeRunner(),
    workspace: new FakeWorkspace(),
    redactor: new DefaultRedactor(),
    observability: new MemoryObservability(),
    clock: {
      now: () => new Date("2026-05-30T00:00:00.000Z"),
      monotonicMs: () => 1,
    },
    idGenerator: new DeterministicIdGenerator(),
  };
}

class SlowRefreshProviderSessionDriver extends FakeProviderSessionDriver {
  override async refreshSession() {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return super.refreshSession();
  }
}

function makeArtifact(value: string): SessionArtifact {
  return {
    kind: "json-file",
    providerId: "fake",
    formatVersion: "fake-session-v1",
    bytes: new TextEncoder().encode(value),
    contentType: "application/json",
  };
}

function hashTextForTest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeLockRecordForTest(input: {
  readonly path: string;
  readonly lockId: string;
  readonly providerInstanceId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}): Promise<void> {
  await writeFile(
    input.path,
    `${JSON.stringify({
      storageVersion: "local-file-lease-lock-v1",
      lockId: input.lockId,
      providerInstanceIdHash: hashTextForTest(input.providerInstanceId),
      pid: 999_999,
      acquiredAt: input.acquiredAt,
      expiresAt: input.expiresAt,
    })}\n`,
  );
}

function delayForTest(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStoredFiles(rootDir: string): Promise<readonly string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return readStoredFiles(path);
      }
      return [await readFile(path, "utf8")];
    }),
  );
  return files.flat();
}

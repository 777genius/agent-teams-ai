import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryObservability } from "../../core/testing";
import {
  WorkerAccountCapacityClaimStatus,
  WorkerAccountCapacityPhase,
  WorkerAccountCapacityRecheckMode,
  WorkerAccountCapacityResolutionType,
  WorkerAccountCapacityResolveStatus,
  WorkerAccountCapacitySignalScope,
  WorkerAccountCapacityMetric,
} from "../../worker-core";
import { LocalFileWorkerAccountCapacityStore } from "../index";

describe("Local file worker account capacity store", () => {
  it("persists account cooldown across store instances", async () => {
    const rootDir = await tempRoot();
    const observedAt = new Date("2026-06-01T00:00:00.000Z");
    const resetAt = new Date("2026-06-01T01:00:00.000Z");

    try {
      new LocalFileWorkerAccountCapacityStore({ rootDir }).observe({
        accountId: " account-a ",
        observedAt,
        sourceWorkerId: "worker-a1",
        capacity: {
          availability: "cooldown",
          reason: "rate_limit_threshold",
          cooldownUntil: resetAt,
          details: { quotaGroup: "claude-oauth:account-a" },
        },
      });

      const restarted = new LocalFileWorkerAccountCapacityStore({ rootDir });

      expect(
        restarted.read({ accountId: "account-a", now: observedAt }),
      ).toMatchObject({
        availability: "cooldown",
        reason: "rate_limit_threshold",
        cooldownUntil: resetAt,
        lastLimitSignalAt: observedAt,
        details: {
          accountId: "account-a",
          quotaGroup: "claude-oauth:account-a",
          sourceWorkerId: "worker-a1",
        },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("persists demand-specific account capacity separately", async () => {
    const rootDir = await tempRoot();
    const observedAt = new Date("2026-06-01T00:00:00.000Z");
    const resetAt = new Date("2026-06-01T01:00:00.000Z");

    try {
      new LocalFileWorkerAccountCapacityStore({ rootDir }).observe({
        accountId: "account-a",
        observedAt,
        demand: {
          provider: "codex",
          model: "gpt-5.5",
          reasoningEffort: "high",
          serviceTier: "fast",
        },
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: resetAt,
        },
      });

      const restarted = new LocalFileWorkerAccountCapacityStore({ rootDir });

      expect(
        restarted.read({
          accountId: "account-a",
          now: observedAt,
          demand: {
            provider: "codex",
            model: "gpt-5.5",
            reasoningEffort: "high",
            serviceTier: "fast",
          },
        }),
      ).toMatchObject({
        availability: "quota_exhausted",
        cooldownUntil: resetAt,
        details: {
          accountId: "account-a",
          capacityProvider: "codex",
          capacityReasoningEffort: "high",
        },
      });
      expect(
        restarted.read({
          accountId: "account-a",
          now: observedAt,
          demand: {
            provider: "codex",
            model: "gpt-5.5",
            reasoningEffort: "xhigh",
            serviceTier: "fast",
          },
        }),
      ).toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("falls back to generic persisted account capacity for demand-specific reads", async () => {
    const rootDir = await tempRoot();
    const observedAt = new Date("2026-06-01T00:00:00.000Z");
    const resetAt = new Date("2026-06-01T01:00:00.000Z");

    try {
      new LocalFileWorkerAccountCapacityStore({ rootDir }).observe({
        accountId: "account-a",
        observedAt,
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: resetAt,
        },
      });

      const restarted = new LocalFileWorkerAccountCapacityStore({ rootDir });

      expect(
        restarted.read({
          accountId: "account-a",
          now: observedAt,
          demand: {
            provider: "codex",
            model: "gpt-5.5",
            reasoningEffort: "xhigh",
            serviceTier: "fast",
          },
        }),
      ).toMatchObject({
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: resetAt,
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not let a short demand cooldown shadow a longer account-wide quota", async () => {
    const rootDir = await tempRoot();
    const now = new Date("2026-06-01T00:00:00.000Z");
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });
    try {
      store.observe({
        accountId: "account-a",
        scope: WorkerAccountCapacitySignalScope.AccountWide,
        observedAt: now,
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-06-01T04:00:00.000Z"),
          details: { provider: "codex" },
        },
      });
      store.observe({
        accountId: "account-a",
        demand: { provider: "codex", model: "gpt-5.5" },
        observedAt: now,
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-06-01T00:15:00.000Z"),
        },
      });

      expect(
        store.read({
          accountId: "account-a",
          demand: { provider: "codex", model: "gpt-5.5" },
          now,
        }),
      ).toMatchObject({
        cooldownUntil: new Date("2026-06-01T04:00:00.000Z"),
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("aggregates demand-specific persisted records for account-wide reads", async () => {
    const rootDir = await tempRoot();
    const observedAt = new Date("2026-06-01T00:00:00.000Z");
    const shortResetAt = new Date("2026-06-01T00:30:00.000Z");
    const longResetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });

    try {
      store.observe({
        accountId: "account-a",
        observedAt,
        demand: {
          provider: "codex",
          model: "gpt-5.5",
          reasoningEffort: "high",
          serviceTier: "fast",
        },
        capacity: {
          availability: "cooldown",
          reason: "rate_limit_threshold",
          cooldownUntil: shortResetAt,
        },
      });
      store.observe({
        accountId: "account-a",
        observedAt,
        demand: {
          provider: "codex",
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
          serviceTier: "fast",
        },
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: longResetAt,
        },
      });

      expect(
        new LocalFileWorkerAccountCapacityStore({ rootDir }).read({
          accountId: "account-a",
          now: observedAt,
        }),
      ).toMatchObject({
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: longResetAt,
        details: {
          accountId: "account-a",
          capacityReasoningEffort: "xhigh",
        },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("retains expired cooldown records until post-reset recheck", async () => {
    const rootDir = await tempRoot();
    const observedAt = new Date("2026-06-01T00:00:00.000Z");
    const resetAt = new Date("2026-06-01T00:00:01.000Z");
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });

    try {
      store.observe({
        accountId: "account-a",
        observedAt,
        capacity: {
          availability: "cooldown",
          cooldownUntil: resetAt,
        },
      });

      expect(
        store.read({ accountId: "account-a", now: observedAt }),
      ).toMatchObject({
        availability: "cooldown",
      });
      expect(
        store.read({
          accountId: "account-a",
          now: new Date(resetAt.getTime() + 1),
        }),
      ).toBeNull();
      expect(
        store.readState({
          accountId: "account-a",
          now: new Date(resetAt.getTime() + 1),
        }),
      ).toMatchObject({
        phase: WorkerAccountCapacityPhase.RecheckDue,
        capacity: { availability: "cooldown" },
      });
      await expect(readCapacityFiles(rootDir)).resolves.toHaveLength(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps the more severe or longer account capacity signal", async () => {
    const rootDir = await tempRoot();
    const observedAt = new Date("2026-06-01T00:00:00.000Z");
    const shortResetAt = new Date("2026-06-01T00:30:00.000Z");
    const longResetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });

    try {
      store.observe({
        accountId: "account-a",
        observedAt,
        capacity: {
          availability: "quota_exhausted",
          cooldownUntil: longResetAt,
        },
      });
      store.observe({
        accountId: "account-a",
        observedAt,
        capacity: {
          availability: "cooldown",
          reason: "rate_limit_threshold",
          cooldownUntil: shortResetAt,
        },
      });

      expect(
        store.read({ accountId: "account-a", now: observedAt }),
      ).toMatchObject({
        availability: "quota_exhausted",
        cooldownUntil: longResetAt,
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("replaces same-severity records when the next signal adds a reset time", async () => {
    const rootDir = await tempRoot();
    const observedAt = new Date("2026-06-01T00:00:00.000Z");
    const resetAt = new Date("2026-06-01T01:00:00.000Z");
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });

    try {
      store.observe({
        accountId: "account-a",
        observedAt,
        capacity: {
          availability: "quota_exhausted",
        },
      });
      store.observe({
        accountId: "account-a",
        observedAt,
        capacity: {
          availability: "quota_exhausted",
          cooldownUntil: resetAt,
        },
      });

      expect(
        store.read({ accountId: "account-a", now: observedAt }),
      ).toMatchObject({
        availability: "quota_exhausted",
        cooldownUntil: resetAt,
      });
      expect(
        store.read({
          accountId: "account-a",
          now: new Date(resetAt.getTime() + 1),
        }),
      ).toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("clears normalized account records", async () => {
    const rootDir = await tempRoot();
    const now = new Date("2026-06-01T00:00:00.000Z");
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });

    try {
      store.observe({
        accountId: " account-a ",
        observedAt: now,
        capacity: {
          availability: "cooldown",
          cooldownUntil: new Date("2026-06-01T01:00:00.000Z"),
        },
      });

      store.clear({ accountId: "account-a" });

      expect(store.read({ accountId: " account-a ", now })).toBeNull();
      await expect(readCapacityFiles(rootDir)).resolves.toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("clears both generic and demand-specific account records", async () => {
    const rootDir = await tempRoot();
    const now = new Date("2026-06-01T00:00:00.000Z");
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });

    try {
      store.observe({
        accountId: "account-a",
        observedAt: now,
        capacity: {
          availability: "cooldown",
          cooldownUntil: new Date("2026-06-01T00:30:00.000Z"),
        },
      });
      store.observe({
        accountId: "account-a",
        observedAt: now,
        demand: {
          provider: "codex",
          reasoningEffort: "xhigh",
          serviceTier: "fast",
        },
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-06-01T01:00:00.000Z"),
        },
      });

      expect(await readCapacityFiles(rootDir)).toHaveLength(2);

      store.clear({ accountId: " account-a " });

      expect(store.read({ accountId: "account-a", now })).toBeNull();
      expect(
        store.read({
          accountId: "account-a",
          now,
          demand: {
            provider: "codex",
            reasoningEffort: "xhigh",
            serviceTier: "fast",
          },
        }),
      ).toBeNull();
      await expect(readCapacityFiles(rootDir)).resolves.toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("self-heals malformed account records", async () => {
    const rootDir = await tempRoot();
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });
    const recordPath = capacityRecordPath(rootDir, "account-a");

    try {
      await mkdir(join(rootDir, "account-capacity"), { recursive: true });
      await writeFile(recordPath, "{not-json\n", { mode: 0o600 });

      expect(
        store.read({
          accountId: "account-a",
          now: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ).toBeNull();
      await expect(readCapacityFiles(rootDir)).resolves.toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("self-heals structurally invalid account records", async () => {
    const rootDir = await tempRoot();
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });
    const recordPath = capacityRecordPath(rootDir, "account-a");

    try {
      await mkdir(join(rootDir, "account-capacity"), { recursive: true });
      await writeFile(
        recordPath,
        `${JSON.stringify({
          storageVersion: "local-file-worker-account-capacity-v1",
          accountId: "account-a",
          updatedAt: "2026-06-01T00:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );

      expect(
        store.read({
          accountId: "account-a",
          now: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ).toBeNull();
      await expect(readCapacityFiles(rootDir)).resolves.toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("self-heals records written under the wrong account key", async () => {
    const rootDir = await tempRoot();
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });
    const recordPath = capacityRecordPath(rootDir, "account-a");

    try {
      await mkdir(join(rootDir, "account-capacity"), { recursive: true });
      await writeFile(
        recordPath,
        `${JSON.stringify({
          storageVersion: "local-file-worker-account-capacity-v1",
          accountId: "account-b",
          capacity: {
            availability: "quota_exhausted",
            cooldownUntil: "2026-06-01T01:00:00.000Z",
          },
          updatedAt: "2026-06-01T00:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );

      expect(
        store.read({
          accountId: "account-a",
          now: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ).toBeNull();
      await expect(readCapacityFiles(rootDir)).resolves.toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("self-heals account records with invalid persisted capacity", async () => {
    const rootDir = await tempRoot();
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });
    const recordPath = capacityRecordPath(rootDir, "account-a");

    try {
      await mkdir(join(rootDir, "account-capacity"), { recursive: true });
      await writeFile(
        recordPath,
        `${JSON.stringify({
          storageVersion: "local-file-worker-account-capacity-v1",
          accountId: "account-a",
          capacity: {
            availability: "unknown",
          },
          updatedAt: "2026-06-01T00:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );

      expect(
        store.read({
          accountId: "account-a",
          now: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ).toBeNull();
      await expect(readCapacityFiles(rootDir)).resolves.toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("self-heals account records with non-persistable capacity states", async () => {
    const rootDir = await tempRoot();
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });
    const recordPath = capacityRecordPath(rootDir, "account-a");

    try {
      await mkdir(join(rootDir, "account-capacity"), { recursive: true });
      await writeFile(
        recordPath,
        `${JSON.stringify({
          storageVersion: "local-file-worker-account-capacity-v1",
          accountId: "account-a",
          capacity: {
            availability: "disabled",
            reason: "tampered",
          },
          updatedAt: "2026-06-01T00:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );

      expect(
        store.read({
          accountId: "account-a",
          now: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ).toBeNull();
      await expect(readCapacityFiles(rootDir)).resolves.toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("allows only one post-reset recheck across store instances", async () => {
    const rootDir = await tempRoot();
    const resetAt = new Date("2026-06-01T00:01:00.000Z");
    const now = new Date("2026-06-01T00:01:00.001Z");
    const first = new LocalFileWorkerAccountCapacityStore({ rootDir });
    const second = new LocalFileWorkerAccountCapacityStore({ rootDir });
    try {
      first.observe({
        accountId: "account-a",
        observedAt: new Date("2026-06-01T00:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: resetAt,
        },
      });
      const state = first.readState({ accountId: "account-a", now });
      expect(state?.phase).toBe(WorkerAccountCapacityPhase.RecheckDue);
      const claimed = first.tryClaimRecheck({
        state: state!,
        ownerId: "worker-a",
        now,
        ttlMs: 30_000,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      });
      expect(claimed.status).toBe(WorkerAccountCapacityClaimStatus.Claimed);

      const racedState = second.readState({ accountId: "account-a", now });
      const raced = second.tryClaimRecheck({
        state: racedState!,
        ownerId: "worker-b",
        now,
        ttlMs: 30_000,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      });
      expect(raced).toMatchObject({
        status: WorkerAccountCapacityClaimStatus.Busy,
      });
      expect(second.read({ accountId: "account-a", now })).toMatchObject({
        availability: "cooldown",
        reason: "quota_recheck_in_progress",
      });
      const recoveredAt = new Date(now.getTime() + 30_001);
      const recoveredState = second.readState({
        accountId: "account-a",
        now: recoveredAt,
      });
      const recovered = second.tryClaimRecheck({
        state: recoveredState!,
        ownerId: "worker-b",
        now: recoveredAt,
        ttlMs: 30_000,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      });
      expect(recovered.status).toBe(WorkerAccountCapacityClaimStatus.Claimed);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("resolves available narrowly without deleting sibling demand records", async () => {
    const rootDir = await tempRoot();
    const observedAt = new Date("2026-06-01T00:00:00.000Z");
    const resetAt = new Date("2026-06-01T00:01:00.000Z");
    const now = new Date("2026-06-01T00:01:00.001Z");
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });
    try {
      store.observe({
        accountId: "account-a",
        observedAt,
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: resetAt,
        },
      });
      const generic = store.readState({ accountId: "account-a", now });
      const claimed = store.tryClaimRecheck({
        state: generic!,
        ownerId: "worker-a",
        now,
        ttlMs: 30_000,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      });
      expect(claimed.status).toBe(WorkerAccountCapacityClaimStatus.Claimed);
      store.observe({
        accountId: "account-a",
        demand: { provider: "codex", model: "gpt-5.5" },
        observedAt: now,
        capacity: {
          availability: "cooldown",
          reason: "model_limit",
          cooldownUntil: new Date("2026-06-01T02:00:00.000Z"),
        },
      });
      const resolved = store.resolveRecheck({
        claim: claimed.status === WorkerAccountCapacityClaimStatus.Claimed
          ? claimed.claim
          : (() => { throw new Error("claim expected"); })(),
        observedAt: now,
        resolution: { type: WorkerAccountCapacityResolutionType.Available },
      });
      expect(resolved.status).toBe(WorkerAccountCapacityResolveStatus.Applied);
      expect(
        store.read({
          accountId: "account-a",
          demand: { provider: "codex", model: "gpt-5.5" },
          now,
        }),
      ).toMatchObject({ reason: "model_limit" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects a stale CAS resolution after a newer observation", async () => {
    const rootDir = await tempRoot();
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });
    const observedAt = new Date("2026-06-01T00:00:00.000Z");
    const dueAt = new Date("2026-06-01T00:01:00.000Z");
    try {
      store.observe({
        accountId: "account-a",
        observedAt,
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: dueAt,
        },
      });
      const state = store.readState({ accountId: "account-a", now: dueAt });
      const claimed = store.tryClaimRecheck({
        state: state!,
        ownerId: "worker-a",
        now: dueAt,
        ttlMs: 1,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      });
      expect(claimed.status).toBe(WorkerAccountCapacityClaimStatus.Claimed);
      const newerAt = new Date(dueAt.getTime() + 2);
      store.observe({
        accountId: "account-a",
        observedAt: newerAt,
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-06-01T03:00:00.000Z"),
        },
      });
      const result = store.resolveRecheck({
        claim: claimed.status === WorkerAccountCapacityClaimStatus.Claimed
          ? claimed.claim
          : (() => { throw new Error("claim expected"); })(),
        observedAt: newerAt,
        resolution: { type: WorkerAccountCapacityResolutionType.Available },
      });
      expect(result.status).toBe(WorkerAccountCapacityResolveStatus.StaleClaim);
      expect(store.read({ accountId: "account-a", now: newerAt })).toMatchObject({
        cooldownUntil: new Date("2026-06-01T03:00:00.000Z"),
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("invalidates an active claim when a fresh limit is observed", async () => {
    const rootDir = await tempRoot();
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });
    const dueAt = new Date("2026-06-01T00:01:00.000Z");
    try {
      store.observe({
        accountId: "account-a",
        observedAt: new Date("2026-06-01T00:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: dueAt,
        },
      });
      const state = store.readState({ accountId: "account-a", now: dueAt })!;
      const claimed = store.tryClaimRecheck({
        state,
        ownerId: "worker-a",
        now: dueAt,
        ttlMs: 30_000,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      });
      expect(claimed.status).toBe(WorkerAccountCapacityClaimStatus.Claimed);
      const freshReset = new Date("2026-06-01T04:00:00.000Z");
      store.observe({
        accountId: "account-a",
        observedAt: new Date(dueAt.getTime() + 1),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: freshReset,
        },
      });
      const result = store.resolveRecheck({
        claim: claimed.status === WorkerAccountCapacityClaimStatus.Claimed
          ? claimed.claim
          : (() => { throw new Error("claim expected"); })(),
        observedAt: new Date(dueAt.getTime() + 2),
        resolution: { type: WorkerAccountCapacityResolutionType.Available },
      });

      expect(result.status).toBe(WorkerAccountCapacityResolveStatus.Conflict);
      expect(store.read({ accountId: "account-a", now: dueAt })).toMatchObject({
        cooldownUntil: freshReset,
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps a bounded blocker when a limited recheck result already expired", async () => {
    const rootDir = await tempRoot();
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir });
    const dueAt = new Date("2026-06-01T00:01:00.000Z");
    try {
      store.observe({
        accountId: "account-a",
        observedAt: new Date("2026-06-01T00:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: dueAt,
        },
      });
      const state = store.readState({ accountId: "account-a", now: dueAt })!;
      const claimed = store.tryClaimRecheck({
        state,
        ownerId: "worker-a",
        now: dueAt,
        ttlMs: 5 * 60_000,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      });
      expect(claimed.status).toBe(WorkerAccountCapacityClaimStatus.Claimed);
      const observedAt = new Date(dueAt.getTime() + 2 * 60_000);
      const result = store.resolveRecheck({
        claim: claimed.status === WorkerAccountCapacityClaimStatus.Claimed
          ? claimed.claim
          : (() => { throw new Error("claim expected"); })(),
        observedAt,
        resolution: {
          type: WorkerAccountCapacityResolutionType.Limited,
          capacity: {
            availability: "cooldown",
            reason: "quota_recheck_inconclusive",
            cooldownUntil: new Date(dueAt.getTime() + 60_000),
          },
        },
      });

      expect(result.status).toBe(WorkerAccountCapacityResolveStatus.Applied);
      expect(store.read({ accountId: "account-a", now: observedAt })).toMatchObject({
        reason: "quota_recheck_invalid_limited",
        cooldownUntil: new Date(observedAt.getTime() + 60_000),
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("emits due, busy, failed and time-to-reset capacity metrics", async () => {
    const rootDir = await tempRoot();
    const observability = new MemoryObservability();
    const store = new LocalFileWorkerAccountCapacityStore({
      rootDir,
      observability,
    });
    const observedAt = new Date("2026-06-01T00:00:00.000Z");
    const resetAt = new Date("2026-06-01T02:00:00.000Z");
    const now = new Date(resetAt.getTime() + 1);
    try {
      store.observe({
        accountId: "account-a",
        observedAt,
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: resetAt,
        },
      });
      const state = store.readState({ accountId: "account-a", now })!;
      const claimed = store.tryClaimRecheck({
        state,
        ownerId: "worker-a",
        now,
        ttlMs: 30_000,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      });
      const busy = store.tryClaimRecheck({
        state,
        ownerId: "worker-b",
        now,
        ttlMs: 30_000,
        mode: WorkerAccountCapacityRecheckMode.DueOnly,
      });
      expect(claimed.status).toBe(WorkerAccountCapacityClaimStatus.Claimed);
      expect(busy.status).toBe(WorkerAccountCapacityClaimStatus.Busy);
      store.resolveRecheck({
        claim: claimed.status === WorkerAccountCapacityClaimStatus.Claimed
          ? claimed.claim
          : (() => { throw new Error("claim expected"); })(),
        observedAt: now,
        resolution: {
          type: WorkerAccountCapacityResolutionType.Retry,
          retryAt: new Date(now.getTime() + 60_000),
          reason: "quota_recheck_failed",
        },
      });

      expect(observability.timings).toEqual([{
        metric: WorkerAccountCapacityMetric.TimeToResetMs,
        durationMs: 2 * 60 * 60_000,
      }]);
      expect(observability.counts).toEqual([
        { metric: WorkerAccountCapacityMetric.RecheckDue, value: 1 },
        { metric: WorkerAccountCapacityMetric.RecheckDue, value: 1 },
        { metric: WorkerAccountCapacityMetric.RecheckBusy, value: 1 },
        { metric: WorkerAccountCapacityMetric.RecheckFailed, value: 1 },
      ]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

});

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "subscription-runtime-account-capacity-"));
}

async function readCapacityFiles(rootDir: string): Promise<readonly string[]> {
  return [
    ...(await readFilesUnder(rootDir, "account-capacity")),
    ...(await readFilesUnder(rootDir, "account-capacity-v2")),
  ].sort();
}

async function readFilesUnder(
  rootDir: string,
  relativeDir: string,
): Promise<readonly string[]> {
  const root = join(rootDir, relativeDir);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        for (const child of await readFilesUnder(
          root,
          entry.name,
        )) {
          files.push(`${entry.name}/${child}`);
        }
      } else {
        files.push(entry.name);
      }
    }
    return files;
  } catch {
    return [];
  }
}

function capacityRecordPath(rootDir: string, accountId: string): string {
  return join(
    rootDir,
    "account-capacity",
    createHash("sha256").update(accountId).digest("hex"),
  );
}

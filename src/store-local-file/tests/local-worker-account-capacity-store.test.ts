import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

  it("expires cooldown records at reset time", async () => {
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
      await expect(readCapacityFiles(rootDir)).resolves.toEqual([]);
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

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalFileRunEventOrchestratorStateStore } from "../index";

describe("LocalFileRunEventOrchestratorStateStore", () => {
  it("persists orchestrator policy state per orchestrator id", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-orchestrator-state-"));
    const store = new LocalFileRunEventOrchestratorStateStore({ rootDir });

    await store.writeState({
      schemaVersion: 1,
      orchestratorId: "orch-a",
      cursor: { value: "10" },
      processedEventIds: ["event-a"],
      cooldowns: [{ key: "notify:run-a", until: "2026-07-02T00:10:00.000Z" }],
      actionAttempts: [{
        key: "control:run-a",
        count: 2,
        latestEventId: "event-a",
        latestAttemptAt: "2026-07-02T00:05:00.000Z",
      }],
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    await expect(store.readState("orch-a")).resolves.toMatchObject({
      orchestratorId: "orch-a",
      cursor: { value: "10" },
      processedEventIds: ["event-a"],
      actionAttempts: [expect.objectContaining({ key: "control:run-a", count: 2 })],
    });
    await expect(store.readState("orch-b")).resolves.toBeNull();
  });

  it("drops corrupted state files instead of throwing forever", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-orchestrator-state-"));
    const store = new LocalFileRunEventOrchestratorStateStore({ rootDir });
    const statePath = join(
      rootDir,
      "run-event-orchestrator-state",
      createHash("sha256").update("bad").digest("hex"),
    );
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, "{bad", "utf8");

    await expect(store.readState("bad")).resolves.toBeNull();
  });
});

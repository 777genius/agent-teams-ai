import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalFileRunObservationHistoryStore } from "../local-run-observation-history-store";

describe("LocalFileRunObservationHistoryStore", () => {
  it("writes and reads the latest observation history entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-observation-history-"));
    const store = new LocalFileRunObservationHistoryStore({ rootDir: root });
    try {
      await store.writeObservation({
        schemaVersion: 1,
        runId: "run-a",
        providerKind: "codex",
        observedAt: "2026-07-01T00:00:00.000Z",
        workspaceDirty: true,
        changedFilesCount: 2,
        workspaceSignature: "dirty",
        resultExists: false,
        logByteLength: 42,
      });

      await expect(store.readObservation("run-a")).resolves.toMatchObject({
        runId: "run-a",
        providerKind: "codex",
        workspaceDirty: true,
        changedFilesCount: 2,
        logByteLength: 42,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores invalid persisted records instead of breaking watch", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-observation-history-"));
    const store = new LocalFileRunObservationHistoryStore({ rootDir: root });
    try {
      await store.writeObservation({
        schemaVersion: 1,
        runId: "run-a",
        providerKind: "codex",
        observedAt: "2026-07-01T00:00:00.000Z",
      });
      const recordPath = await firstRecordPath(root);
      await writeFile(recordPath, "{not-json\n");

      await expect(store.readObservation("run-a")).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function firstRecordPath(root: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const historyRoot = join(root, "run-observation-history");
  const [entry] = await readdir(historyRoot);
  if (!entry) throw new Error("history_record_missing");
  return join(historyRoot, entry);
}

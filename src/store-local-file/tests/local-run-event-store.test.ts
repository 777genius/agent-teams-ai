import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  LocalFileRunEventDeliveryCursorStore,
  LocalFileRunEventStore,
  LocalFileRunEventProjectionStateStore,
} from "../index";
import {
  RunEventProviderKind,
  RunEventCompactionSafetyMode,
  RunEventType,
  makeRunEvent,
  runEventProjectionStateFromSnapshot,
  type RunObservationSnapshot,
} from "@vioxen/subscription-runtime/worker-core";

describe("LocalFileRunEventStore", () => {
  it("dedupes appends by event id and reads by cursor", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-store-"));
    const store = new LocalFileRunEventStore({ rootDir });
    const first = event("run-a", RunEventType.ProgressUpdated, "progress-a");
    const second = event("run-a", RunEventType.ResultUpdated, "result-a");

    await expect(store.append([first, first, second])).resolves.toMatchObject({
      appendedCount: 2,
      skippedDuplicateCount: 1,
    });

    const page = await store.read({ limit: 1 });
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor?.value).toBe("1");

    const rest = await store.read(
      page.nextCursor === undefined ? {} : { cursor: page.nextCursor },
    );
    expect(rest.events.map((item) => item.eventId)).toEqual([second.eventId]);
  });

  it("does not let a trailing newline cursor skip later appends", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-store-"));
    const store = new LocalFileRunEventStore({ rootDir });
    const first = event("run-a", RunEventType.ProgressUpdated, "progress-a");
    const second = event("run-a", RunEventType.Completed, "completed-a");

    await store.append([first]);
    const readAll = await store.read();
    expect(readAll.nextCursor?.value).toBe("1");

    await store.append([second]);
    const afterCursor = await store.read(
      readAll.nextCursor === undefined ? {} : { cursor: readAll.nextCursor },
    );
    expect(afterCursor.events.map((item) => item.eventId)).toEqual([second.eventId]);
  });

  it("skips corrupt lines and keeps reading valid events", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-store-"));
    const path = join(rootDir, "run-events", "events.ndjson");
    const store = new LocalFileRunEventStore({ rootDir, eventLogPath: path });
    const first = event("run-a", RunEventType.ProgressUpdated, "progress-a");
    const second = event("run-b", RunEventType.Completed, "completed-b");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      [
        JSON.stringify(first),
        "{broken",
        JSON.stringify(second),
        "",
      ].join("\n"),
      { encoding: "utf8" },
    );

    const read = await store.read({ runId: "run-b" });

    expect(read.events.map((item) => item.eventId)).toEqual([second.eventId]);
    expect(read.warnings).toEqual([
      expect.objectContaining({ code: "invalid_event_json", lineNumber: 2 }),
    ]);
  });

  it("applies scoped read filters before limit", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-store-"));
    const store = new LocalFileRunEventStore({ rootDir });
    const foreign = event("run-foreign", RunEventType.ProgressUpdated, "foreign", {
      providerKind: RunEventProviderKind.Claude,
      registryRootDir: "/tmp/other-registry",
    });
    const first = event("run-a", RunEventType.ProgressUpdated, "progress-a", {
      registryRootDir: "/tmp/registry",
    });
    const second = event("run-b", RunEventType.Completed, "completed-b", {
      registryRootDir: "/tmp/registry",
    });

    await store.append([foreign, first, second]);

    const read = await store.read({
      limit: 1,
      runIds: ["run-a", "run-b"],
      sourceProviderKind: RunEventProviderKind.Codex,
      sourceRegistryRootDir: "/tmp/registry",
    });

    expect(read.events.map((item) => item.eventId)).toEqual([first.eventId]);
    expect(read.nextCursor?.value).toBe("2");
  });

  it("recovers stale append locks", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-store-"));
    const path = join(rootDir, "run-events", "events.ndjson");
    await mkdir(dirname(path), { recursive: true });
    await mkdir(`${path}.lock`);
    const staleTime = new Date("2026-07-01T00:00:00.000Z");
    await utimes(`${path}.lock`, staleTime, staleTime);
    const store = new LocalFileRunEventStore({
      rootDir,
      eventLogPath: path,
      lockTtlMs: 0,
    });

    await expect(store.append([
      event("run-a", RunEventType.ProgressUpdated, "progress-a"),
    ])).resolves.toMatchObject({ appendedCount: 1 });
  });

  it("persists projection state atomically per run id", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-state-"));
    const store = new LocalFileRunEventProjectionStateStore({ rootDir });
    const state = runEventProjectionStateFromSnapshot(snapshot());

    await store.writeProjectionState(state);

    await expect(store.readProjectionState("run-a")).resolves.toEqual(state);
    await expect(store.readProjectionState("run-b")).resolves.toBeNull();
  });

  it("persists delivery cursors per consumer", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-cursor-"));
    const store = new LocalFileRunEventDeliveryCursorStore({ rootDir });

    await store.writeDeliveryCursor({
      consumerId: "consumer-a",
      cursor: { value: "42" },
    });

    await expect(store.readDeliveryCursor("consumer-a")).resolves.toEqual({
      value: "42",
    });
    await expect(store.readDeliveryCursor("consumer-b")).resolves.toBeNull();
  });

  it("compacts delivered events and rebases saved delivery cursors", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-compact-"));
    const store = new LocalFileRunEventStore({ rootDir });
    const cursors = new LocalFileRunEventDeliveryCursorStore({ rootDir });
    const first = event("run-a", RunEventType.ProgressUpdated, "progress-a");
    const second = event("run-a", RunEventType.ResultUpdated, "result-a");
    const third = event("run-a", RunEventType.Completed, "completed-a");
    await store.append([first, second, third]);
    await cursors.writeDeliveryCursor({
      consumerId: "consumer-a",
      cursor: { value: "2" },
    });

    const result = await store.compact({ compactDeliveredEvents: true });

    expect(result).toMatchObject({
      compacted: true,
      removableLineCount: 2,
      retainedLineCount: 1,
      cursorRewrites: [
        expect.objectContaining({
          consumerId: "consumer-a",
          previousCursor: { value: "2" },
          nextCursor: { value: "0" },
          invalidatedUnreadEvents: false,
        }),
      ],
    });
    await expect(cursors.readDeliveryCursor("consumer-a")).resolves.toEqual({
      value: "0",
    });
    await expect(store.read()).resolves.toMatchObject({
      events: [expect.objectContaining({ eventId: third.eventId })],
    });
  });

  it("preserves unread events when retention is blocked by saved cursors", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-compact-"));
    const store = new LocalFileRunEventStore({ rootDir });
    const cursors = new LocalFileRunEventDeliveryCursorStore({ rootDir });
    const first = event("run-a", RunEventType.ProgressUpdated, "progress-a");
    const second = event("run-a", RunEventType.ResultUpdated, "result-a");
    const third = event("run-a", RunEventType.Completed, "completed-a");
    await store.append([first, second, third]);
    await cursors.writeDeliveryCursor({
      consumerId: "consumer-a",
      cursor: { value: "1" },
    });

    const result = await store.compact({ keepLatestEventsPerRun: 1 });

    expect(result).toMatchObject({
      compacted: true,
      removableLineCount: 1,
      blockedByCursorLineCount: 1,
      retainedLineCount: 2,
      cursorRewrites: [
        expect.objectContaining({
          nextCursor: { value: "0" },
          invalidatedUnreadEvents: false,
        }),
      ],
    });
    const remaining = await store.read();
    expect(remaining.events.map((item) => item.eventId)).toEqual([
      second.eventId,
      third.eventId,
    ]);
  });

  it("can force compaction and reports cursor invalidation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-compact-"));
    const store = new LocalFileRunEventStore({ rootDir });
    const cursors = new LocalFileRunEventDeliveryCursorStore({ rootDir });
    const first = event("run-a", RunEventType.ProgressUpdated, "progress-a");
    const second = event("run-a", RunEventType.ResultUpdated, "result-a");
    const third = event("run-a", RunEventType.Completed, "completed-a");
    await store.append([first, second, third]);
    await cursors.writeDeliveryCursor({
      consumerId: "consumer-a",
      cursor: { value: "1" },
    });

    const result = await store.compact({
      keepLatestEventsPerRun: 1,
      safetyMode: RunEventCompactionSafetyMode.Force,
    });

    expect(result).toMatchObject({
      compacted: true,
      removableLineCount: 2,
      blockedByCursorLineCount: 0,
      cursorRewrites: [
        expect.objectContaining({
          nextCursor: { value: "0" },
          invalidatedUnreadEvents: true,
        }),
      ],
    });
    const remaining = await store.read();
    expect(remaining.events.map((item) => item.eventId)).toEqual([third.eventId]);
  });

  it("can drop corrupt event log lines during explicit compaction", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-compact-"));
    const path = join(rootDir, "run-events", "events.ndjson");
    const store = new LocalFileRunEventStore({ rootDir, eventLogPath: path });
    const first = event("run-a", RunEventType.ProgressUpdated, "progress-a");
    const second = event("run-a", RunEventType.Completed, "completed-a");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, [
      JSON.stringify(first),
      "{broken",
      JSON.stringify(second),
      "",
    ].join("\n"));

    const result = await store.compact({ dropInvalidLines: true });

    expect(result).toMatchObject({
      compacted: true,
      invalidLineCount: 1,
      removableLineCount: 1,
      warnings: [expect.objectContaining({ code: "invalid_event_json" })],
    });
    const read = await store.read();
    expect(read.warnings).toEqual([]);
    expect(read.events.map((item) => item.eventId)).toEqual([
      first.eventId,
      second.eventId,
    ]);
  });
});

function event(
  runId: string,
  type: RunEventType,
  idempotencyPart: string,
  options: {
    readonly providerKind?: RunEventProviderKind;
    readonly registryRootDir?: string;
  } = {},
) {
  return makeRunEvent({
    runId,
    type,
    occurredAt: "2026-07-02T00:00:00.000Z",
    source: {
      providerKind: options.providerKind ?? RunEventProviderKind.Codex,
      ...(options.registryRootDir === undefined ? {} : {
        registryRootDir: options.registryRootDir,
      }),
    },
    payload: { idempotencyPart },
    idempotencyParts: [idempotencyPart],
  });
}

function snapshot(): RunObservationSnapshot {
  return {
    runId: "run-a",
    providerKind: RunEventProviderKind.Codex,
    observedAt: "2026-07-02T00:00:00.000Z",
    status: "running",
    liveness: "alive",
    result: { exists: false },
    warnings: [],
    readOnlyDecision: {
      kind: "keep_watching",
      reason: "worker_observable",
      safeMessage: "watch",
    },
  };
}

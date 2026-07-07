import { describe, expect, it } from "vitest";
import {
  RunEventProviderKind,
  RunEventType,
  makeRunEvent,
  type RunEvent,
  type RunEventAppendResult,
  type RunEventCursor,
  type RunEventDeliveryCursorStorePort,
  type RunEventPublisherPort,
  type RunEventReadRequest,
  type RunEventReadResult,
  type RunEventStorePort,
} from "@vioxen/subscription-runtime/worker-core";
import { relayRunEvents } from "../application/relay-run-events";

describe("relayRunEvents", () => {
  it("relays unread events through ports and advances the consumer cursor", async () => {
    const event = makeRunEvent({
      runId: "run-a",
      type: RunEventType.Completed,
      occurredAt: "2026-07-02T00:00:00.000Z",
      source: {
        providerKind: RunEventProviderKind.Codex,
      },
      idempotencyParts: ["completed"],
    });
    const nextCursor = { value: "line-2" };
    const eventStore = new MemoryEventStore({
      events: [event],
      nextCursor,
      warnings: [],
    });
    const cursorStore = new MemoryCursorStore({ value: "line-1" });
    const publisher = new CapturingPublisher();

    const result = await relayRunEvents(
      {
        consumerId: "consumer-a",
        limit: 10,
        runId: "run-a",
        types: [RunEventType.Completed],
      },
      {
        eventStore,
        cursorStore,
        publisher,
      },
    );

    expect(eventStore.readInput).toEqual({
      cursor: { value: "line-1" },
      limit: 10,
      runId: "run-a",
      types: [RunEventType.Completed],
    });
    expect(publisher.published).toEqual([event]);
    expect(cursorStore.written).toEqual({
      consumerId: "consumer-a",
      cursor: nextCursor,
    });
    expect(result).toEqual({
      consumerId: "consumer-a",
      readCount: 1,
      publishedCount: 1,
      nextCursor,
      warnings: [],
    });
  });
});

class MemoryEventStore implements RunEventStorePort {
  readInput: RunEventReadRequest | undefined = undefined;

  constructor(private readonly result: RunEventReadResult) {}

  async append(): Promise<RunEventAppendResult> {
    throw new Error("append is not used by relayRunEvents");
  }

  async read(input?: RunEventReadRequest): Promise<RunEventReadResult> {
    this.readInput = input;
    return this.result;
  }
}

class MemoryCursorStore implements RunEventDeliveryCursorStorePort {
  written?: {
    readonly consumerId: string;
    readonly cursor: RunEventCursor;
  };

  constructor(private readonly cursor: RunEventCursor | null) {}

  async readDeliveryCursor(): Promise<RunEventCursor | null> {
    return this.cursor;
  }

  async writeDeliveryCursor(input: {
    readonly consumerId: string;
    readonly cursor: RunEventCursor;
  }): Promise<void> {
    this.written = input;
  }
}

class CapturingPublisher implements RunEventPublisherPort {
  readonly published: RunEvent[] = [];

  async publish(events: readonly RunEvent[]): Promise<void> {
    this.published.push(...events);
  }
}

import { describe, expect, it } from "vitest";

import {
  RunEventProviderKind,
  RunEventType,
  makeRunEvent,
} from "@vioxen/subscription-runtime/worker-core";
import { StdoutNdjsonRunEventPublisher } from "../index";

describe("StdoutNdjsonRunEventPublisher", () => {
  it("writes one sanitized JSON event per line", async () => {
    const chunks: string[] = [];
    const publisher = new StdoutNdjsonRunEventPublisher({
      write: (chunk) => chunks.push(chunk),
    });
    const event = makeRunEvent({
      runId: "run-a",
      type: RunEventType.Completed,
      occurredAt: "2026-07-02T00:00:00.000Z",
      source: {
        providerKind: RunEventProviderKind.Codex,
      },
      payload: {
        token: "secret",
      },
    });

    await publisher.publish([event]);

    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0] ?? "{}")).toMatchObject({
      runId: "run-a",
      type: "run.completed",
      payload: {
        token: "<redacted>",
      },
    });
  });
});

import { describe, expect, it } from "vitest";

import { toUnixMilliseconds } from "@agent-teams-control-plane/shared";

import {
  calculateRetryDelayMs,
  calculateRetryDelayWithJitterMs,
  validateNewOutboxEvent,
} from "./outbox-event.js";

describe("outbox event domain", () => {
  it("validates content ref and integrity hash together", () => {
    expect(
      validateNewOutboxEvent({
        id: "event-1" as never,
        contentRefId: "content-1" as never,
        idempotencyKey: "workspace:event",
        maxAttempts: 3,
        nextAttemptAtMs: toUnixMilliseconds(0),
        payload: {},
        type: "test.event",
        version: 1,
      }),
    ).toMatchObject({
      code: "CONTROL_PLANE_OUTBOX_CONTENT_REFERENCE_INVALID",
    });
  });

  it("calculates bounded retry delays", () => {
    expect(calculateRetryDelayMs(1)).toBe(0);
    expect(calculateRetryDelayMs(2)).toBe(30_000);
    expect(calculateRetryDelayMs(3)).toBe(120_000);
    expect(calculateRetryDelayMs(4)).toBe(600_000);
    expect(calculateRetryDelayMs(5)).toBe(1_200_000);
    expect(calculateRetryDelayMs(6)).toBe(2_400_000);
    expect(calculateRetryDelayMs(10)).toBe(3_600_000);
  });

  it("adds retry jitter only after immediate retries", () => {
    expect(calculateRetryDelayWithJitterMs(1, 5000)).toBe(0);
    expect(calculateRetryDelayWithJitterMs(2, 1234.9)).toBe(31_234);
  });
});

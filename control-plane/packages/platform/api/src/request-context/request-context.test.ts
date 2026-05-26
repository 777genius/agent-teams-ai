import { describe, expect, it } from "vitest";

import { FixedClock } from "@agent-teams-control-plane/shared";

import {
  AsyncLocalRequestContextStore,
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  createRequestContext,
  getHeaderValue,
} from "./request-context.js";

describe("request context", () => {
  it("preserves safe incoming request and correlation ids", () => {
    const context = createRequestContext({
      clock: new FixedClock(new Date("2026-05-26T10:20:30.000Z")),
      headers: {
        [CORRELATION_ID_HEADER]: "correlation-1",
        [REQUEST_ID_HEADER]: "request-1",
      },
    });

    expect(context).toEqual({
      correlationId: "correlation-1",
      requestId: "request-1",
      startedAtMs: Date.parse("2026-05-26T10:20:30.000Z"),
    });
  });

  it("rejects unsafe incoming ids and generates replacements", () => {
    const context = createRequestContext({
      headers: {
        [CORRELATION_ID_HEADER]: "bad id with spaces",
        [REQUEST_ID_HEADER]: "bad\nid",
      },
    });

    expect(context.correlationId).not.toBe("bad id with spaces");
    expect(context.requestId).not.toBe("bad\nid");
  });

  it("uses the first safe header value when duplicate headers arrive", () => {
    expect(
      getHeaderValue(
        {
          [CORRELATION_ID_HEADER]: ["correlation-1", "correlation-2"],
        },
        CORRELATION_ID_HEADER,
      ),
    ).toBe("correlation-1");
  });

  it("keeps context scoped to async-local runs", () => {
    const store = new AsyncLocalRequestContextStore();
    const context = createRequestContext({
      headers: { [CORRELATION_ID_HEADER]: "correlation-1" },
    });

    expect(store.current()).toBeUndefined();
    store.run(context, () => {
      expect(store.current()).toEqual(context);
    });
    expect(store.current()).toBeUndefined();
  });
});

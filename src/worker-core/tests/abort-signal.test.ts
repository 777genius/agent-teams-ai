import { describe, expect, it } from "vitest";
import { combineAbortSignals } from "../index";

describe("combineAbortSignals", () => {
  it("propagates the first abort reason from multiple signals", () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = combineAbortSignals(first.signal, second.signal);

    const reason = { code: "runtime_controlled_interrupt" };
    second.abort(reason);

    expect(combined.signal.aborted).toBe(true);
    expect(combined.signal.reason).toBe(reason);
    combined.dispose();
  });

  it("stops propagation after dispose", () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = combineAbortSignals(first.signal, second.signal);

    combined.dispose();
    first.abort(new Error("too late"));

    expect(combined.signal.aborted).toBe(false);
  });

  it("reuses a single signal without wrapping it", () => {
    const controller = new AbortController();
    const combined = combineAbortSignals(controller.signal);

    expect(combined.signal).toBe(controller.signal);
  });
});

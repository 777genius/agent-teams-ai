import { describe, expect, it } from "vitest";

import { FixedClock, SystemClock, toIsoTimestamp, toUnixMilliseconds } from "./clock.js";

describe("Clock", () => {
  it("uses the system clock for current time", () => {
    const clock = new SystemClock();
    const before = Date.now();
    const now = clock.nowMs();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it("returns immutable fixed time snapshots", () => {
    const fixed = new FixedClock(new Date("2026-05-26T10:20:30.000Z"));
    const first = fixed.now();
    first.setUTCFullYear(2000);

    expect(fixed.now().toISOString()).toBe("2026-05-26T10:20:30.000Z");
    expect(fixed.nowMs()).toBe(Date.parse("2026-05-26T10:20:30.000Z"));
  });

  it("formats ISO timestamps and rejects invalid dates", () => {
    expect(toIsoTimestamp(new Date("2026-05-26T10:20:30.000Z"))).toBe(
      "2026-05-26T10:20:30.000Z",
    );
    expect(() => toIsoTimestamp(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("rejects non-integer unix millisecond values", () => {
    expect(toUnixMilliseconds(123)).toBe(123);
    expect(() => toUnixMilliseconds(1.2)).toThrow(RangeError);
  });
});

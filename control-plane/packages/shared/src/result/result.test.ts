import { describe, expect, it } from "vitest";

import { andThen, err, isErr, isOk, map, mapErr, ok, unwrapOr } from "./result.js";

describe("Result", () => {
  it("maps happy values without changing the error type", () => {
    const result = map(ok(2), (value) => value * 3);

    expect(result).toEqual(ok(6));
    expect(isOk(result)).toBe(true);
  });

  it("maps errors without touching successful values", () => {
    const result = mapErr(err("raw-error"), (error) => ({ code: error }));

    expect(result).toEqual(err({ code: "raw-error" }));
    expect(isErr(result)).toBe(true);
  });

  it("chains only when the previous step is successful", () => {
    const success = andThen(ok("workspace-1"), (value) => ok(value.length));
    const failure = andThen(err("missing"), () => ok(1));

    expect(success).toEqual(ok(11));
    expect(failure).toEqual(err("missing"));
  });

  it("unwraps success or computes a fallback from the error", () => {
    expect(unwrapOr(ok("ready"), "fallback")).toBe("ready");
    expect(unwrapOr(err("failed"), (error) => `fallback:${error}`)).toBe(
      "fallback:failed",
    );
  });
});

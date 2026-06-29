import { describe, expect, it } from "vitest";
import { parseCodexStructuredOutput } from "../structured-output";

describe("parseCodexStructuredOutput", () => {
  it("accepts direct JSON output", () => {
    expect(
      parseCodexStructuredOutput('{"verdict":"APPROVE"}', "invalid"),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("accepts fenced JSON output", () => {
    expect(
      parseCodexStructuredOutput(
        [
          "Review result:",
          "```json",
          '{"verdict":"APPROVE"}',
          "```",
        ].join("\n"),
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("accepts uppercase fenced JSON output", () => {
    expect(
      parseCodexStructuredOutput(
        [
          "Review result:",
          "```JSON",
          '{"verdict":"APPROVE"}',
          "```",
        ].join("\n"),
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("accepts fenced JSON output with a spaced language label", () => {
    expect(
      parseCodexStructuredOutput(
        [
          "Review result:",
          "``` json",
          '{"verdict":"APPROVE"}',
          "```",
        ].join("\n"),
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("uses the last valid fenced JSON candidate", () => {
    expect(
      parseCodexStructuredOutput(
        [
          "Example:",
          "```json",
          '{"verdict":"EXAMPLE"}',
          "```",
          "Final:",
          "```json",
          '{"verdict":"APPROVE"}',
          "```",
        ].join("\n"),
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("uses the last valid balanced JSON candidate in prefixed text", () => {
    expect(
      parseCodexStructuredOutput(
        'Use {"verdict":"EXAMPLE"} as the shape. Final: {"verdict":"APPROVE"}',
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("uses source order across object and array candidates", () => {
    expect(
      parseCodexStructuredOutput(
        'Options: ["APPROVE","REJECT"]. Final: {"verdict":"APPROVE"}',
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("does not let nested arrays override the containing final object", () => {
    expect(
      parseCodexStructuredOutput(
        'Final: {"verdict":"APPROVE","reasons":["tested","scoped"]}',
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE", reasons: ["tested", "scoped"] });
  });

  it("does not let balanced JSON inside a fence override the fenced result", () => {
    expect(
      parseCodexStructuredOutput(
        [
          "```json",
          '{"verdict":"APPROVE","reasons":["tested","scoped"]}',
          "```",
        ].join("\n"),
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE", reasons: ["tested", "scoped"] });
  });

  it("uses later inline JSON over earlier fenced examples", () => {
    expect(
      parseCodexStructuredOutput(
        [
          "Example:",
          "```json",
          '{"verdict":"EXAMPLE"}',
          "```",
          'Final: {"verdict":"APPROVE"}',
        ].join("\n"),
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("does not let JSON inside later non-json code fences override the final answer", () => {
    expect(
      parseCodexStructuredOutput(
        [
          'Final: {"verdict":"APPROVE"}',
          "```ts",
          'const example = {"verdict":"EXAMPLE"};',
          "```",
        ].join("\n"),
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("ignores JSON-looking content inside explicit non-json code fences", () => {
    expect(() =>
      parseCodexStructuredOutput(
        [
          "```ts",
          'const example = {"verdict":"EXAMPLE"};',
          "```",
        ].join("\n"),
        "custom_invalid",
      ),
    ).toThrow("custom_invalid");
  });

  it("does not scan JSON inside unclosed explicit non-json code fences", () => {
    expect(
      parseCodexStructuredOutput(
        [
          'Final: {"verdict":"APPROVE"}',
          "```ts",
          'const example = {"verdict":"EXAMPLE"};',
        ].join("\n"),
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("does not scan JSON inside tilde non-json code fences", () => {
    expect(
      parseCodexStructuredOutput(
        [
          'Final: {"verdict":"APPROVE"}',
          "~~~ts",
          'const example = {"verdict":"EXAMPLE"};',
          "~~~",
        ].join("\n"),
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("keeps scanning after an unclosed earlier JSON-looking fragment", () => {
    expect(
      parseCodexStructuredOutput(
        'Draft fragment: {not finished. Final: {"verdict":"APPROVE"}',
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("keeps scanning after mismatched JSON-looking brackets", () => {
    expect(
      parseCodexStructuredOutput(
        'Draft fragment: [not finished}. Final: {"verdict":"APPROVE"}',
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("keeps scanning after unmatched prose quotes before JSON", () => {
    expect(
      parseCodexStructuredOutput(
        'Draft says "not JSON yet. Final: {"verdict":"APPROVE"}',
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("keeps scanning after a broken JSON string before final JSON", () => {
    expect(
      parseCodexStructuredOutput(
        'Draft fragment: {"bad":"unfinished\nFinal: {"verdict":"APPROVE"}',
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE" });
  });

  it("keeps the latest outer candidate when many candidates are present", () => {
    const examples = Array.from(
      { length: 500 },
      (_, index) => `Example ${index}: {"verdict":"EXAMPLE_${index}"}`,
    ).join("\n");

    expect(
      parseCodexStructuredOutput(
        `${examples}\nFinal: {"verdict":"APPROVE","reasons":["tested"]}`,
        "invalid",
      ),
    ).toEqual({ verdict: "APPROVE", reasons: ["tested"] });
  });

  it("throws the caller provided error code when no JSON can be parsed", () => {
    expect(() => parseCodexStructuredOutput("not json", "custom_invalid")).toThrow(
      "custom_invalid",
    );
  });
});

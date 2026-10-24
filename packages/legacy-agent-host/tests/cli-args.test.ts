import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCliArgs,
  extractUserFlags,
  PROTECTED_CLI_FLAGS,
} from "../dist/team-launch/cliArgs.js";

test("canonical Desktop tokenizer retains quoted empties, order, repeats and literal shell tokens", () => {
  assert.deepEqual(
    parseCliArgs(
      "--max-turns 5 --json-schema \"\" --max-turns=7 --betas 'one two' three",
    ),
    [
      "--max-turns",
      "5",
      "--json-schema",
      "",
      "--max-turns=7",
      "--betas",
      "one two",
      "three",
    ],
  );
  assert.deepEqual(parseCliArgs('--json-schema "$(literal)"'), [
    "--json-schema",
    "$(literal)",
  ]);
  assert.deepEqual(parseCliArgs('--json-schema "unfinished'), [
    "--json-schema",
    "unfinished",
  ]);
  assert.deepEqual(extractUserFlags("--mcp-config=/FOREIGN -p --model=x"), [
    "--mcp-config",
    "-p",
    "--model",
  ]);
  assert.equal(PROTECTED_CLI_FLAGS.has("--mcp-config"), true);
});

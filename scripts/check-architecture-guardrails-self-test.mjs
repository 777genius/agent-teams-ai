#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const checkerPath = join(scriptDir, "check-architecture-guardrails.mjs");

const cases = [
  {
    name: "small source file passes",
    files: {
      "src/worker-codex/codex-goal-mcp-small-tools.ts":
        "import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nexport function register(server: McpServer) { return server; }\n",
    },
    expectPass: true,
  },
  {
    name: "new source file over cap fails",
    files: {
      "src/worker-codex/tests/new-giant.test.ts": Array.from({ length: 1001 }, (_, index) => `// ${index}`).join("\n") + "\n",
    },
    expectPass: false,
    expectText: "exceeds hard cap",
  },
  {
    name: "MCP tool rejects new restricted implementation import",
    files: {
      "src/worker-codex/codex-goal-mcp-bad-tools.ts": "import './codex-goal-ops';\n",
    },
    expectPass: false,
    expectText: "restricted implementation module",
  },
  {
    name: "MCP tool rejects domain decision literals",
    files: {
      "src/worker-codex/codex-goal-mcp-bad-tools.ts": "export const result = { reason: 'direct_run_not_supported' };\n",
    },
    expectPass: false,
    expectText: "domain decision literal",
  },
];

for (const testCase of cases) {
  const fixtureDir = await mkdtemp(
    join(tmpdir(), "subscription-runtime-guardrails-"),
  );
  try {
    for (const [relativePath, content] of Object.entries(testCase.files)) {
      const fullPath = join(fixtureDir, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
    }
    const result = spawnSync(process.execPath, [checkerPath], {
      cwd: fixtureDir,
      env: {
        ...process.env,
        SUBSCRIPTION_RUNTIME_GUARDRAIL_ROOT_DIR: fixtureDir,
      },
      encoding: "utf8",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const passed = result.status === 0;
    if (passed !== testCase.expectPass) {
      throw new Error(
        `${testCase.name}: expected pass=${testCase.expectPass}, got pass=${passed}\n${output}`,
      );
    }
    if (testCase.expectText && !output.includes(testCase.expectText)) {
      throw new Error(
        `${testCase.name}: expected output to contain ${JSON.stringify(testCase.expectText)}\n${output}`,
      );
    }
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

console.log("Architecture guardrail self-tests OK.");

#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const rootDir = process.env.SUBSCRIPTION_RUNTIME_GUARDRAIL_ROOT_DIR
  ? resolve(process.env.SUBSCRIPTION_RUNTIME_GUARDRAIL_ROOT_DIR)
  : new URL("..", import.meta.url).pathname;
const srcDir = process.env.SUBSCRIPTION_RUNTIME_GUARDRAIL_SRC_DIR
  ? resolve(process.env.SUBSCRIPTION_RUNTIME_GUARDRAIL_SRC_DIR)
  : join(rootDir, "src");
const maxLines = Number(process.env.SUBSCRIPTION_RUNTIME_FILE_MAX_LINES ?? 1000);

const legacyLineCaps = {
  "src/agent-task/task-codec/application/agent-task-codec.ts": 1013,
  "src/core/application/runtime.ts": 1158,
  "src/provider-claude/tests/claude-provider.test.ts": 1254,
  "src/provider-codex/codex-app-server-execution-engine.ts": 2405,
  "src/provider-codex/tests/codex-provider.test.ts": 4345,
  "src/worker-claude/file-backend-claude-worker.ts": 1354,
  "src/worker-claude/tests/file-backend-claude-worker.test.ts": 2260,
  "src/worker-codex/codex-goal-cli.ts": 1128,
  "src/worker-codex/codex-goal-ops.ts": 1847,
  "src/worker-codex/file-backend-codex-worker.ts": 1892,
  "src/worker-codex/tests/codex-goal-cli.test.ts": 1145,
  "src/worker-codex/tests/codex-goal-mcp.test.ts": 6272,
  "src/worker-codex/tests/codex-goal-ops.test.ts": 1526,
  "src/worker-codex/tests/file-backend-codex-worker.test.ts": 2844,
  "src/worker-core/run-events.ts": 1825,
  "src/worker-core/safe-execution.ts": 2099,
  "src/worker-core/tests/safe-execution.test.ts": 1892,
  "src/worker-core/worker-pool.ts": 1003,
  "src/worker-local/tests/agent-task-runner-cli.test.ts": 1027,
};

const allowedMcpRestrictedImports = {};
const allowedApplicationMcpImports = {};

const staticImportPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g;
const dynamicImportPattern = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
const requirePattern = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
const forbiddenMcpDecisionLiteralPattern =
  /(?:reason|kind|action)\s*:\s*["'][^"']*(?:_not_supported|unsafe_state_mismatch|_reconciled|reconcile)[^"']*["']/g;

const violations = [];
for (const file of await listFiles(srcDir)) {
  if (!/\.(?:ts|tsx|mts|cts)$/.test(file)) continue;
  const rel = relative(rootDir, file).replaceAll("\\", "/");
  const text = await readFile(file, "utf8");
  checkLineBudget(rel, text);
  checkApplicationImports(rel, text);
  if (isMcpToolFile(rel) || rel === "src/worker-codex/codex-goal-mcp.ts") {
    checkMcpFacade(rel, text);
  }
}

if (violations.length > 0) {
  console.error("Architecture guardrail violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Architecture guardrails OK.");

function checkLineBudget(rel, text) {
  const lines = (text.match(/\n/g) ?? []).length;
  const legacyCap = legacyLineCaps[rel];
  if (legacyCap !== undefined) {
    if (lines > legacyCap) {
      violations.push(
        `${rel}: legacy file grew to ${lines} lines; cap is ${legacyCap}. Split before adding more.`,
      );
    }
    return;
  }
  if (lines > maxLines) {
    violations.push(`${rel}: ${lines} lines exceeds hard cap ${maxLines}`);
  }
}

function checkMcpFacade(rel, text) {
  const allowed = new Set(allowedMcpRestrictedImports[rel] ?? []);
  for (const specifier of extractImports(text)) {
    if (isRestrictedMcpImport(specifier) && !allowed.has(specifier)) {
      violations.push(
        `${rel}: MCP facade imports restricted implementation module ${specifier}`,
      );
    }
  }
  for (const match of text.matchAll(forbiddenMcpDecisionLiteralPattern)) {
    violations.push(
      `${rel}: MCP facade contains domain decision literal ${JSON.stringify(match[0])}`,
    );
  }
}

function checkApplicationImports(rel, text) {
  if (!/^src\/worker-codex\/application\/.+\.ts$/.test(rel)) return;
  const allowed = new Set(allowedApplicationMcpImports[rel] ?? []);
  for (const specifier of extractImports(text)) {
    if (isWorkerCodexMcpImport(specifier) && !allowed.has(specifier)) {
      violations.push(
        `${rel}: application layer imports MCP-facing module ${specifier}`,
      );
    }
  }
}

function isMcpToolFile(rel) {
  return /^src\/worker-codex\/codex-goal-mcp-.+tools\.ts$/.test(rel);
}

function isRestrictedMcpImport(specifier) {
  return /^@vioxen\/subscription-runtime\/(?:store-|worker-core)/.test(specifier) ||
    /^\.\/codex-goal-ops$/.test(specifier) ||
    /^\.\/codex-goal-mcp-decision$/.test(specifier) ||
    /^\.\/codex-goal-mcp-job-lifecycle$/.test(specifier) ||
    /^\.\/codex-goal-mcp-observation-projection$/.test(specifier);
}

function isWorkerCodexMcpImport(specifier) {
  return /^\.\.\/codex-goal-mcp(?:-|$)/.test(specifier) ||
    /^\.\/codex-goal-mcp(?:-|$)/.test(specifier);
}

function extractImports(text) {
  return [
    ...[...text.matchAll(staticImportPattern)].map((match) => match[1]),
    ...[...text.matchAll(dynamicImportPattern)].map((match) => match[1]),
    ...[...text.matchAll(requirePattern)].map((match) => match[1]),
  ];
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(fullPath)));
    else files.push(fullPath);
  }
  return files;
}

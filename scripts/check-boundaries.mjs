#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const rootDir = process.env.SUBSCRIPTION_RUNTIME_BOUNDARY_ROOT_DIR
  ? resolve(process.env.SUBSCRIPTION_RUNTIME_BOUNDARY_ROOT_DIR)
  : new URL("..", import.meta.url).pathname;
const srcDir = process.env.SUBSCRIPTION_RUNTIME_BOUNDARY_SRC_DIR
  ? resolve(process.env.SUBSCRIPTION_RUNTIME_BOUNDARY_SRC_DIR)
  : join(rootDir, "src");

const packageJson = JSON.parse(
  await readFile(join(rootDir, "package.json"), "utf8"),
);
if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
  throw new Error("package.json name is required for boundary checks");
}

const currentPackageName = packageJson.name;
const legacyPackageNames = parseLegacyPackageNames(
  process.env.SUBSCRIPTION_RUNTIME_LEGACY_PACKAGE_NAMES,
);
const runtimePackageNames = [currentPackageName, ...legacyPackageNames];
const runtimePackagePattern = runtimePackageNames.map(escapeRegExp).join("|");

function runtimeSubpathPattern(subpathPattern) {
  return new RegExp(`^(?:${runtimePackagePattern})/${subpathPattern}`);
}

function internalPathPattern(subpathPattern) {
  return new RegExp(`(?:^|/)${subpathPattern}`);
}

const forbidden = [
  {
    from: /^src\/core\//,
    imports: [
      runtimeSubpathPattern("(?:provider-|worker-|queue-|store-|runner-)"),
      internalPathPattern("(?:provider-|worker-|queue-|store-|runner-)"),
      /bullmq/,
      /codex/i,
      /claude/i,
      /github/i,
    ],
    message: "core must stay provider and adapter neutral",
  },
  {
    from: /^src\/agent-task\//,
    imports: [
      runtimeSubpathPattern("(?:provider-|worker-|queue-|store-|runner-)"),
      internalPathPattern("(?:provider-|worker-|queue-|store-|runner-)"),
      /bullmq/,
      /claude/i,
      /codex/i,
      /github/i,
    ],
    message: "agent-task must stay provider and adapter neutral",
  },
  {
    from: /^src\/account-diagnostics\//,
    imports: [
      runtimeSubpathPattern(
        "(?:provider-|worker-(?:codex|claude)|queue-|store-|runner-)",
      ),
      internalPathPattern(
        "(?:provider-|worker-(?:codex|claude)|queue-|store-|runner-)",
      ),
      /bullmq/,
      /claude/i,
      /codex/i,
      /github/i,
    ],
    message:
      "account-diagnostics must stay provider-neutral and depend only on neutral ports",
  },
  {
    from: /^src\/provider-codex\//,
    imports: [
      runtimeSubpathPattern("provider-claude"),
      runtimeSubpathPattern("(?:worker-|queue-|store-|runner-)"),
      internalPathPattern("(?:provider-claude|worker-|queue-|store-|runner-)"),
      /claude/i,
    ],
    message:
      "provider-codex must not depend on Claude, workers, queues, stores, or runners",
  },
  {
    from: /^src\/provider-claude\//,
    imports: [
      runtimeSubpathPattern("provider-codex"),
      runtimeSubpathPattern("(?:worker-|queue-|store-|runner-)"),
      internalPathPattern("(?:provider-codex|worker-|queue-|store-|runner-)"),
      /codex/i,
    ],
    message:
      "provider-claude must not depend on Codex, workers, queues, stores, or runners",
  },
  {
    from: /^src\/worker-core\/(?:run-events|run-observability|run-provider-kind)\.ts$/,
    imports: [
      /^node:fs(?:\/promises)?$/,
      /(?:^|\/)(?:provider-|worker-(?:codex|claude)|queue-|store-|runner-)/,
      /bullmq/,
      /temporal/i,
      /jetstream/i,
      /redis/i,
      /webhook/i,
    ],
    message:
      "worker-core event kernel must not depend on file system, transports, providers, queues, stores, or orchestrators",
  },
  {
    from: /^src\/worker-core\/(?!.*\/tests\/)/,
    imports: [
      /^node:fs(?:\/promises)?$/,
      /^node:child_process$/,
    ],
    message:
      "worker-core production must use ports/adapters for file system and process details",
  },
  {
    from: /^src\/worker-core\//,
    imports: [
      runtimeSubpathPattern(
        "(?:provider-|worker-(?:codex|claude)|queue-|store-|runner-)",
      ),
      internalPathPattern(
        "(?:provider-|worker-(?:codex|claude)|queue-|store-|runner-)",
      ),
      /bullmq/,
      /claude/i,
      /codex/i,
      /github/i,
    ],
    message: "worker-core must stay provider and adapter neutral",
  },
  {
    from: /^src\/orchestrator-core\//,
    imports: [
      /^node:fs(?:\/promises)?$/,
      runtimeSubpathPattern("(?:provider-|worker-(?:codex|claude)|store-|runner-)"),
      internalPathPattern("(?:provider-|worker-(?:codex|claude)|store-|runner-)"),
      /bullmq/,
      /temporal/i,
      /jetstream/i,
      /redis/i,
      /webhook/i,
      /progress\.json/i,
      /latest-result\.json/i,
    ],
    message:
      "orchestrator-core must consume runtime ports/read-models, not files, transports, providers, or stores",
  },
  {
    from: /^src\/worker-codex\//,
    imports: [
      runtimeSubpathPattern("(?:provider-claude|worker-claude|queue-)"),
      internalPathPattern("(?:provider-claude|worker-claude|queue-)"),
      /bullmq/,
      /claude/i,
    ],
    message:
      "worker-codex must not depend on Claude or queue implementations",
  },
  {
    from: /^src\/worker-claude\//,
    imports: [
      runtimeSubpathPattern("(?:provider-codex|worker-codex|queue-)"),
      internalPathPattern("(?:provider-codex|worker-codex|queue-)"),
      /bullmq/,
      /codex/i,
    ],
    message:
      "worker-claude must not depend on Codex or queue implementations",
  },
  {
    from: /^src\/queue-core\//,
    imports: [
      /bullmq/,
      /bull\b/,
      runtimeSubpathPattern(
        "(?:provider-|worker-(?:codex|claude)|queue-bullmq|store-|runner-)",
      ),
      internalPathPattern(
        "(?:provider-|worker-(?:codex|claude)|queue-bullmq|store-|runner-)",
      ),
    ],
    message: "queue-core must stay queue and provider implementation neutral",
  },
  {
    from: /^src\/runner-github-action\//,
    imports: [
      runtimeSubpathPattern("(?:provider-|worker-|queue-|store-)"),
      internalPathPattern("(?:provider-|worker-|queue-|store-)"),
      /bullmq/,
      /claude/i,
      /codex/i,
    ],
    message:
      "runner-github-action must not depend on providers, workers, queues, or stores",
  },
  {
    from: /^src\/store-local-file\//,
    imports: [
      runtimeSubpathPattern("(?:provider-|queue-)"),
      internalPathPattern("(?:provider-|queue-)"),
      /provider-/,
      /codex/i,
      /claude/i,
      /bullmq/,
    ],
    message: "store-local-file must not know providers or queues",
  },
  {
    from: /^src\/store-github-actions-secret\//,
    imports: [
      runtimeSubpathPattern("(?:provider-|queue-)"),
      internalPathPattern("(?:provider-|queue-)"),
      /provider-/,
      /codex/i,
      /claude/i,
      /bullmq/,
    ],
    message: "store-github-actions-secret must not know providers or queues",
  },
];

const staticImportPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g;
const dynamicImportPattern = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
const requirePattern = /require\s*\(\s*["']([^"']+)["']\s*\)/g;

const violations = [];
for (const file of await listFiles(srcDir)) {
  if (!file.endsWith(".ts")) continue;
  const rel = relative(rootDir, file).replaceAll("\\", "/");
  const text = await readFile(file, "utf8");
  if (text.includes("@reviewrouter/")) {
    violations.push(`${rel}: runtime package must not import @reviewrouter/*`);
  }
  const imports = extractImports(text);
  for (const specifier of imports) {
    if (
      legacyPackageNames.some(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      )
    ) {
      violations.push(
        `${rel}: runtime package must not import legacy package scope: ${specifier}`,
      );
    }
  }
  for (const rule of forbidden) {
    if (!rule.from.test(rel)) continue;
    for (const specifier of imports) {
      if (rule.imports.some((pattern) => pattern.test(specifier))) {
        violations.push(`${rel}: ${rule.message}: ${specifier}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Architecture boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Architecture boundaries OK.");

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLegacyPackageNames(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

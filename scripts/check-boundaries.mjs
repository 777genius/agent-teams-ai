#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const rootDir = new URL("..", import.meta.url).pathname;
const srcDir = join(rootDir, "src");

const forbidden = [
  {
    from: /^src\/core\//,
    imports: [
      /@777genius\/subscription-runtime\/provider-/,
      /@777genius\/subscription-runtime\/worker-/,
      /@777genius\/subscription-runtime\/queue-/,
      /@777genius\/subscription-runtime\/store-/,
      /@777genius\/subscription-runtime\/runner-/,
      /bullmq/,
      /codex/i,
      /github/i,
    ],
    message: "core must stay provider and adapter neutral",
  },
  {
    from: /^src\/provider-codex\//,
    imports: [
      /@777genius\/subscription-runtime\/worker-/,
      /@777genius\/subscription-runtime\/queue-/,
      /@777genius\/subscription-runtime\/store-/,
    ],
    message: "provider-codex must not depend on workers, queues, or stores",
  },
  {
    from: /^src\/provider-claude\//,
    imports: [
      /@777genius\/subscription-runtime\/provider-codex/,
      /@777genius\/subscription-runtime\/worker-/,
      /@777genius\/subscription-runtime\/queue-/,
      /@777genius\/subscription-runtime\/store-/,
    ],
    message:
      "provider-claude must not depend on Codex, workers, queues, or stores",
  },
  {
    from: /^src\/queue-core\//,
    imports: [/bullmq/, /bull\b/, /@777genius\/subscription-runtime\/queue-bullmq/],
    message: "queue-core must stay queue implementation neutral",
  },
  {
    from: /^src\/store-local-file\//,
    imports: [/provider-codex/, /codex/i, /bullmq/],
    message: "store-local-file must not know providers or queues",
  },
  {
    from: /^src\/store-github-actions-secret\//,
    imports: [/provider-codex/, /codex/i, /bullmq/],
    message: "store-github-actions-secret must not know providers or queues",
  },
];

const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g;

const violations = [];
for (const file of await listFiles(srcDir)) {
  if (!file.endsWith(".ts")) continue;
  const rel = relative(rootDir, file).replaceAll("\\", "/");
  const text = await readFile(file, "utf8");
  if (text.includes("@reviewrouter/")) {
    violations.push(`${rel}: runtime package must not import @reviewrouter/*`);
  }
  const imports = [...text.matchAll(importPattern)].map((match) => match[1]);
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

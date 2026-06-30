#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const checkerPath = join(scriptDir, "check-boundaries.mjs");

const cases = [
  {
    name: "current package scope violation",
    files: {
      "src/core/bad.ts": "import '@vioxen/subscription-runtime/provider-claude';\n",
    },
    expectPass: false,
    expectText: "core must stay provider and adapter neutral",
  },
  {
    name: "relative provider violation",
    files: {
      "src/core/bad.ts": "import '../provider-claude';\n",
    },
    expectPass: false,
    expectText: "core must stay provider and adapter neutral",
  },
  {
    name: "legacy package scope violation",
    files: {
      "src/provider-claude/bad.ts": "import '@777genius/subscription-runtime/core';\n",
    },
    expectPass: false,
    expectText: "legacy package scope",
  },
  {
    name: "allowed core import",
    files: {
      "src/provider-claude/good.ts": "import type { ProviderFailure } from '@vioxen/subscription-runtime/core';\n",
    },
    expectPass: true,
  },
  {
    name: "worker-core rejects provider implementations",
    files: {
      "src/worker-core/bad.ts": "import '@vioxen/subscription-runtime/provider-codex';\n",
    },
    expectPass: false,
    expectText: "worker-core must stay provider and adapter neutral",
  },
  {
    name: "agent-task rejects provider implementations",
    files: {
      "src/agent-task/bad.ts": "import '@vioxen/subscription-runtime/provider-claude';\n",
    },
    expectPass: false,
    expectText: "agent-task must stay provider and adapter neutral",
  },
  {
    name: "agent-task rejects dynamic provider imports",
    files: {
      "src/agent-task/bad.ts": "await import('@vioxen/subscription-runtime/provider-claude');\n",
    },
    expectPass: false,
    expectText: "agent-task must stay provider and adapter neutral",
  },
  {
    name: "account diagnostics allows worker-core capacity types",
    files: {
      "src/account-diagnostics/good.ts": "import type { WorkerAccountCapacityStore } from '@vioxen/subscription-runtime/worker-core';\n",
    },
    expectPass: true,
  },
  {
    name: "account diagnostics rejects concrete provider imports",
    files: {
      "src/account-diagnostics/bad.ts": "import '@vioxen/subscription-runtime/provider-codex';\n",
    },
    expectPass: false,
    expectText:
      "account-diagnostics must stay provider-neutral and depend only on neutral ports",
  },
  {
    name: "queue-core allows worker-core types",
    files: {
      "src/queue-core/good.ts": "import type { BoundedSubscriptionWorkerPool } from '@vioxen/subscription-runtime/worker-core';\n",
    },
    expectPass: true,
  },
  {
    name: "queue-core rejects concrete workers",
    files: {
      "src/queue-core/bad.ts": "import '@vioxen/subscription-runtime/worker-claude';\n",
    },
    expectPass: false,
    expectText: "queue-core must stay queue and provider implementation neutral",
  },
  {
    name: "claude worker rejects codex implementation",
    files: {
      "src/worker-claude/bad.ts": "import '@vioxen/subscription-runtime/provider-codex';\n",
    },
    expectPass: false,
    expectText:
      "worker-claude must not depend on Codex or queue implementations",
  },
];

for (const testCase of cases) {
  const fixtureDir = await mkdtemp(
    join(tmpdir(), "subscription-runtime-boundaries-"),
  );
  try {
    await writeFile(
      join(fixtureDir, "package.json"),
      JSON.stringify({ name: "@vioxen/subscription-runtime" }),
    );
    for (const [relativePath, content] of Object.entries(testCase.files)) {
      const fullPath = join(fixtureDir, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
    }

    const result = spawnSync(process.execPath, [checkerPath], {
      cwd: fixtureDir,
      env: {
        ...process.env,
        SUBSCRIPTION_RUNTIME_BOUNDARY_ROOT_DIR: fixtureDir,
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

console.log("Architecture boundary self-tests OK.");

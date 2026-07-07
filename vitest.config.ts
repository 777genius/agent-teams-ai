import { defineConfig } from "vitest/config";

const alias = {
  "@vioxen/subscription-runtime/core": "/src/core/index.ts",
  "@vioxen/subscription-runtime/agent-task": "/src/agent-task/index.ts",
  "@vioxen/subscription-runtime/account-diagnostics":
    "/src/account-diagnostics/index.ts",
  "@vioxen/subscription-runtime/provider-codex":
    "/src/provider-codex/index.ts",
  "@vioxen/subscription-runtime/provider-claude":
    "/src/provider-claude/index.ts",
  "@vioxen/subscription-runtime/worker-core": "/src/worker-core/index.ts",
  "@vioxen/subscription-runtime/worker-codex": "/src/worker-codex/index.ts",
  "@vioxen/subscription-runtime/worker-claude": "/src/worker-claude/index.ts",
  "@vioxen/subscription-runtime/worker-local": "/src/worker-local/index.ts",
  "@vioxen/subscription-runtime/queue-core": "/src/queue-core/index.ts",
  "@vioxen/subscription-runtime/queue-bullmq": "/src/queue-bullmq/index.ts",
  "@vioxen/subscription-runtime/store-local-file":
    "/src/store-local-file/index.ts",
  "@vioxen/subscription-runtime/store-github-actions-secret":
    "/src/store-github-actions-secret/index.ts",
  "@vioxen/subscription-runtime/runner-github-action":
    "/src/runner-github-action/index.ts",
  "@vioxen/subscription-runtime/testing": "/src/testing/index.ts",
  "@vioxen/subscription-runtime/testing/contracts":
    "/src/testing/contracts.ts",
  "@vioxen/subscription-runtime/testing/fakes": "/src/testing/fakes.ts",
};

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    globals: true,
    testTimeout: 60_000,
  },
  resolve: {
    alias,
  },
});

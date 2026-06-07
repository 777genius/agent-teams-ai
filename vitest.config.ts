import { defineConfig } from "vitest/config";

const alias = {
  "@vioxen/subscription-runtime/core": "/src/core/index.ts",
  "@vioxen/subscription-runtime/provider-codex":
    "/src/provider-codex/index.ts",
  "@vioxen/subscription-runtime/worker-core": "/src/worker-core/index.ts",
  "@vioxen/subscription-runtime/worker-codex": "/src/worker-codex/index.ts",
  "@vioxen/subscription-runtime/queue-core": "/src/queue-core/index.ts",
  "@vioxen/subscription-runtime/queue-bullmq": "/src/queue-bullmq/index.ts",
  "@vioxen/subscription-runtime/store-local-file":
    "/src/store-local-file/index.ts",
  "@vioxen/subscription-runtime/store-github-actions-secret":
    "/src/store-github-actions-secret/index.ts",
  "@vioxen/subscription-runtime/runner-github-action":
    "/src/runner-github-action/index.ts",
  "@vioxen/subscription-runtime/testing": "/src/testing/index.ts",
};

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: true,
  },
  resolve: {
    alias,
  },
});

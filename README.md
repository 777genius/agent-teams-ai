# Subscription Runtime

Provider-neutral runtime for running subscription-backed AI workers without binding
host applications to a specific agent implementation.

Install the current GitHub version:

```json
{
  "dependencies": {
    "@777genius/subscription-runtime": "github:777genius/subscription-runtime#main"
  }
}
```

Use subpath exports:

```ts
import { createSubscriptionRuntime } from "@777genius/subscription-runtime/core";
import { FileBackendCodexWorker } from "@777genius/subscription-runtime/worker-codex";
import { createLocalFileBackendRuntimeAdapters } from "@777genius/subscription-runtime/store-local-file";
```

## Modules

- `core` - provider-neutral ports, policy, state machines and redaction.
- `provider-codex` - Codex session refresh and execution adapters.
- `worker-core` - bounded worker pool contracts.
- `worker-codex` - file-backed Codex worker assembly.
- `queue-core` - host-neutral queue contracts.
- `queue-bullmq` - BullMQ-compatible queue adapter.
- `store-local-file` - encrypted local file session and lease stores.
- `store-github-actions-secret` - no-plaintext GitHub Actions secret store.
- `runner-github-action` - GitHub Actions runtime adapter.

## Backend Codex Worker

```ts
import { BoundedSubscriptionWorkerPool } from "@777genius/subscription-runtime/worker-core";
import { FileBackendCodexWorker } from "@777genius/subscription-runtime/worker-codex";

const pool = new BoundedSubscriptionWorkerPool({
  poolId: "codex-workers",
  slots: 4,
  prewarmOnStart: true,
  createWorker: (index) =>
    new FileBackendCodexWorker({
      workerId: `codex-${index}`,
      providerInstanceId: "codex-main",
      stateRootDir: "/var/lib/subscription-runtime",
      codexBinaryPath: "/usr/local/bin/codex",
      encryptionKey: process.env.SUBSCRIPTION_RUNTIME_FILE_KEY!,
      model: "gpt-5.5",
      reasoningEffort: "low",
    }),
});

await pool.start();
const result = await pool.run({
  prompt: "Return a compact JSON rating for player A.",
  outputSchemaName: "match-rating-json",
});
```

For a complete HTTP + BullMQ service, see
[`777genius/subscription-runtime-demo`](https://github.com/777genius/subscription-runtime-demo).

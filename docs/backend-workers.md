# Backend Workers

Backend services should keep queues and HTTP framework choices outside the
runtime package. The runtime provides worker pools and provider execution; host
apps decide whether to use BullMQ, Nest queues, direct calls, or another queue.

Recommended first deployment shape:

- one persistent volume for `/var/lib/subscription-runtime`;
- one encrypted file key in env;
- one Redis-backed queue;
- N Codex worker slots with prewarm enabled;
- async job API plus optional sync wait endpoint.

Run account diagnostics before scheduling large batches:

```bash
subscription-runtime-account-status --provider all --json
```

The command reads cached `WorkerAccountCapacityStore` state by default and only
runs provider probes when `--probe` is passed. Use this for relogin alerts,
limit reset visibility and duplicate account-slot detection. See
`docs/account-diagnostics.md`.

Claude Code workers use the same backend-worker shape through
`FileBackendClaudeWorker`. The worker exposes capacity snapshots, rate-limit
telemetry, control-inbox continuation and logical thread handoff. See
`docs/claude-worker-pool-rfc.md` for the original design background; the
`worker-claude` public subpath and source are the current API reference.

For an operational Codex worker-pool runbook, including native `/goal`,
account-slot login, worktree isolation, monitoring commands and restart policy,
see `docs/codex-worker-pool-operations.md`.

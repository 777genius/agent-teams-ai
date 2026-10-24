Run on a disposable Linux runner with the repository's pinned dependencies, Node 24+ and Xvfb:

```sh
xvfb-run -a node scripts/e2e/opencode-status-recovery/run.mts green /absolute/evidence/green
xvfb-run -a node scripts/e2e/opencode-status-recovery/run.mts persistent /absolute/evidence/persistent
```

The harness uses `pnpm dev:mcp`, real Electron preload IPC and controlled CLI subprocess responses. It creates a new project, HOME and user-data directory, checks CDP process ownership, and stops only its own process group. It never clicks Create or executes an agent/model. Readiness responses are fixtures; this verifies desktop recovery, not live provider inference.

`green` reproduces both warnings from the reported Create Team screen, loads a fresh OpenRouter catalog, and verifies one automatic project-status retry, model selection for OpenRouter, Zen and Agentrouter, and enabled Create after independent readiness succeeds. `persistent` verifies another failed status check keeps Create blocked across fresh source catalogs without an automatic retry loop.

`red` is for the same harness on the pre-fix production files: fresh OpenRouter models load, but OpenCode remains blocked and no recovery status request occurs. Each run requires a new evidence directory and writes subprocess calls, screenshots, text, cleanup proof and a JSON result. Success is published only after owned process cleanup completes; cleanup failures are recorded as failed evidence. The harness is typechecked by `pnpm typecheck`.

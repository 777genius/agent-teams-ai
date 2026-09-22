# Paperclip agent launch research

Research date: 2026-05-07

This note records factual findings only. It is not an implementation plan and does not make recommendations.

## Scope

Compared Paperclip agent launch/runtime behavior with the local Agent Teams orchestrator.

Local orchestrator inspected:

- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/tools/shared/spawnMultiAgent.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/teamBootstrap/teamBootstrapRunner.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/utils/swarm/processBackend.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/utils/swarm/teammateRuntimeEvents.ts`

Paperclip inspected from GitHub and a shallow local clone at `/tmp/paperclip-inspect`.

## Paperclip runtime model

Paperclip agents do not run continuously. They run in heartbeat windows triggered by wakeups such as timer, assignment, on-demand, or automation.

Each heartbeat starts an adapter, gives it prompt/context, lets it run until exit, timeout, or cancellation, stores run status/tokens/errors/logs, and updates UI.

Source: https://github.com/paperclipai/paperclip/blob/master/docs/agents-runtime.md

## Paperclip process execution

Paperclip uses child processes for local adapters. Normal execution is not tmux-based.

The shared process runner uses `node:child_process.spawn`, streams stdout/stderr, records pid and process group information, supports timeout, sends graceful termination, and escalates to kill after a grace period.

Source: https://github.com/paperclipai/paperclip/blob/master/packages/adapter-utils/src/server-utils.ts

The generic process adapter is documented as executing arbitrary shell commands as child processes with env injection and exit-code based success/failure.

Source: https://github.com/paperclipai/paperclip/blob/master/docs/adapters/process.md

## Paperclip adapter examples

Claude local adapter:

- Uses `claude --print - --output-format stream-json --verbose`.
- Supports session resume with `--resume`.
- Supports model/effort/max-turns/append-system-prompt/add-dir style options.
- Parses stream JSON for terminal result, session id, and usage.

Source: https://github.com/paperclipai/paperclip/blob/master/packages/adapters/claude-local/src/server/execute.ts

Codex local adapter:

- Uses `codex exec --json ... -`.
- Supports session continuation through `resume`.
- Manages `CODEX_HOME`, injected skills/config/auth context, and fresh-session fallback paths.

Source: https://github.com/paperclipai/paperclip/blob/master/packages/adapters/codex-local/src/server/execute.ts

OpenCode local adapter:

- Uses `opencode run --format json`.
- Supports `--session`, `--model`, and `--variant`.
- Uses temp config and model/session validation paths.

Source: https://github.com/paperclipai/paperclip/blob/master/packages/adapters/opencode-local/src/server/execute.ts

## Paperclip orchestration/lifecycle

Paperclip stores heartbeat runs and events, updates agent runtime state, publishes live events, stores run logs, supports cancellation by pid/process group, and has recovery paths for lost/orphaned running runs.

Source: https://github.com/paperclipai/paperclip/blob/master/server/src/services/heartbeat.ts

It has a per-agent start lock so concurrent starts for the same agent are coalesced or blocked.

Source: https://github.com/paperclipai/paperclip/blob/master/server/src/services/agent-start-lock.ts

It also has run liveness classification/recovery paths for cases like empty or low-signal runs.

Source: https://github.com/paperclipai/paperclip/blob/master/server/src/services/run-liveness.ts

## Comparison facts

Paperclip is organized around short, resumable heartbeat runs. It waits for CLI run completion and records result/logs/state.

Agent Teams is organized around live team members, mixed providers, direct messages, tasks, work-sync, runtime evidence, and durable bootstrap/check-in proof.

Paperclip does not need the same live teammate readiness model because it does not maintain a long-running team room with continuously addressable members.

Agent Teams still supports tmux/pane backends in the orchestrator, but current app-launched teammates can use process backend with app-managed runtime evidence.

Paperclip's process lifecycle primitives are more centralized. Agent Teams has more live multi-agent protocol surface and therefore more runtime states to reconcile.


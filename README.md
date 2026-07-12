# Subscription Runtime

Provider-neutral runtime for running subscription-backed AI workers without binding
host applications to a specific agent implementation.

This repository provides the runtime pieces needed to use subscription-backed AI
agents from backend services and CI jobs. It coordinates session custody,
refresh, writeback, concurrency, process isolation, queue semantics, redaction
and performance tuning while keeping host applications independent from any
single provider. Codex is the first production adapter, and the package layout
is designed so Claude or another subscription-backed agent can be added without
rewriting the host application.

This package is not an orchestrator. It does not own project strategy, global
task selection, worker mix, review policy, benchmark priority or autonomous
coordination. Those responsibilities belong to a host application or a separate
orchestrator library above this runtime. `subscription-runtime` exposes the
safe execution, custody, broker and audit primitives that such a layer can call.

Install the published package from GitHub Packages:

```ini
@vioxen:registry=https://npm.pkg.github.com
```

```json
{
  "dependencies": {
    "@vioxen/subscription-runtime": "0.1.0-main.1"
  }
}
```

Use subpath exports:

```ts
import { createSubscriptionRuntime } from "@vioxen/subscription-runtime/core";
import { FileBackendCodexWorker } from "@vioxen/subscription-runtime/worker-codex";
import {
  ClaudeRuntimeTaskExecutionEngine,
  ClaudeTaskAgentDriver,
} from "@vioxen/subscription-runtime/provider-claude";
import { createLocalFileBackendRuntimeAdapters } from "@vioxen/subscription-runtime/store-local-file";
```

Inspect account availability without running provider tasks:

```bash
subscription-runtime-account-status --provider all --json
subscription-runtime-account-status --provider codex --only reconnect_required
```

See [docs/account-diagnostics.md](docs/account-diagnostics.md) for account
sources, cached capacity and optional probe behavior.
See [docs/agent-account-observability.md](docs/agent-account-observability.md)
for the separate package that reads deeper provider auth/quota facts.

See [docs/dependency-bootstrap.md](docs/dependency-bootstrap.md) for isolated
worktree environments backed by shared pnpm, npm, Yarn, Bun and uv caches.

## Modules

- `core` - provider-neutral ports, policy, state machines and redaction.
- `account-diagnostics` - provider-neutral account status, relogin and limit
  diagnostics for scheduler/account operations.
- `agent-account-observability` - separate DDD package for provider account
  auth/quota facts, including Codex app-server limit buckets.
- `provider-codex` - Codex session refresh and execution adapters.
- `provider-claude` - Claude OAuth session validation, injectable task driver
  ports and an optional concrete bridge to `claude-runtime`.
- `worker-core` - bounded worker pool contracts.
- `worker-codex` - file-backed Codex worker assembly.
- `queue-core` - host-neutral queue contracts.
- `queue-bullmq` - BullMQ-compatible queue adapter.
- `store-local-file` - encrypted local file session and lease stores.
- `store-github-actions-secret` - no-plaintext GitHub Actions secret store.
- `runner-github-action` - GitHub Actions runtime adapter.

## Design Goals

Subscription-backed execution has a short happy path:

1. keep a login session somewhere;
2. run an agent with that session;
3. return the result.

The runtime exists to keep that path reliable once it is used by real services:

- sessions rotate and a refreshed token must be written back atomically;
- two workers can refresh the same account at the same time;
- a process can crash after refresh but before writeback;
- stale session copies can overwrite newer generations;
- logs, errors, stdout and stderr can leak tokens unless every boundary is
  redacted;
- GitHub Actions cannot send plaintext secrets through the SaaS backend;
- backend services need file or database custody, while GitHub Actions needs a
  no-plaintext encrypted writeback path;
- Codex CLI execution has startup cost, so worker slots need prewarm, reusable
  state and a faster app-server path;
- a backend may need synchronous HTTP responses for small jobs and async queue
  jobs for larger batches;
- every provider has different auth and execution behavior, but host
  applications should not care whether the underlying adapter is Codex, Claude,
  or something else.

This is why the package is split into ports, provider adapters, storage
adapters, queue adapters and runner adapters. Each module carries a different
operational responsibility instead of pushing all behavior into one large
service class.

## Orchestration Boundary

This repository is the execution and safety kernel. It owns provider adapters,
session custody, brokered project-control operations, admission gates, audit
events and fail-closed runtime invariants.

It must not become the project orchestration layer. Decisions such as which
project tasks to run, how many producer or reviewer workers to keep alive,
which benchmark matters next, how to prioritize a dirty-worktree drain backlog,
or when to launch a higher-level autonomous controller belong in a host
orchestration layer above this package. That layer should call the
`codex_goal_project_*` broker tools and admission snapshot APIs exposed here,
not bypass them with raw shell, tmux, git or registry writes.

Any field that sounds strategic, such as `workerRole`, is treated here as
caller-supplied admission intent for safety gating and audit. The runtime may
decide whether that requested operation is safe right now, but it must not
decide the desired role mix, backlog strategy or project objective.

When a new safety invariant is project-neutral, implement it here. When a new
policy is about one project's goals, capacity strategy or task prioritization,
implement it above this package, for example in hosted-agent operations.

## Architecture Map

| Module | Main responsibility | Reliability responsibilities | Why it exists |
| --- | --- | --- | --- |
| `core` | Provider-neutral contracts, runtime policy, state machines, generation hashes, redaction | Keeps session modes, refresh policy, writeback policy, leases, idempotency and safe errors consistent without importing Codex, GitHub, BullMQ or filesystem code | This is the stable domain layer. New providers should plug into this instead of changing host applications |
| `account-diagnostics` | Provider-neutral account availability diagnostics | Merges safe identity, cached account capacity, optional health/live probes, relogin recommendations and duplicate account hashes without returning secrets | Lets operators and schedulers see which Codex or Claude accounts are usable, limited or need relogin |
| `provider-codex` | Codex auth parsing, refresh, process execution, app-server execution, JSON execution, fallback classification | Codex sessions can rotate, the CLI can fail in multiple ways, app-server can request unsupported tools, stdout/stderr must be redacted, startup latency must be reduced without storing plaintext auth in durable state | Encapsulates all Codex-specific behavior so the rest of the runtime remains provider-neutral |
| `worker-core` | Bounded worker pools and direct in-process execution | Queueing, backpressure, prewarm lifecycle, graceful disposal, cancellation, timeouts and per-slot state | Lets backend services run many jobs without spawning unlimited agent processes |
| `worker-codex` | Ready-to-use file-backed Codex backend worker | Connects encrypted file custody, leases, Codex materialization, app-server fast path, exec fallback, prewarm and safe process env handling | Provides the practical integration point for Node backends that want Codex subscription execution |
| `queue-core` | Host-neutral async task queue contracts and in-memory implementation | Leases, retry lifecycle, duplicate protection, idempotency, graceful stop behavior and safe release of claimed work | Keeps queue semantics independent from Redis, BullMQ, Nest, Fastify or any other framework |
| `queue-bullmq` | BullMQ adapter for Redis-backed queues | Maps runtime task semantics onto BullMQ job IDs, attempts, stalled jobs, lock behavior and result envelopes | Gives production services a standard Redis queue without forcing BullMQ into `core` |
| `store-local-file` | AES-256-GCM encrypted local session store and file lease store | Atomic writes, CAS generation checks, idempotent writeback, corrupt record handling, TTL-based lease expiry, safe filenames and no plaintext credential persistence | Simple backend deployment path for one host or a shared POSIX volume |
| `store-github-actions-secret` | GitHub Actions secret storage with no plaintext SaaS boundary | Uses GitHub public key sealed-box encryption, rejects plaintext-looking payloads, preserves generation metadata and supports writeback without exposing provider credentials to ReviewRouter SaaS | Required for GitHub-hosted CI where the backend must never receive raw auth JSON |
| `runner-github-action` | GitHub Actions process runner boundary | Redacts stdout/stderr, preserves required process env, avoids leaking tokens, normalizes process failures | Keeps action runtime execution safe and testable |
| `testing` | Contract tests, fake providers, fake stores and canaries | Makes every adapter prove stale generation handling, idempotency, no-secret logs and reconnect behavior | Prevents each new adapter from silently weakening the runtime guarantees |

Implementation depth by area:

| Area | Stability | Reliability focus | Notes |
| --- | --- | --- | --- |
| Provider-neutral runtime model | Stable domain layer | strict policy negotiation, state transitions, safe errors | The model has to stay strict enough for future providers |
| Codex backend execution | Production adapter with fallback | process lifecycle, app-server behavior, refresh conflicts | Codex is provider-specific, but host apps use provider-neutral contracts |
| Local file backend mode | First backend custody option | encrypted records, CAS, local leases | Good for single-host or shared-volume deployments, not a multi-replica distributed lock |
| GitHub Actions no-plaintext mode | CI custody option | encrypted secret writeback, no plaintext SaaS boundary | Designed for GitHub-hosted runners and ephemeral workflows |
| Queue and worker orchestration | Backend workload layer | bounded slots, retries, leases, graceful shutdown | Failed or slow agent tasks must not break queue correctness |
| Demo and external consumption | Integration layer | Published package artifacts, packed-consumer checks, Docker smoke path | Keeps the package usable outside its original monorepo |

## Package Responsibilities

### `core`

`core` is intentionally boring from the outside, but it is the package that
prevents the rest of the runtime from becoming provider-specific glue.

It owns:

- session capability negotiation:
  - no-session providers;
  - static-session providers;
  - rotating-session providers;
- refresh policy:
  - never refresh;
  - validate only;
  - refresh before run;
  - lazy refresh;
- writeback policy:
  - never write back;
  - write back before task;
  - write back after successful refresh;
- session state transitions:
  - restored;
  - validated;
  - refreshing;
  - active;
  - stale;
  - needs reconnect;
- lease state transitions:
  - acquired;
  - finalized;
  - writeback started;
  - writeback committed;
  - idempotent replay;
  - stale generation;
- generation hashes, so a store can prove that a writeback belongs to the
  generation it refreshed from;
- redaction rules and explicit no-secret canaries.

The main design constraint is that `core` must not know about Codex, GitHub,
BullMQ, local files, Redis, Fastify or Nest. That is deliberate. If `core`
imports a concrete provider or storage adapter, the library stops being a
runtime and becomes one integration.

Important edge cases handled here:

- a provider says refresh is not supported, but the selected policy requires
  refresh;
- a session store exists for a no-session provider;
- a rotating provider is used without a lease-capable store;
- a stale generation attempts to overwrite a newer session;
- an idempotent retry repeats a writeback after a network or process failure;
- a safe error must be returned without including raw session content.

### `provider-codex`

`provider-codex` is the provider adapter with the most moving parts because it
bridges a backend library to the Codex CLI and Codex app-server protocol.

It owns:

- Codex `auth.json` parsing and validation;
- session refresh through Codex;
- JSON execution through `codex exec --experimental-json`;
- app-server execution for lower latency worker slots;
- execution profiles:
  - `stateless-completion` for API-like backend jobs;
  - `subscription-worker` for compatibility with the original runtime path;
  - `custom` for host-provided instructions and tool policy;
- tool disabling for API-like work:
  - no shell tools;
  - no repo inspection;
  - no dynamic tools by default;
  - read-only sandbox;
  - `approvalPolicy: never`;
- failure classification:
  - auth expired;
  - reconnect required;
  - quota or permission failures;
  - process failures;
  - app-server protocol failures;
- redaction of stdout, stderr, JSON events and error messages.

The key engineering point is that Codex is optimized for an interactive coding
agent, while backend workloads often need API-like behavior: "take this prompt,
return a compact result, do not inspect files, do not ask for approvals, do not
leak session state, and do it many times in parallel".

Performance work in this package:

- app-server fast path, so a worker slot can keep a server process alive instead
  of paying the full CLI startup cost for every internal step;
- clean-thread prewarm, so a slot can prepare the next stateless task before it
  is needed;
- minimal `stateless-completion` instructions, because large agent-style
  instructions slow down simple backend jobs;
- process-local materialized auth cache, so the runtime avoids repeated
  decrypt/materialize work without writing plaintext auth into durable state;
- exec fallback, because app-server is still a lower-level protocol and should
  not be the only way to execute a task.

Important edge cases handled here:

- the Codex binary is not installed or is not executable;
- the child process needs `PATH`, but must not inherit sensitive env variables
  unnecessarily;
- app-server exits before it is ready;
- app-server asks the client to execute an unsupported tool;
- a refreshed session has rotated and must be written back before the task uses
  stale credentials;
- stdout or stderr contains token-looking fields;
- materialized auth must be deleted on release and must not live under the
  durable encrypted store directory.

### `provider-claude`

`provider-claude` keeps Claude execution behind the same provider-neutral task
port as Codex. Hosts can inject their own `ClaudeTaskExecutionEngine`, or use
`ClaudeRuntimeTaskExecutionEngine` at the composition root when `claude-runtime`
is installed next to the application. The combined driver also implements the
streaming task port, so host apps can observe provider-neutral text, tool, usage
and warning events without importing Claude BG internals.

The concrete bridge loads `claude-runtime` dynamically, so this package does not
take a hard dependency on Claude internals. It requires a Claude OAuth session
artifact with `configDir`, because the underlying Claude BG runtime needs the
real Claude config directory for process execution and state files.
Claude BG provider construction lives in a dedicated runtime-context factory;
the task execution engine only builds commands, streams provider-neutral events
and aggregates the final task result.

Example composition:

```ts
import {
  ClaudeBgProviderDriver,
  ClaudeRuntimeTaskExecutionEngine,
} from "@vioxen/subscription-runtime/provider-claude";

const claudeDriver = new ClaudeBgProviderDriver({
  engine: new ClaudeRuntimeTaskExecutionEngine(),
  model: "sonnet",
});
```

This is intentionally still a task adapter. Claude BG run ids, transcript
offsets and cleanup details stay inside the provider adapter unless a product
workflow needs a public managed-run contract.

### `worker-core`

`worker-core` is the in-process concurrency layer. It looks small compared with
provider code, but it protects host services from accidental process storms.

It owns:

- bounded worker slots;
- prewarm lifecycle;
- queueing inside the pool;
- max queue size;
- cancellation before a queued task starts;
- per-slot health and busy state;
- graceful disposal;
- safe rejection of queued work during shutdown.

Why the pool exists:

- Codex workers consume memory and CPU, so parallelism must be bounded;
- a backend endpoint may receive more work than it can run immediately;
- prewarm failures must be reported without leaving the pool half-started;
- shutting down a service must reject queued work and avoid starting new tasks;
- a slow task must not block unrelated slots;
- metrics need to distinguish queued, running and completed work.

### `worker-codex`

`worker-codex` assembles the real backend worker that most consumers use.

It wires together:

- `store-local-file` for encrypted session custody;
- `store-local-file` lease store for refresh coordination;
- `provider-codex` for validation, refresh and execution;
- `worker-core` slot lifecycle;
- temp workspaces;
- safe process runner;
- app-server fast path;
- exec fallback;
- observability hooks.

The execution sequence is explicit:

1. load encrypted session;
2. acquire or respect refresh lease;
3. validate session;
4. refresh only when needed or when forced by auth failure;
5. write back new generation atomically;
6. materialize temporary `auth.json`;
7. run the task in the selected execution profile;
8. redact every output boundary;
9. release temp files and worker resources.

Important edge cases handled here:

- two slots refresh the same provider at the same time;
- one slot gets a stale generation because another slot already refreshed;
- refresh conflict should retry within bounds, not loop forever;
- fallback from app-server to exec should preserve redaction and safe errors;
- a durable state directory must not accidentally receive plaintext `auth.json`;
- worker prewarm should improve latency but not make startup impossible if
  prewarm fails.

### `queue-core`

`queue-core` defines the async job contract without choosing Redis, BullMQ or a
framework.

It owns:

- task enqueue;
- task claim;
- task completion;
- task failure;
- retry scheduling;
- lease expiry;
- idempotent enqueue;
- graceful processor stop.

Queue semantics need to stay correct when workers are slow or processes shut
down:

- a claimed task can finish after shutdown begins;
- a claim can expire and become visible again;
- duplicate submit requests should not create duplicate expensive agent jobs;
- failed attempts need clear retry behavior;
- a sync HTTP wrapper may wait for a task result while the queue remains async.

### `queue-bullmq`

`queue-bullmq` maps the neutral queue contract onto BullMQ.

It owns:

- Redis-backed queue operations;
- BullMQ job data envelopes;
- runtime result envelopes;
- error translation;
- integration with BullMQ attempts and delays.

Why it is separate:

- not every host app wants BullMQ;
- `core` and `worker-core` should not depend on Redis;
- demos and production services can use BullMQ without making it mandatory for
  every consumer;
- a future adapter can target another queue system without changing provider
  code.

Important edge cases:

- job payloads must stay serializable;
- safe errors must survive queue serialization;
- retries must not duplicate non-idempotent side effects;
- queue adapters must not log prompts, tokens or auth artifacts by default.

### `store-local-file`

`store-local-file` is the first backend custody mode. It keeps the deployment
simple while preserving the safety guarantees the runtime needs.

It owns:

- AES-256-GCM encrypted session records;
- 32-byte encryption key validation;
- local file layout;
- atomic writes;
- generation checks;
- idempotency records;
- stale generation rejection;
- corrupt record detection;
- file-based refresh leases;
- lease TTL expiry;
- finalized/writeback metadata;
- safe hashed filenames.

The most important guarantee is that durable files must not contain provider
credential plaintext. The backend process can decrypt the session at runtime,
but the persisted record should remain encrypted. Materialized `auth.json`
belongs in process-local temp/cache space and must be cleaned up.

Known deployment boundary:

- good for one backend host;
- good for a shared POSIX volume if the deployment understands that boundary;
- not a distributed lock for many independent replicas;
- for multi-replica deployments, use a future Postgres or Redis-backed lease
  adapter.

Important edge cases:

- encryption key has the wrong length;
- record is corrupt or partially written;
- writeback uses an old generation;
- an idempotent retry repeats the same writeback;
- the same idempotency key is reused with different content;
- a lease expires after a crashed worker;
- lease files must not include raw auth JSON or tokens.

### `store-github-actions-secret`

`store-github-actions-secret` is the no-plaintext CI custody path.

It owns:

- reading GitHub Actions secret metadata;
- encrypting refreshed auth JSON with GitHub's repository public key;
- sending only `encrypted_value`, `key_id` and metadata to the writeback
  boundary;
- rejecting plaintext-looking writeback requests;
- preserving generation and idempotency behavior around secret updates.

The security goal is specific: the SaaS backend should not receive provider
credentials. GitHub Actions can refresh inside the runner, encrypt the updated
secret for GitHub, then ask the backend to coordinate and authorize writeback
without sending raw `refresh_token`, `access_token`, `id_token` or auth JSON.

Why this path is separate:

- GitHub-hosted runners are ephemeral;
- refreshed sessions must survive between workflow runs;
- secret updates need repository permissions;
- workflow runs can race;
- a stale run must not overwrite a newer secret;
- logs must stay useful without revealing tokens;
- errors must tell users to reconnect without dumping auth state.

### `runner-github-action`

`runner-github-action` is the action process boundary.

It owns:

- command execution;
- stdout/stderr redaction;
- process failure normalization;
- safe environment handling;
- action-friendly error messages.

This module exists because process output is one of the easiest places to leak
secrets. Even if provider and store code are careful, a CLI can still print
token-looking fields during a failure. The runner boundary treats stdout and
stderr as untrusted data and redacts them before forwarding.

### `testing`

`testing` is a first-class package because adapter correctness cannot be judged
by happy-path tests only.

It provides:

- fake providers;
- fake stores;
- contract fixtures;
- redaction canaries;
- stale generation tests;
- idempotency tests;
- local E2E fixtures.

Every new provider or store should prove the same behaviors:

- no plaintext token in logs or serialized errors;
- stale generation does not overwrite newer state;
- idempotent retry returns the original generation;
- reconnect-needed state is explicit;
- no-session providers do not require session stores;
- rotating providers do not run without writeback-safe custody.

## Performance Work

The runtime includes several optimizations that were added because naive Codex
execution was too slow for backend workloads.

### Stateless completion profile

Most backend jobs do not need a full coding-agent environment. For example, a
match rating service usually wants:

- one clean prompt;
- one answer;
- no repository scan;
- no shell commands;
- no persistent history;
- no approval flow.

The `stateless-completion` profile sets short instructions and disables tools by
default. This makes the worker behave closer to an API completion while still
using a subscription-backed Codex session.

### Worker slot prewarm

Backend services should not create everything from zero for every request.
`worker-core` and `worker-codex` support prewarm so each slot can prepare the
expensive parts before user traffic arrives.

Prewarm helps with:

- process setup;
- auth materialization;
- app-server readiness;
- first task latency;
- predictable capacity planning.

Prewarm is best-effort. A failed prewarm should surface as a warning or health
signal, but the worker can still attempt normal execution if the host chooses
that behavior.

### App-server fast path with exec fallback

The Codex app-server path can reduce repeated process overhead by keeping a
server slot available. The runtime still keeps `codex exec` fallback because a
backend library should not depend on one experimental path with no escape hatch.

The tradeoff:

- app-server is faster when stable and warm;
- exec is simpler and more conservative;
- both paths need identical redaction and session handling;
- fallback must not hide real auth failures.

### Clean-thread prewarm

For stateless jobs, a worker can prepare a clean thread for the next task. This
is useful when many small tasks arrive in bursts. The next task can start from a
ready thread instead of creating it at the last moment.

The edge cases are subtle:

- a prepared thread must not be reused by two tasks;
- a failed precreate must not drop the real task;
- after a task finishes, the next clean thread should be prepared in the
  background;
- session refresh can still invalidate the prepared execution context.

### Process-local auth materialization

The encrypted session store is durable. The materialized `auth.json` is not.

The runtime intentionally keeps materialized auth in process-local temp/cache
space, not in the durable state directory. This avoids a common backend mistake:
encrypting the main store but accidentally writing a decrypted credential copy
next to it for performance.

## Concurrency And Refresh Safety

Rotating subscription sessions are the main state-management concern in this
repository.

The dangerous scenario:

1. worker A reads generation 10;
2. worker B reads generation 10;
3. worker A refreshes and writes generation 11;
4. worker B refreshes an older copy and tries to write generation 11 again;
5. if the store accepts this blindly, the newer session can be lost.

The runtime prevents that with:

- generation hashes;
- compare-and-swap writeback;
- lease IDs;
- idempotency keys;
- stale generation results;
- bounded retry for transient refresh conflicts.

This matters because backend worker pools can run multiple slots for the same
provider account. Without coordination, scaling the service would make auth less
reliable.

## Implementation Notes From Real Integration

The following notes are intentionally concrete. They describe classes of issues
that appeared during implementation and integration work, plus the design choice
that prevents the same class of issue from becoming a production incident. They
are included so maintainers and integrators can understand the reliability
boundaries without reading every source file first.

### Child process environment matters in containers

Observed symptom:

- app-server startup failed inside Docker with a process exit similar to
  `codex_app_server_exited:127`;
- the underlying failure was that the spawned Codex process could not resolve
  its Node entrypoint through `/usr/bin/env node`.

Root cause:

- the child process environment was made too small;
- `PATH` was not preserved for the Codex child process;
- this is easy to miss locally if the host shell has a richer environment than
  the container runtime.

Runtime design response:

- process execution now keeps a safe child environment instead of blindly
  stripping everything or blindly inheriting everything;
- token-like env values are still treated as dangerous output and redacted;
- the runner boundary is explicit, so provider code does not hand-roll process
  spawning in multiple places.

Why it matters:

- backend libraries are often deployed in Docker, not only on a developer
  machine;
- if the process boundary is wrong, the user sees a generic agent failure even
  though auth and prompts are correct;
- fixing this in one runner path prevents every provider adapter from needing a
  slightly different process-spawn workaround.

### Parallel refresh did not fail like a normal request

Observed symptom:

- with multiple worker slots, two jobs could start from the same saved session
  generation;
- one worker refreshed and wrote back a newer session;
- another worker then attempted to write a session based on the older generation;
- without extra handling, one parallel job could fail even though the provider
  account was valid.

Root cause:

- rotating sessions are mutable state;
- parallelism turns refresh into a compare-and-swap problem, not a simple
  "read, refresh, write" flow;
- the failure is transient and depends on timing, so it can pass in one run and
  fail in the next.

Runtime design response:

- session records carry generation numbers and generation hashes;
- writeback requires the expected generation;
- stale writes are rejected instead of overwriting newer auth;
- idempotency keys let a retry replay a completed writeback safely;
- the Codex worker has bounded retry for transient refresh conflicts.

Why it matters:

- increasing worker slots should increase throughput, not make auth randomly
  less reliable;
- "just refresh before every task" is not safe when refresh can rotate the
  session;
- a retry must be bounded, otherwise an auth bug can become an infinite refresh
  loop.

### Encrypted storage was not enough by itself

Observed symptom:

- the durable session store was encrypted, but a materialized worker cache path
  could still contain a decrypted `auth.json` copy;
- that means the main storage layer looked safe while another path created a
  plaintext credential copy for performance.

Root cause:

- backend execution needs a real file that Codex can read;
- it is tempting to place that file under the same durable state root that holds
  encrypted records;
- "encrypted store" does not automatically mean "no plaintext anywhere".

Runtime design response:

- durable backend state remains encrypted;
- materialized auth is process-local and temporary;
- worker cache materialization no longer writes decrypted auth into the durable
  state directory;
- tests assert that durable local file state does not contain known token
  fields;
- runner output is redacted even if a provider process prints token-looking
  data.

Why it matters:

- users may mount `/var/lib/subscription-runtime` as a persistent volume;
- persistent volumes are backed up, inspected and copied more often than temp
  directories;
- a single misplaced `auth.json` defeats the whole point of encrypted custody.

### App-server improved latency but did not remove model latency

Observed behavior:

- a cold `codex exec` path pays for process startup, session materialization,
  runtime setup and model execution;
- a warm app-server slot can reduce repeated setup cost;
- the model still has to reason and generate the answer, so app-server is not
  the same as a low-level API call with no agent runtime around it.

Runtime design response:

- the Codex worker supports an app-server fast path;
- exec remains as fallback;
- worker slots can prewarm;
- stateless completion mode keeps instructions short and disables tools by
  default;
- clean-thread prewarm prepares the next task when possible.

Why it matters:

- users need honest latency expectations;
- app-server helps most when there are many small jobs and slots are warm;
- for truly realtime products, a smart router may still choose an API provider
  for latency-critical requests and subscription workers for background or batch
  work.

### "Disable tools" had to be explicit

Observed risk:

- Codex is a coding-agent runtime by default;
- a backend completion task usually should not inspect a repository, execute
  shell commands, ask for approvals or perform interactive tool work;
- if this is not explicit, a simple prompt can accidentally pay for agent
  behavior it does not need.

Runtime design response:

- `stateless-completion` is a first-class execution profile;
- dynamic tools and environments are empty by default;
- sandbox defaults are conservative;
- approval policy is `never`;
- host applications can still choose a custom profile when they need agentic
  behavior.

Why it matters:

- match scoring, ranking, classification and short JSON generation jobs should
  behave like backend computations;
- disabling unused agent features improves predictability and can reduce
  latency;
- the runtime can later support session or history modes without making simple
  jobs slower by default.

### GitHub Actions custody was a different problem from backend custody

Observed constraint:

- a backend file store can decrypt a session because the backend owns the worker
  process;
- GitHub-hosted Actions should not send raw provider credentials to the SaaS
  backend;
- CI runners are ephemeral, so a refreshed session has to be persisted back into
  GitHub secrets.

Runtime design response:

- the GitHub Actions store path is separate from the local file store path;
- writeback sends encrypted secret payloads, not plaintext auth JSON;
- plaintext-looking writeback requests are rejected at the boundary;
- lease and generation metadata still exist so concurrent workflow runs cannot
  overwrite each other blindly.

Why it matters:

- the same "subscription runtime" has to support both backend workers and CI
  workflows;
- those two environments have different custody models;
- mixing them into one storage abstraction without explicit security rules would
  make the secure path harder to reason about.

### Queue semantics had to account for slow agent tasks

Observed behavior:

- subscription-backed agent jobs are not millisecond tasks;
- some calls are fast, some are slow, and a few fail for provider or process
  reasons;
- HTTP callers may want a synchronous wait wrapper, but the system still needs
  async queue semantics underneath for bursty load.

Runtime design response:

- `queue-core` models task claim, completion, failure, retry and lease expiry;
- `worker-core` bounds concurrency separately from queue depth;
- `queue-bullmq` maps those semantics to Redis/BullMQ without putting BullMQ in
  `core`;
- host apps can expose both async jobs and sync wait endpoints.

Why it matters:

- without leases, a crashed worker can lose work;
- without bounded pools, a traffic spike can spawn too many Codex processes;
- without idempotency, retrying a submit request can create duplicate expensive
  jobs.

### Packaging had real consumer constraints

Observed constraint:

- ReviewRouter, demo services and external Node backends should not copy source
  files from this repository;
- npm consumers expect versioned package artifacts with package-lock
  reproducibility;
- Docker builds should consume the published artifact instead of compiling this
  package from TypeScript during install.

Runtime design response:

- one published package with GitHub Packages as the registry;
- subpath exports for clean module boundaries;
- `dist` generated during pack and publish, not committed to source;
- boundary checks to prevent architecture drift;
- packed-consumer smoke checks to verify real external imports.

Why it matters:

- a library that works only inside its original monorepo is not a real
  reusable package;
- consumers should import `@vioxen/subscription-runtime/worker-codex`, not
  internal source paths;
- the packaging model has to work in local dev, CI and Docker.

## Failure Modes Covered By The Runtime

This table is useful when reviewing the codebase because most modules exist to
block one or more of these failure modes.

| Failure mode | Typical symptom | Guardrail in this runtime |
| --- | --- | --- |
| Missing or invalid Codex binary | Worker starts but every task fails before reaching the model | Provider adapter validates execution and classifies process startup failures |
| Child process env stripped too aggressively | App-server exits with code 127 or cannot resolve `node` | Runner preserves safe process env, including path resolution, while still redacting dangerous output |
| Raw provider token appears in stderr | CI or service logs contain token-looking fields | Redactor is used at process, provider and runner boundaries |
| Session refresh rotates auth while another worker is running | One worker succeeds, another writes stale auth or fails unpredictably | Generation hash, CAS writeback, leases, idempotency and bounded retry |
| Worker crashes after refresh but before final task result | New session may or may not have been persisted | Writeback has explicit started/committed states and idempotent replay |
| Local store is encrypted but a temp cache leaks auth | Persistent volume contains a decrypted `auth.json` copy | Durable state and process-local materialization are separate |
| GitHub-hosted runner refreshes successfully but backend receives plaintext | SaaS custody boundary is violated | GitHub secret store accepts encrypted payloads and rejects plaintext-looking writeback |
| Queue retry submits the same expensive job twice | Duplicate model work and duplicate side effects | Queue idempotency keys and task lifecycle states |
| Pool receives more jobs than it can run | Too many Codex processes, high memory, degraded service | Bounded worker slots, max queue size and graceful rejection |
| Prewarm fails | Service becomes unavailable before any real request | Prewarm is explicit and observable; execution path can still attempt normal startup depending on host policy |
| App-server protocol changes or fails | Fast path breaks all workers | Exec fallback remains available and uses the same session/redaction boundary |
| Provider-specific code leaks into host apps | ReviewRouter, demo and backend service all need different integrations | Subpath exports and provider-neutral `core` ports keep host APIs stable |
| Multi-replica backend uses local files independently | Each replica has a different session generation | README and API document local-file mode as single-host/shared-volume only |

## Code Traceability

The behavior above maps directly to implementation files. This section is a
reading guide for reviewers who want to verify that the README is describing the
actual code, not an aspirational design.

| Concern | Primary files | What to look for |
| --- | --- | --- |
| Runtime capability negotiation | `src/core/application/policy.ts`, `src/core/domain/types.ts` | `RuntimeExecutionPlan` variants, custody checks, `requiresLease`, `requiresCas`, no-session/static/rotating session decisions |
| Runtime refresh/writeback flow | `src/core/application/runtime.ts` | `refreshSession`, lease acquire/finalize, `markWritebackStarted`, `sessionStore.write`, stale-generation handling, blocked states |
| State transition safety | `src/core/domain/state-machines.ts` | explicit session and lease transition tables, invalid transition errors |
| Redaction boundary | `src/core/application/redactor.ts` | registered secrets, token-field regex, Bearer token redaction, `assertNoKnownSecret` |
| Codex auth parsing and freshness | `src/provider-codex/codex-cli-domain.ts`, `src/provider-codex/codex-auth-json-codec.ts` | `auth_mode: chatgpt`, refresh/access/id token shape, byte limits, expiry and `last_refresh` freshness checks |
| Codex refresh | `src/provider-codex/codex-cli-session-driver.ts` | isolated temp `CODEX_HOME`, refresh bootstrap plan, cleanup, provider-state mapping |
| Codex execution profile | `src/provider-codex/codex-execution-profile.ts` | `stateless-completion`, `subscription-worker`, custom profile resolution |
| App-server fast path | `src/provider-codex/codex-app-server-execution-engine.ts` | app-server slot reuse, `thread/start`, `turn/start`, disabled tools, clean-thread prewarm, unsupported server requests, exec fallback |
| Materialized auth lifecycle | `src/provider-codex/codex-session-materializer.ts` | ephemeral vs worker-cache materializers, exclusive slot use, process-local temp cache, atomic auth writes |
| File backend worker | `src/worker-codex/file-backend-codex-worker.ts` | local encrypted adapters, lazy refresh policy, app-server + fallback assembly, bounded retry on refresh conflicts |
| Local encrypted custody | `src/store-local-file/local-encrypted-file-store.ts` | AES-256-GCM, 32-byte key validation, generation CAS, idempotency records, atomic writes |
| Local file leases | `src/store-local-file/local-file-lease-store.ts` | active lease records, lock files, TTL, stale lock cleanup guard, finalize/writeback/commit states |
| GitHub secret no-plaintext custody | `src/store-github-actions-secret/github-actions-secret-store.ts`, `src/store-github-actions-secret/no-plaintext-boundary.ts` | sealed-box encrypted writeback request, forbidden plaintext keys and token patterns |
| Worker pool | `src/worker-core/worker-pool.ts` | bounded slots, queue size, prewarm, restart, shutdown drain, stats and health |
| Queue lifecycle | `src/queue-core/in-memory-task-queue.ts`, `src/queue-core/processor.ts` | enqueue idempotency, claim leases, retry scheduling, graceful release on shutdown |
| BullMQ adapter | `src/queue-bullmq/bull-subscription-task-queue.ts` | job ID/idempotency mapping, attempts, delay, remove-on-complete/fail options |
| GitHub Action runner | `src/runner-github-action/github-action-runner.ts` | forbidden env keys, stdout/stderr redaction, captured output bounds, timeout/abort handling |
| Node backend runner | `src/worker-codex/node-process-runner.ts` | timeout, abort, SIGTERM/SIGKILL cleanup for backend-local execution |

## Issues Converted Into Tests

Some tests exist because a bug class is easy to reintroduce during refactoring.
The names below are intentionally practical so maintainers can connect a test
failure to the production risk it protects.

| Test area | Files | Risk covered |
| --- | --- | --- |
| Redaction canary | `src/core/tests/redaction-canary.test.ts`, `src/core/tests/subscription-runtime-core.test.ts` | token-looking fields or registered secrets appearing in logs, errors or events |
| Capability negotiation | `src/core/tests/subscription-runtime-core.test.ts` | no-custody store mismatch, static providers accidentally leasing, no-session providers requiring stores |
| Lazy refresh | `src/core/tests/subscription-runtime-core.test.ts`, `src/provider-codex/tests/codex-provider.test.ts` | refreshing too often, skipping needed refresh, guarded refresh after auth failure |
| Runtime writeback sequencing | `src/core/tests/subscription-runtime-core.test.ts`, `src/core/tests/subscription-runtime-local-e2e.test.ts` | task must use the refreshed artifact even if the store read remains stale during the same job |
| Codex env pruning | `src/provider-codex/tests/codex-provider.test.ts`, `src/worker-codex/tests/file-backend-codex-worker.test.ts` | preserving `PATH` while excluding provider/API/GitHub auth env values |
| App-server prewarm | `src/provider-codex/tests/codex-provider.test.ts` | reusable app-server slots and prepared clean threads before first real task |
| App-server fallback | `src/provider-codex/tests/codex-provider.test.ts` | fast path failure must use exec fallback when appropriate, but not fallback on abort |
| Durable plaintext prevention | `src/worker-codex/tests/file-backend-codex-worker.test.ts`, `src/store-local-file/tests/local-encrypted-file-store.test.ts` | encrypted store must not contain raw token fields, durable `codex-cache` must not appear |
| Parallel refresh conflicts | `src/worker-codex/tests/file-backend-codex-worker.test.ts`, `src/store-local-file/tests/local-file-lease-store.test.ts` | multiple slots refreshing the same provider session must not corrupt or overwrite generations |
| Local file lock races | `src/store-local-file/tests/local-file-lease-store.test.ts` | expired lock replacement, stale cleanup, not deleting a newer provider lock during cleanup |
| GitHub no-plaintext writeback | `src/store-github-actions-secret/tests/github-actions-secret-store.test.ts` | encrypted writeback request must not contain `refresh_token`, `access_token`, `id_token` or auth JSON |
| Worker pool lifecycle | `src/worker-core/tests/worker-pool.test.ts` | queued work, cancellation, restart, prewarm failure and dispose behavior |
| Queue lifecycle | `src/queue-core/tests/queue-core.test.ts`, `src/queue-bullmq/tests/queue-bull.test.ts` | idempotent enqueue, claim/complete/fail/retry, release after stop, BullMQ envelope behavior |
| Runner boundary | `src/runner-github-action/tests/github-action-runner.test.ts` | redacted stdout/stderr, forbidden auth env rejection, timeout handling |

## Package Deep Dive

### `core` code details

`core` is where the runtime decides whether a requested setup is even legal.
The important code is in `negotiateCapabilities` and
`compileRuntimeExecutionPlan`.

The execution plan is intentionally explicit:

```txt
no-session
  readSession: false
  acquireLease: false
  refresh: never
  writeback: never

static-session
  readSession: true
  refresh: never or validate-only
  writeback: never

rotating-session
  readSession: true
  acquireLease: true
  refresh: before-run or lazy
  writeback: before-task or after-successful-refresh
```

That prevents common integration mistakes:

- a static token provider should not acquire a refresh lease;
- a provider with no session should not require storage;
- a rotating provider should not run without a writeback-capable store;
- no-custody mode should reject stores that expose plaintext to the backend;
- interactive setup is forbidden inside runtime jobs.

`RuntimeKernel.refreshSession` is the critical path. The flow is deliberately
long because each step records a boundary:

1. read the session for `purpose: refresh`;
2. register the raw artifact with the redactor;
3. optionally inspect freshness for lazy refresh;
4. acquire a lease against the restored generation hash;
5. validate the provider session;
6. create an isolated workspace;
7. run provider refresh;
8. classify reconnect, permission and quota states;
9. compute the next generation hash;
10. finalize the lease;
11. mark writeback started;
12. write the new artifact with CAS and idempotency;
13. mark writeback committed;
14. return the refreshed session to the task path.

That sequencing is why `core` has more state than a single SDK call. It is
the difference between "works once" and "does not corrupt auth under retries and
parallel jobs".

### `provider-codex` code details

The Codex provider adapter has three separate jobs:

- understand Codex auth JSON;
- refresh a Codex session safely;
- run a prompt through either app-server or exec.

`validateCodexAuthJsonBytes` checks that the file is not empty, not too large,
valid JSON, `auth_mode: chatgpt`, and contains a non-empty
`tokens.refresh_token`. Freshness is read from `tokens.expiry` and
`last_refresh`, which allows lazy refresh instead of refreshing blindly before
every task.

`CodexCliSessionDriver.refreshSession` writes an isolated temporary
`CODEX_HOME`, runs Codex in a read-only, ephemeral, non-interactive mode, then
reads the refreshed `auth.json` back. It maps known failures into provider
states:

- `needs-reconnect`;
- `quota-limited`;
- `permission-required`;
- unknown failures are thrown so the host does not silently continue.

`CodexAppServerExecutionEngine` is optimized for backend jobs:

- one slot is keyed by `CODEX_HOME`;
- if the session hash changes, the old slot is stopped;
- `thread/start` uses `approvalPolicy: never`;
- sandbox is read-only;
- web search is disabled;
- apps, hooks, memories, multi-agent and shell snapshot are disabled;
- `environments` and `dynamicTools` are empty;
- unsupported server requests receive an explicit JSON-RPC error;
- app-server failure can fall back to packaged `codex exec`;
- abort-like errors do not fallback because the caller requested cancellation.

`CodexWorkerCacheSessionPoolMaterializer` is where speed and safety meet. It
keeps reusable process-local `CODEX_HOME` slots, but serializes access per slot
and releases the slot after the task. The dangerous part is avoided by default:
without a `rootDir`, the cache lives in process-local temp space and is removed
on dispose.

### `worker-codex` code details

`FileBackendCodexWorker` is the main backend integration class.

It builds the runtime like this:

- `createLocalFileBackendRuntimeAdapters` gives it an encrypted session store
  and local file lease store;
- `CodexCliSessionDriver` runs in `lazy-refresh` mode;
- `CodexAppServerExecutionEngine` is the primary execution engine;
- `PackagedCodexJsonExecutionEngine` is fallback;
- `CodexWorkerCacheSessionPoolMaterializer` gives per-worker reusable auth
  materialization;
- `createSubscriptionRuntime` enforces policy before the worker can run.

The important reliability detail is the retry loop in `run`. If a result is
blocked because another worker is refreshing the same session, or because the
session lease is already held, the worker retries with bounded exponential
delay. This is intentionally not infinite. Auth problems must eventually become
clear errors, not a process spinning forever.

### `store-local-file` code details

The local file backend has two parts.

`LocalEncryptedFileStore` persists the session:

- AES-256-GCM;
- 12-byte nonce;
- auth tag;
- encrypted artifact bytes;
- generation;
- generation hash;
- idempotency records;
- atomic temp-file then rename writes;
- hashed filenames based on provider instance ID.

`LocalFileLeaseStore` coordinates refresh:

- active lease file per provider instance;
- record file per lease ID;
- provider lock file with TTL;
- stale lock cleanup guarded by a cleanup lock;
- active lease replacement after expiry;
- finalize/writeback-started/committed transitions;
- idempotent commit replay;
- stale-generation response when commit metadata does not match.

This is more than "write JSON to disk" because the file store is the first
backend production mode. It must be safe enough for one host or a shared POSIX
volume while being honest that it is not a distributed database.

### `store-github-actions-secret` code details

The GitHub Actions store intentionally has a different custody model than
`store-local-file`.

The runner can read a GitHub secret into memory because the job needs it. But
the SaaS backend should not receive the raw refreshed auth JSON. The store
therefore encrypts the refreshed artifact with GitHub's repository public key
and sends an `EncryptedWritebackRequest` containing:

- `leaseId`;
- `providerInstanceId`;
- `idempotencyKey`;
- previous and next generation hashes;
- `encryptedValue`;
- `keyId`;
- artifact metadata.

`assertEncryptedWritebackRequestIsNoCustody` then checks the boundary before the
client sends anything:

- forbidden keys such as `refresh_token`, `access_token`, `id_token`,
  `authJson`, `auth_json`, `session`, `token`;
- forbidden value patterns such as `Bearer ...` and Codex auth JSON fields;
- encrypted value must look like a sufficiently long base64 sealed box.

This is why the GitHub path is separate from the local file store. It has to
preserve writeback semantics without giving the coordinating backend raw
credentials.

### `worker-core`, `queue-core` and `queue-bullmq` code details

`worker-core` solves local concurrency:

- fixed slot count;
- in-memory queue when every slot is busy;
- max queue size;
- abort before a queued task starts;
- prewarm across all slots;
- slot restart;
- health and stats;
- drain on dispose.

`queue-core` solves service-level async lifecycle:

- `enqueue`;
- `claim`;
- `complete`;
- `fail`;
- `release`;
- retry policy;
- delayed retry;
- dead-letter state;
- processor stop with claim release.

`queue-bullmq` is deliberately small because BullMQ should be an adapter, not a
domain dependency. It maps the neutral task envelope to BullMQ `add`, job IDs,
attempts, delay and cleanup options.

The separation matters because an HTTP service can choose:

- direct pool call for a blocking endpoint;
- Redis/BullMQ async processing for bursty workloads;
- another queue adapter later without touching provider code.

### Runner code details

There are two runner styles:

- `GitHubActionRunner` for action workflows;
- `NodeProcessRunner` for backend-local execution.

`GitHubActionRunner` is stricter:

- rejects dangerous env keys before spawn;
- redacts stdout/stderr while streaming;
- redacts captured stdout/stderr in returned results;
- limits captured output;
- normalizes process failures into safe messages.

`NodeProcessRunner` is intentionally smaller because backend Codex execution
uses provider-controlled env pruning and local process management. It still
handles timeout, abort and SIGTERM/SIGKILL cleanup, which matters when a worker
pool is shutting down.

## Validation Surface

The project deliberately uses several kinds of checks because no single test
style catches the whole risk surface.

### Unit and contract tests

These tests cover behavior that should never depend on a real Codex account:

- redaction canaries;
- session state transitions;
- no-session, static-session and rotating-session policy checks;
- stale generation rejection;
- idempotent writeback replay;
- local encrypted file store read/write/delete;
- local file lease acquire/expire/finalize;
- GitHub secret writeback no-plaintext boundary;
- worker pool queueing, cancellation and graceful disposal;
- queue lifecycle with claim, release, complete, fail and retry;
- Codex provider failure classification;
- fallback behavior around app-server and exec paths.

### Packed-consumer checks

The package has to work outside its own source tree. Packed-consumer checks
verify that a real external project can import public subpaths from the built
package:

- `@vioxen/subscription-runtime/core`;
- `@vioxen/subscription-runtime/provider-codex`;
- `@vioxen/subscription-runtime/worker-core`;
- `@vioxen/subscription-runtime/worker-codex`;
- `@vioxen/subscription-runtime/store-local-file`;
- queue and runner modules.

This catches mistakes that normal TypeScript tests inside the repository can
miss, such as missing packaged `dist` files, broken `exports`, or imports that
only work because the source tree is nearby.

### Docker and real-runtime checks

Docker checks are important because the container environment is where process
and filesystem assumptions usually break:

- the Codex binary must be installed and discoverable;
- the child process must resolve `node`;
- the state directory must be writable;
- materialized auth must not remain in durable state;
- Redis/BullMQ queue wiring must work across containers;
- sync HTTP waiting and async queue processing must both complete;
- logs must stay free of token fields.

Real Codex checks are gated because they require a local subscription session,
but they are important for the parts mocks cannot prove:

- app-server can start with the packaged Codex binary;
- a real stateless prompt returns a result;
- multiple slots can run in parallel;
- refresh conflicts are handled instead of silently corrupting state;
- the worker can run through Docker with mounted/bootstrap session state.

### Why benchmarks are treated carefully

Latency numbers depend on:

- selected model;
- reasoning effort;
- prompt size;
- account and provider-side load;
- warm vs cold worker slot;
- app-server vs exec fallback;
- Docker host CPU and memory;
- number of concurrent slots.

For that reason the README does not promise one universal response time. The
runtime instead exposes the mechanisms that influence latency: prewarm,
stateless profile, app-server fast path, clean-thread prewarm, bounded slots and
queue backpressure.

## Operational Constraints That Shaped The API

The public API is intentionally more explicit than a simple `run(prompt)` helper
because production hosts need to make deployment choices.

### Session storage is a host decision

A backend service can choose local encrypted files for a simple deployment. A
larger deployment may later choose Postgres, Redis or another centralized store.
That is why storage is a port and not hardcoded into the Codex provider.

The key distinction:

- provider adapters know how to validate, refresh and run;
- stores know how to persist and coordinate session generations;
- workers know how to combine provider plus store plus execution lifecycle;
- queues know how to schedule and retry work.

### Refresh policy is not provider execution

Refresh is not the same thing as running a task. A valid runtime has to decide:

- whether refresh is required before the task;
- whether validation is enough;
- whether a 401-like failure should trigger a guarded refresh;
- whether the refreshed session must be written back before task execution;
- what to do when another worker already wrote a newer generation.

Keeping this in `core` policy instead of burying it inside `provider-codex`
makes future provider adapters possible.

### Custody model differs by environment

Backend workers and GitHub Actions have different security models:

- backend worker: process can decrypt local session because it owns the job;
- GitHub Actions: runner can read secret, but SaaS backend should not receive
  plaintext provider credentials;
- demo app: should be easy to bootstrap locally without teaching users the full
  GitHub Actions flow;
- ReviewRouter CI: needs no-plaintext writeback and workflow-safe errors.

One storage abstraction with no custody distinction would hide these differences
and make the secure path harder to reason about.

### Queue integration must stay optional

Some consumers want direct `await pool.run(job)`. Others want Redis-backed async
jobs with HTTP polling. The runtime supports both because queueing is a host
architecture choice, not a provider requirement.

This is why:

- `worker-core` has bounded in-process pools;
- `queue-core` defines neutral queue semantics;
- `queue-bullmq` is an adapter, not a required dependency for every consumer;
- the demo can show BullMQ without forcing BullMQ on ReviewRouter or another
  service.

## Security Boundaries

The runtime treats credentials as high-risk data.

Main rules:

- never commit `auth.json`;
- never store plaintext auth in durable backend state;
- never send plaintext provider credentials to the SaaS writeback boundary;
- always redact stdout, stderr, JSON events and safe errors;
- keep provider-specific token fields registered with the redactor;
- use encrypted stores or no-plaintext stores depending on deployment model;
- preserve enough metadata for debugging without preserving secrets.

Security is not one feature here. It is spread across modules:

- `core` defines redaction and safe contracts;
- `provider-codex` registers and redacts Codex token material;
- `store-local-file` encrypts backend session custody;
- `store-github-actions-secret` uses GitHub sealed-box encryption;
- `runner-github-action` redacts process output;
- `worker-codex` prevents durable plaintext materialization;
- tests scan known token fields and fail if they leak through supported
  boundaries.

## Deployment Shapes

### Single-host backend

Recommended first deployment:

- one service host;
- one persistent volume, for example `/var/lib/subscription-runtime`;
- one 32-byte encryption key in env;
- one Redis queue if async jobs are needed;
- N Codex worker slots;
- prewarm enabled.

This is the fastest path for a service such as a match rating backend.

### Multi-replica backend

Multi-replica deployments need a shared custody and lease story:

- shared POSIX volume can work only if the platform provides correct file
  locking and persistence semantics;
- otherwise use a future Postgres or Redis lease/store adapter;
- do not run independent local file stores on multiple hosts for the same
  provider account.

### GitHub Actions

GitHub-hosted CI cannot rely on local persistent files. The intended shape is:

- workflow reads `REVIEWROUTER_CODEX_AUTH_JSON` from GitHub Actions secrets;
- runner refreshes inside CI;
- runner encrypts updated auth JSON for GitHub using the repo public key;
- backend authorizes and coordinates writeback;
- backend never receives plaintext provider credentials.

## Future Provider Expansion

The architecture is designed for more than Codex.

Additional packages can be added as siblings:

- `provider-openrouter`;
- `store-postgres`;
- `store-redis`;
- `runner-kubernetes`;
- another queue adapter.

The rule is that new providers implement `core` ports. They should not add
provider-specific branches inside host applications. A host service should keep
using `worker-core`, queues and stores while swapping provider adapters.

## Packaging And Monorepo Layout

This repository is published as one package with subpath exports, not as many
generated mirror repositories.

That choice keeps consumer setup simple:

```ini
@vioxen:registry=https://npm.pkg.github.com
```

```json
{
  "dependencies": {
    "@vioxen/subscription-runtime": "0.1.0-main.1"
  }
}
```

But it adds packaging constraints:

- every public module needs a stable subpath export;
- `dist` is generated by `npm pack`/publish and shipped only inside the package
  artifact;
- package-lock consumers pin an exact package version and resolved artifact;
- CI and release workflows have to prove the package can be built and packed;
- boundary checks must prevent accidental imports from `core` to concrete
  adapters;
- packed-consumer checks must prove that an external app can import the package
  exactly like a real service would.

Publishing is handled by the `Publish Package` GitHub Actions workflow. It runs
on a published GitHub Release or manual dispatch, builds the package with
`npm pack`, publishes the tarball to GitHub Packages and attaches the same
tarball to the release when a release tag is available.

The key rule is that package boundaries should match architecture boundaries:

```txt
core
  no provider imports
  no queue imports
  no store imports
  no runner imports

provider-codex
  imports core
  owns Codex-specific behavior only

worker-core
  imports core
  owns bounded execution only

worker-codex
  imports core, provider-codex, worker-core, store-local-file
  assembles the backend Codex worker

queue-core
  imports worker-core types only
  owns queue contracts

queue-bullmq
  imports queue-core and BullMQ
  owns Redis/BullMQ integration

stores
  import core
  own custody details

runner-github-action
  imports core
  owns process execution boundaries
```

This is the part that makes the library reusable. A demo app, ReviewRouter and
another backend service can all consume the same package without inheriting each
other's framework or deployment decisions.

## Shortcuts The Design Avoids

Several shorter implementations were intentionally avoided because they tend to
create operational issues later:

- storing Codex `auth.json` directly in a local file next to the worker state;
- refreshing on every request with no lease or generation check;
- running unlimited `codex exec` processes for parallel jobs;
- letting backend code import Codex-specific classes directly everywhere;
- sending refreshed auth JSON to the SaaS backend and letting the backend update
  GitHub secrets;
- treating BullMQ as part of the core runtime model;
- using only happy-path tests with no stale generation or redaction canaries;
- relying only on app-server with no exec fallback;
- making ReviewRouter-specific assumptions inside the standalone package.

Those shortcuts are attractive because they reduce code at first. They become
expensive later when the service has real parallelism, real token rotation,
Docker deployment, multiple consumers and future providers.

## Backend Codex Worker

```ts
import { BoundedSubscriptionWorkerPool } from "@vioxen/subscription-runtime/worker-core";
import { FileBackendCodexWorker } from "@vioxen/subscription-runtime/worker-codex";

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
      model: "gpt-5-codex",
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
[`vioxen/subscription-runtime-demo`](https://github.com/vioxen/subscription-runtime-demo).

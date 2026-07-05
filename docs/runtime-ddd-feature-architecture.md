# Runtime DDD and feature architecture

This document defines the architecture style for complex subscription-runtime
features, especially project-scoped control and policy-controlled integration
rights.

## Decision

Use balanced strict DDD inside Clean Architecture, organized by feature slices.

This means:

- Clean Architecture controls dependency direction.
- DDD names the domain concepts and protects invariants.
- Feature slices keep related domain, use cases, ports, adapters and tests easy
  to find.
- Runtime enforces safety and performs structured operations.
- Higher-level orchestrators decide strategy.

Do not turn subscription-runtime into a project-specific orchestrator. It should
be the reliable runtime, broker and policy enforcement layer.

## Current state

The repository is already feature-sliced at package/module level:

- `worker-core`
- `worker-codex`
- `worker-claude`
- `provider-codex`
- `provider-claude`
- `queue-core`
- `queue-bullmq`
- `account-diagnostics`
- `orchestrator-core`

Inside large modules such as `worker-core`, new complex features should use a
bounded-context slice instead of adding more mixed files to the module root.

## Responsibility split

subscription-runtime owns:

- access-boundary enforcement;
- project-control broker operations;
- sandbox/profile launch plans;
- path, branch, remote, job id and account scope validation;
- locks and one-writer safety;
- audit events;
- provider-neutral result models;
- fail-closed behavior when a provider cannot enforce a boundary.

The orchestrator layer owns:

- worker pool strategy;
- task selection and decomposition;
- review strategy;
- deciding whether a worker result is useful;
- choosing which checks are sufficient for a project;
- deciding whether an integration attempt should proceed.

Project configuration owns:

- allowed branches;
- allowed remotes;
- risky paths;
- ownership/path allowlists;
- required checks per area;
- project-specific review policy.

## Runtime should expose capabilities, not raw authority

LLMs must not get raw authority for dangerous operations. They should receive
structured tools backed by runtime policy.

Good:

```text
projectControl.createWorktree(...)
projectControl.createJob(...)
projectControl.startWorker(...)
projectIntegration.applyWorkerOutput(...)
projectIntegration.runRequiredChecks(...)
projectIntegration.commitApprovedChanges(...)
projectIntegration.pushApprovedCommit(...)
```

Bad:

```text
tmux new-session ...
echo ... > /var/data/worker-jobs/registry/...
git push ...
```

MCP tools and CLI commands are convenience surfaces. The security boundary must
be enforced by application use cases, policy services, provider launch plans and
OS/provider sandboxing.

## Access boundary language

Use the canonical enum from `docs/project-access-boundaries.md`:

```ts
enum AccessBoundary {
  ReadOnly = "read_only",
  IsolatedWorkspaceWrite = "isolated_workspace_write",
  ProjectScopedControl = "project_scoped_control",
  DangerFullAccess = "danger_full_access",
}
```

Important rule: if the selected provider mode cannot enforce the requested
boundary, the launch must fail closed. Do not downgrade silently.

## Bounded contexts

### Worker execution

Purpose: run jobs and normalize their outcomes.

Core concepts:

- `Job`
- `WorkerRun`
- `Attempt`
- `ProviderSession`
- `RuntimeResult`
- `WorkerHeartbeat`

Typical invariants:

- one active writer per workspace;
- attempts have monotonic lifecycle state;
- provider-specific raw results are converted into provider-neutral results.

### Access control

Purpose: decide whether an action is allowed.

Core concepts:

- `AccessBoundary`
- `ProjectAccessScope`
- `WorkerIdentity`
- `CapabilityGrant`
- `PolicyDecision`
- `CommandPolicy`

Typical invariants:

- worker identity is not trusted from user-provided JSON alone;
- project-scoped tools can operate only inside their scope;
- path decisions use normalized and real paths where needed;
- `DangerFullAccess` requires explicit acknowledgement.

### Project control

Purpose: safely coordinate project workers.

Core concepts:

- `ProjectWorkspace`
- `ProjectWorktree`
- `ProjectJob`
- `ControlOperation`
- `ProjectControlAuditEvent`

Typical invariants:

- job ids must match allowed prefixes;
- tmux sessions must match allowed prefixes;
- worktrees must live under allowed worktree roots;
- controller tools cannot create child controllers unless policy explicitly
  allows it.

### Controlled agent

Purpose: safely launch an autonomous LLM controller without giving it raw host
authority.

Core concepts:

- `ControlledAgentSession`
- `ControlledAgentRun`
- `ToolSurfacePolicy`
- `ControlledAgentLaunchPlan`
- `ProviderEnforcementCapabilities`

Typical invariants:

- a controlled controller requires `project_scoped_control`;
- provider tool-surface enforcement is required before launch;
- raw shell, raw git, raw tmux, direct registry writes, auth roots and Docker
  sockets are not controller capabilities;
- deny rules are defense-in-depth, not proof that raw shell is disabled;
- launch fails closed when provider enforcement is incomplete.

### Project integration

Purpose: safely integrate reviewed worker output.

Core concepts:

- `WorkerOutput`
- `ReviewDecision`
- `IntegrationAttempt`
- `CheckRun`
- `CommitCandidate`
- `PushAttempt`

Typical invariants:

- no push without passing required checks;
- no commit with unrelated dirty files;
- no patch outside ownership/path allowlists;
- no force push unless explicitly allowed;
- failed checks reject or pause the integration attempt;
- every integration decision emits audit events.

### Account capacity

Purpose: manage provider account availability.

Core concepts:

- `ProviderAccount`
- `AccountLease`
- `CapacitySignal`
- `QuotaWindow`

Typical invariants:

- account leasing must avoid avoidable collisions;
- exhausted accounts should not be selected until capacity changes;
- auth payloads and tokens are never logged.

### Observability

Purpose: make runtime state inspectable without leaking secrets.

Core concepts:

- `RunEvent`
- `AuditEvent`
- `StatusSnapshot`
- `ObservationHistory`

Typical invariants:

- events are provider-neutral where possible;
- raw provider payloads are not persisted or printed;
- audit includes decision metadata but not secrets.

## Feature-slice layout

For simple modules, keep the current flat structure. For complex bounded
contexts, use a vertical feature slice.

Target shape for project integration:

```text
src/worker-core/integration/
  domain/
    integration-attempt.ts
    integration-policy.ts
    integration-events.ts
    integration-errors.ts
  application/
    open-integration-attempt.ts
    apply-worker-output.ts
    run-required-checks.ts
    commit-approved-changes.ts
    push-approved-commit.ts
    reject-integration-attempt.ts
  ports/
    git-port.ts
    check-runner-port.ts
    secret-scanner-port.ts
    integration-audit-port.ts
  adapters/
    git-cli-adapter.ts
    local-check-runner-adapter.ts
  tests/
    integration-policy.test.ts
    apply-worker-output.test.ts
    push-approved-commit.test.ts
```

Do not create one tiny file per primitive. Keep closely related domain types in
the same file until the file becomes hard to review.

Suggested thresholds:

- under 500 lines: keep cohesive;
- 500-800 lines: consider splitting by domain responsibility;
- above 1000 lines: split unless there is a strong reason not to.

## Dependency rules

Allowed:

```text
application -> domain
application -> ports
adapters -> ports
adapters -> domain DTOs/value objects
MCP/CLI -> application use cases
provider modules -> worker-core/core contracts
```

Forbidden:

```text
domain -> adapters
domain -> CLI/MCP/tmux/git/filesystem
worker-core -> provider-codex/provider-claude implementation details
application -> raw process spawning without a port
orchestrator strategy -> provider adapter internals
```

## Integration rights feature plan

The merge-rights feature should not be implemented as a single auto-merge
script. It should be implemented as project integration capabilities.

Current implementation status: the core `worker-core/integration` bounded
context owns the domain model, ports and application use cases for the
integration lifecycle. `store-local-file` provides
`LocalIntegrationAttemptStore` for restart-safe attempt snapshots and audit
event logs. `worker-local` provides local Git/check/secret-scan/workspace-lock
adapters for real sandbox repositories. `worker-codex` exposes structured MCP
tools for the integration attempt lifecycle. CLI wrappers and live provider e2e
coverage should be added without duplicating policy logic in handlers.
`scripts/e2e-live-workers/run.mjs --only="codex project integration lifecycle tools"`
exercises the structured tools through the built CLI against a sandbox git
repository and verifies that an unapproved remote push is denied before the
approved push succeeds.

### Phase 1: domain model

Add the project integration bounded context.

Domain types:

- `IntegrationAttempt`
- `WorkerOutput`
- `ReviewDecision`
- `CheckRun`
- `CommitCandidate`
- `PushAttempt`
- `IntegrationPolicy`

Rules:

- an attempt starts from reviewed worker output;
- patch application must declare expected files;
- checks must be tied to the attempt;
- commit candidate can be created only from clean expected changes;
- push can happen only for approved commit candidates.

### Phase 2: policy and ports

Add small ports:

- `GitPort`
- `PatchPort`
- `CheckRunnerPort`
- `SecretScannerPort`
- `IntegrationAuditPort`
- `WorkspaceLockPort`

Current local persistence adapter:

- `LocalIntegrationAttemptStore` persists each attempt under
  `integration-attempts/<sha256(attemptId)>/attempt.json`;
- audit events append to `events.jsonl` in the same attempt directory;
- attempt ids are hashed before use as path segments, so ids such as `../x`
  cannot escape the store root.

Current local execution adapters:

- `LocalGitIntegrationAdapter` uses `execFile("git", args)` without shell
  interpolation, applies worker commits or patch files, runs `diff --check`,
  creates commits and pushes explicit `HEAD:<branch>` refs;
- `LocalProjectCheckRunner` runs declared check command arrays with cwd
  canonicalized inside the workspace and redacted output tails;
- `SimpleSecretScanner` scans approved files with pluggable patterns and fails
  closed on unreadable existing files;
- `LocalWorkspaceIntegrationLock` adapts the existing local file workspace lock
  store for integration attempts.

Policy must validate:

- branch allowlist;
- remote allowlist;
- path allowlist;
- risky path mode;
- force-push mode;
- clean workspace requirement;
- required checks;
- secret scan result.

### Phase 3: application use cases

Implement focused use cases:

- `OpenIntegrationAttempt`
- `ApplyWorkerOutput`
- `RunRequiredChecks`
- `CommitApprovedChanges`
- `PushApprovedCommit`
- `RejectIntegrationAttempt`

Each use case must:

- ask policy first;
- acquire the required lock;
- emit audit events;
- fail closed on ambiguity;
- avoid raw provider assumptions.

### Phase 4: LLM-facing tools

Expose structured MCP/CLI tools only after the use cases are tested.

Suggested tool names:

- `codex_goal_project_open_integration_attempt`
- `codex_goal_project_apply_worker_output`
- `codex_goal_project_run_required_checks`
- `codex_goal_project_commit_approved_changes`
- `codex_goal_project_push_approved_commit`
- `codex_goal_project_reject_integration_attempt`

Tool handlers should be thin adapters. They must not duplicate policy logic.

Current Codex MCP tools:

- `codex_goal_project_open_integration_attempt`
- `codex_goal_project_apply_worker_output`
- `codex_goal_project_run_required_checks`
- `codex_goal_project_commit_approved_changes`
- `codex_goal_project_push_approved_commit`
- `codex_goal_project_reject_integration_attempt`

Each write step requires an explicit confirmation flag and delegates to
`worker-core/integration` use cases.

### Phase 4.5: controlled-agent lifecycle

`worker-core/controlled-agent` owns the provider-neutral lifecycle for a live
broker-only LLM controller:

- `ControlledAgentSession`: long-lived controller identity, project scope and
  effective tool surface;
- `ControlledAgentRun`: one concrete provider run/process/thread for that
  session;
- `ToolSurfacePolicy`: exact broker/status tool allow-list and denied raw
  capabilities;
- `ProviderEnforcementCapabilities`: the adapter's claim about what it can
  physically enforce;
- `ControlledAgentLaunchPlan`: ready/blocked decision with evidence.

Application use cases own state transitions:

- build launch plan;
- start run;
- read status;
- stop run;
- reconcile run after provider crash, host reboot or stale persisted state.

Adapters own persistence and provider execution. A start tool must not persist
`running` unless the provider runner actually started a controlled LLM surface.
For Codex, the provider runner starts app-server with native environments
disabled and a generated broker-only `CODEX_HOME`. It reads auth only host-side
from the controller's scoped auth root. If persisted state is later observed
from a process that does not own the provider instance, return
`controlled_agent_provider_runner_not_connected` and keep orchestration in the
owning process or host boss/supervisor.

For Claude, the controlled provider uses the same lifecycle with strict MCP
config, a broker/status MCP `allowedTools` allow-list and raw host tools in
`disallowedTools` as defense in depth. It must still fail closed when a valid
Claude session artifact is unavailable; `danger_full_access` is not a fallback
for missing Claude auth.

### Phase 5: provider launch enforcement

For Codex:

- use app-server approval requests and command rules for defense-in-depth;
- deny direct `git push`, `tmux`, registry writes and auth-root reads for
  non-broker workers;
- use project-control tools for brokered operations.

For Claude Code:

- use permissions/sandbox settings where available;
- prefer OS/container boundaries for reliable enforcement;
- deny raw project-control operations outside broker tools.

If a provider cannot enforce the requested access boundary, do not start the
worker.

### Phase 6: tests and e2e

Required tests:

- domain state-transition tests;
- policy allow/deny tests;
- path traversal and symlink escape tests;
- wrong branch/remote/job prefix tests;
- dirty workspace rejection tests;
- failed check rejection tests;
- secret scan rejection tests;
- live Codex project controller integration e2e;
- live bypass attempt e2e where raw dangerous commands are rejected.

Current e2e coverage:

- `codex project integration lifecycle tools` runs open/apply/check/commit/push
  through `subscription-runtime-codex-goal tool ...` on a sandbox repository;
- the same scenario checks that `push_approved_commit` rejects an unapproved
  remote before pushing the approved commit;
- `codex command policy rejects project bypass` builds a project-scoped Codex
  launch plan from `dist` and proves raw `git push`, raw `tmux`, inline code and
  direct registry path access are denied before a runner executes them;
- `codex project controller manifest liveness contract` creates a
  `project_scoped_control` manifest through the built CLI, proves ordinary
  controller worker startup fails closed without a broker-only LLM surface, and
  proves brokered child worktree/job creation still works from the same
  manifest;
- `codex real app-server command approval denies raw push`, when live Codex
  accounts are enabled, requires real raw-push blocking evidence. The scenario
  first proves that the sandboxed raw `git push` did not update the sandbox
  remote, then runs an unsandboxed control push to prove the remote itself was
  writable;
- `codex project controller starts real child worker`, when live Codex accounts
  are enabled, now carries the child marker output through the integration
  lifecycle and pushes the approved commit to a sandbox bare remote.

Current app-server enforcement status:

- Codex `app-server` / `app-server-goal` command approvals are routed through a
  provider callback when a runtime command policy is configured. Dangerous
  approval requests are denied before the app-server receives approval;
- Codex `app-server` / `app-server-goal` turns receive a strict sandbox policy:
  `workspaceWrite` allows writes only to the active workspace root, disables
  network access and excludes `/tmp` / `TMPDIR` from writable roots;
- provider-side file-change grants and permission expansion requests are denied
  fail-closed;
- the deterministic runner bypass test and fake app-server approval tests prove
  the runtime path. The live raw-push app-server scenario is the external proof
  that a real Codex turn cannot update an out-of-workspace git remote through a
  raw `git push`; it may skip when live Codex accounts are quota-limited or
  unavailable.

Optional later:

- live Claude Code controller e2e;
- container-level integration test for OS-enforced mounts.

## Edge cases checklist

The implementation must explicitly handle:

- LLM tries raw `git push`;
- LLM tries raw `tmux`;
- LLM writes directly to registry;
- LLM reads auth files;
- LLM passes a sibling path with a similar prefix;
- LLM uses `..` traversal;
- LLM uses symlink escape;
- child job spoofs a controller job id;
- child job requests `project_scoped_control` or `danger_full_access`;
- child job uses an unapproved account id;
- patch modifies files outside ownership boundary;
- patch leaves dirty unrelated files;
- checks pass but secret scan fails;
- push target branch is not allowed;
- remote is not allowed;
- force push is requested;
- lock exists but owner process is stale;
- provider sandbox cannot enforce the launch plan;
- another project runs on the same host.

## Anti-patterns

Avoid:

- parsing arbitrary shell as the primary safety mechanism;
- letting LLM choose raw `git`/`tmux` commands for dangerous operations;
- storing project-specific review strategy in subscription-runtime;
- creating a generic `autoMergeEverything` use case;
- mixing provider-specific code into domain/application layers;
- logging raw provider payloads or auth material;
- silently falling back to weaker boundaries.

## Definition of done for integration rights

A project-scoped controller can be allowed to integrate worker output only when:

- it has a tight `ProjectAccessScope`;
- it cannot access raw host authority needed to bypass broker policy;
- integration operations are exposed through structured tools;
- all use cases have policy tests;
- bypass attempts are covered by tests;
- live e2e proves controller-to-child and controller-to-integration flow;
- docs explain the boundary clearly enough for future agents.

## Summary

Use DDD where the runtime has real lifecycle and invariants. Use feature slices
where a bounded context becomes large enough to need locality. Keep strategy in
the orchestrator layer and enforcement in subscription-runtime.

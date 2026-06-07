# Pluggable Agent Runtime Architecture

Status: proposed

This document defines how `subscription-runtime` should grow from a
Codex-focused task runtime into a provider-neutral runtime for Claude, Codex and
future agents without turning host applications into provider glue.

## Decision

`subscription-runtime/core` is the canonical public contract. New agents plug in
as provider modules such as `provider-claude` and `provider-codex`.

The current `claude-runtime` code should not remain a second public runtime
domain. Its useful Claude BG implementation should be moved or wrapped inside
`provider-claude`, where Claude BG `start`, `observe`, `collect`, `remove` and
`rehydrate` are implementation details behind the public task contract.

Do not create a package-level bridge like:

```txt
subscription-runtime AgentDriver -> claude-runtime AgentRuntimeProvider
```

That keeps two models of sessions, runs, failures, stores and cleanup alive. It
also makes host applications depend on a Claude-shaped lifecycle even when they
only need a task result.

## Core Shape

Keep the default public use case task-shaped:

```ts
runtime.refreshThenRunTask({
  providerInstanceId,
  task,
  runContext,
});
```

Add richer provider-neutral task metadata before wiring reviewer and tribunal:

```ts
export type AgentUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
};

export type AgentCost = {
  readonly amount: number;
  readonly currency: "USD";
};

export type AgentToolCall = {
  readonly id?: string;
  readonly name: string;
  readonly status?: "started" | "completed" | "failed" | "denied";
  readonly safeInputPreview?: string;
};

export type ProviderTaskControls = {
  readonly model?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly permissionMode?: "read-only" | "allow-edits" | "bypass" | "none";
  readonly responseFormat?: "text" | "json";
  readonly outputSchemaName?: string;
};

export type ProviderTaskTelemetry = {
  readonly providerRunId?: string;
  readonly providerSessionId?: string;
  readonly durationMs?: number;
  readonly turns?: number;
  readonly usage?: AgentUsage;
  readonly cost?: AgentCost;
  readonly toolCalls?: readonly AgentToolCall[];
  readonly finishReason?:
    | "completed"
    | "max_turns"
    | "cancelled"
    | "timeout"
    | "provider_error";
};
```

Then evolve `ProviderTask` and `ProviderTaskResult` without provider fields:

```ts
export type ProviderTask = {
  readonly kind: ProviderTaskKind;
  readonly prompt: string;
  readonly outputSchemaName?: string; // legacy compatibility during migration
  readonly controls?: ProviderTaskControls;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type ProviderTaskResult =
  | {
      readonly status: "completed";
      readonly outputText: string;
      readonly structuredOutput?: unknown;
      readonly telemetry?: ProviderTaskTelemetry;
      readonly warnings: readonly RuntimeWarning[];
    }
  | {
      readonly status: "failed";
      readonly failure: ProviderFailure;
      readonly telemetry?: ProviderTaskTelemetry;
      readonly warnings: readonly RuntimeWarning[];
    };
```

This keeps the contract useful for reviewer and tribunal while still allowing
simple completion agents to ignore optional fields.

Streaming agents should emit provider-neutral task events, not SDK-specific
messages:

```ts
export type ProviderTaskEvent =
  | { readonly type: "started"; readonly occurredAt: Date }
  | {
      readonly type: "text_delta";
      readonly occurredAt: Date;
      readonly text: string;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: "tool_call";
      readonly occurredAt: Date;
      readonly toolCall: AgentToolCall;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: "usage";
      readonly occurredAt: Date;
      readonly usage: AgentUsage;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: "warning";
      readonly occurredAt: Date;
      readonly warning: RuntimeWarning;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: "completed";
      readonly occurredAt: Date;
      readonly result: ProviderTaskResult;
      readonly telemetry?: ProviderTaskTelemetry;
    };
```

## Port Split

Use Interface Segregation. Do not force every agent to implement the richest
lifecycle.

### Required Port: AgentDriver

The existing task port remains the stable surface:

```ts
export interface AgentDriver {
  readonly agentId: string;
  readonly providerId: string;
  readonly capabilities: AgentCapabilities;

  runTask(input: AgentTaskInput): Promise<ProviderTaskResult>;
  classifyRunFailure(error: unknown): ProviderFailure;
}
```

Codex JSON, Claude task mode, future API-backed LLMs and local model adapters
can all implement this.

### Optional Port: StreamingAgentDriver

Only add this when a host needs live progress, not just final results:

```ts
export interface StreamingAgentDriver extends AgentDriver {
  streamTask(input: AgentTaskInput): AsyncIterable<ProviderTaskEvent>;
}
```

Reviewer can use this later for heartbeat and log visibility, but the first
Claude integration can collect stream events internally and return telemetry.

### Optional Port: ManagedAgentDriver

Only promote long-lived lifecycle into `core` when at least two providers or one
product workflow need attach, resume or durable run rehydration.

```ts
export interface ManagedAgentDriver {
  startRun(input: ManagedRunStartInput): Promise<AgentRunHandle>;
  sendToRun(input: ManagedRunSendInput): Promise<AgentRunHandle>;
  observeRun(handle: AgentRunHandle): AsyncIterable<ProviderTaskEvent>;
  collectRun(handle: AgentRunHandle): Promise<ProviderTaskResult>;
  stopRun(handle: AgentRunHandle): Promise<void>;
  removeRun(handle: AgentRunHandle): Promise<RemoveRunResult>;
  rehydrateRun?(input: RehydrateRunInput): Promise<AgentRunStatus>;
}
```

Do not add this only because Claude BG has it. Add it when the public product
contract has it.

## Provider Modules

### provider-claude

Initial implementation should expose:

- `ClaudeSessionDriver`, if Claude subscription auth is stored as an artifact.
- `ClaudeTaskAgentDriver implements AgentDriver`.
- `ClaudeTaskExecutionEngine`, provider-facing engine port.
- `ClaudeRuntimeTaskExecutionEngine`, optional concrete bridge to
  `claude-runtime`.
- `ClaudeAuthEnvBuilder`, internal or provider-exported as unstable.
- `ClaudeFailureClassifier`.
- `claudeProviderManifest`.

The task driver can internally run:

```txt
preflight -> start -> observe until terminal -> collect -> remove
```

For a host, that is still one task. The host should not know about Claude daemon
short ids, transcript offsets, or cleanup retry state.

`ClaudeRuntimeTaskExecutionEngine` is loaded only by consumers that choose it.
The package does not declare a hard dependency on `claude-runtime`; the
composition root installs it and provides a Claude session artifact with
`configDir`. This keeps `subscription-runtime` provider-neutral while still
offering a ready bridge for Claude live tests.

The combined Claude task driver implements `StreamingAgentDriver` as well as
`AgentDriver`. Streaming events are still provider-neutral `ProviderTaskEvent`
values: text deltas, tool calls with redacted safe input, usage updates,
warnings and final task completion. Claude daemon ids, transcript offsets and
raw SDK payloads remain private.

### provider-codex

Keep Codex as task-first:

- `CodexJsonAgentDriver` for structured task execution.
- Optional app-server fast path stays provider-internal.
- No need to implement managed lifecycle until Codex exposes a durable provider
thread that product actually wants.

### Future Providers

New providers should be classified by capabilities, not by provider name:

- session mode: none, static, rotating.
- history mode: none, host-managed-thread, provider-thread.
- execution mode: process, app-server, remote HTTP, browser profile, container.
- tool mode: no tools, read-only tools, write tools, MCP tools.
- workspace mode: no workspace, read-only checkout, writable checkout,
  isolated temp workspace.
- output mode: text, json, schema-enforced json, provider events.

Host applications choose by capability and policy, not by `if provider ===`.

## Reviewer Contract

The PR reviewer should depend on a small host-owned port:

```ts
export interface ReviewAgent {
  runReviewTask(input: {
    readonly prRef: string;
    readonly cwd: string;
    readonly reviewModePrompt?: string;
    readonly cancelSignal: AbortSignal;
    readonly providerInstanceId: string;
  }): Promise<ReviewResult>;
}
```

Implementation can use `subscription-runtime.refreshThenRunTask`.

Reviewer must not know whether Claude is SDK, Claude BG, Codex, or a remote
worker. It may only depend on:

- final text.
- verdict extraction.
- turns and heartbeat telemetry.
- cost and usage telemetry.
- provider session id or run id for diagnostics.
- safe tool call telemetry for Memora tracking.

This removes the current global `process.env.CLAUDE_CODE_OAUTH_TOKEN` race and
keeps token selection inside provider/session custody.

## Tribunal Contract

Tribunal should depend on round members, not direct SDK calls:

```ts
export type RoundMemberSpec = {
  readonly id: string;
  readonly role:
    | "analyst"
    | "advocate"
    | "critic"
    | "contrarian"
    | "arbiter"
    | "independent-verifier";
  readonly adapterId: string;
  readonly providerInstanceId: string;
  readonly model?: string;
  readonly controls?: ProviderTaskControls;
  readonly independenceGroup?: string;
};

export interface RoundMemberAdapter {
  runRound(input: {
    readonly spec: RoundMemberSpec;
    readonly prompt: string;
    readonly schemaName: string;
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderTaskResult>;
}
```

Mark's reviewer requirement maps naturally to `independenceGroup`, but the
runtime and the strict reviewer policy are separate layers:

- The runtime can execute any configured member plan, including same-provider
  debates for products that explicitly want that behavior.
- The PR reviewer strict `hypertribunal-codex` policy should require the
  adversarial `critic` and effective `advocate` members to use distinct
  provider/model identities. If both declare `independenceGroup`, those groups
  must also be distinct.
- `hyper-codex` should be a Codex member, not a Claude prompt pretending to be
  Codex.
- Divergence checks should compare outputs from different provider/model
  groups, not only different prompts.

The orchestrator should be configured with a member plan, for example:

```json
{
  "members": [
    { "id": "advocate", "adapterId": "provider.claude-bg", "model": "sonnet", "independenceGroup": "anthropic" },
    { "id": "critic", "adapterId": "provider.codex-cli", "model": "gpt-5-codex", "independenceGroup": "openai-codex" },
    { "id": "hyper-codex", "adapterId": "provider.codex-cli", "model": "gpt-5-codex", "independenceGroup": "openai-codex" },
    { "id": "arbiter", "adapterId": "provider.claude-bg", "model": "opus", "independenceGroup": "anthropic" }
  ]
}
```

## Edge Cases

### Session and Custody

- Provider has no session, for API-key or remote service mode.
- Provider has static env token and must not write back.
- Provider has rotating OAuth session and must use CAS plus idempotency.
- Provider stores a directory, not a json file.
- Provider refresh says unchanged, but task still reports auth expired.
- Refresh succeeds, writeback fails, task must not run with a session that cannot
  be durably recovered if policy requires writeback before task.
- Multiple workers refresh the same provider instance.
- A stale generation must never overwrite a newer session.
- Secret bytes must be registered with redactor before validation, refresh, task
  execution and failure logging.

### Execution

- Provider binary missing or wrong version.
- Provider CLI changes output format.
- Provider returns non-zero exit with useful stderr.
- Provider writes valid progress events followed by invalid final output.
- Provider returns text around JSON.
- Provider exceeds max output bytes.
- Provider hits max turns.
- Provider blocks on a permission prompt.
- Abort fires while a child process is running.
- Timeout fires after final comment/tool side effect started.
- Cleanup/remove fails after a terminal result.
- Rehydration sees a run that disappeared from provider state.
- Provider stream emits tool calls whose input may contain secrets.

### Tools and Workspace

- Read-only review task must not get write tools.
- Code-editing agent may require writable workspace.
- MCP servers must receive explicit env, not broad inherited env.
- Tool telemetry must not include raw command output unless redacted.
- GitHub write actions should stay host-owned, not provider-owned, unless the
  task explicitly permits them.
- A provider that cannot enforce tool restrictions must declare that honestly.

### Multi-Agent Tribunal

- Two roles use the same provider account and hit rate limits.
- Two roles share the same model, weakening adversarial independence.
- One round fails parse, but later rounds can still proceed with degraded
  context.
- One provider is quota-limited and another can still run independent
  verification.
- Arbiter must know which findings came from which independence group.
- Structured schemas differ by role and should not be provider-specific.
- Cost tracking must aggregate by member, provider and model.

### Result Semantics

- `completed` means the provider produced an output, not that the review verdict
  was parseable.
- Missing verdict is a domain failure in reviewer, not automatically a provider
  runtime failure.
- Invalid JSON for a schema task should be classified as
  `provider_output_invalid`.
- Runtime cancellation should be classified as `task_cancelled`.
- Runtime timeout should be classified as `task_timeout`.
- Cost and usage may be unavailable and must remain optional.
- Provider run id is diagnostic metadata, not a stable business identifier.

## Capability Rules

Extend `AgentCapabilities` conservatively:

```ts
export type AgentExecutionMode = "task" | "streaming-task" | "managed-run";

export type ToolPolicyMode =
  | "none"
  | "provider-enforced"
  | "host-filtered"
  | "unsupported";

export type OutputMode = "text" | "json" | "schema-json";
```

Recommended additions:

- `executionModes: readonly AgentExecutionMode[]`
- `toolPolicyMode: ToolPolicyMode`
- `outputModes: readonly OutputMode[]`
- `supportsUsageTelemetry: boolean`
- `supportsCostTelemetry: boolean`
- `supportsProviderRunId: boolean`
- `supportsAbort: boolean`
- `supportsCleanup: boolean`

Do not replace the existing booleans immediately. Add new fields in a backwards
compatible way, migrate providers, then tighten adapter certification.

## Migration Plan

### Phase 1: Contract Hardening

- Add `ProviderTaskControls` and `ProviderTaskTelemetry`.
- Add contract tests for telemetry, abort, output redaction and invalid output.
- Keep existing Codex adapter behavior working.

### Phase 2: provider-claude

- Move useful Claude BG infrastructure into `provider-claude`.
- Implement `ClaudeTaskAgentDriver implements AgentDriver`.
- Internally use Claude BG lifecycle through an injectable execution engine.
- Provide `ClaudeRuntimeTaskExecutionEngine` as the default concrete
  `claude-runtime` bridge for real Claude runs.
- Return task telemetry and provider-neutral streaming events from Claude
  stream events.
- Add tests with fake Claude runner and transcript reader.

### Phase 3: Reviewer Integration

- Add a reviewer-side `ReviewAgent` port.
- Implement `SubscriptionRuntimeReviewAgent`.
- Replace direct Agent SDK call in reviewer with that port.
- Preserve verdict extraction, Memora tracking, turns, cost, timeout and cancel
  semantics.

### Phase 4: Tribunal Round Members

- Replace direct `callAnthropic` calls with `RoundMemberAdapter`.
- Add member config for Claude and Codex.
- Run true Codex for `hyper-codex`.
- Add test proving `hyper-codex` uses a different provider or independence group
  from Claude roles.

### Phase 5: Optional Managed Runs

Only if needed, promote managed lifecycle into `core`:

- `ManagedAgentDriver`.
- `RunStorePort`.
- rehydration and cleanup contracts.
- worker support for long-lived runs.

Do this after task-mode Claude is stable, unless a product requirement needs
attach/resume immediately.

## Adapter Certification Additions

Every new agent adapter should prove:

- It does not inherit broad host env.
- It redacts stdout, stderr, thrown errors, stream events and telemetry.
- It classifies reconnect, quota, permission, invalid output, timeout, abort and
  unknown runtime failure.
- It releases materialized sessions and temp workspaces on success, failure and
  abort.
- It preserves provider run diagnostics without leaking provider secrets.
- It declares if tool policy is provider-enforced, host-filtered or unsupported.
- It has a fake-runner test for output format drift.
- It has an abort test that proves no orphaned task result is returned as
  success after cancellation.

## Non-Goals

- Do not make reviewer depend on Claude BG run handles.
- Do not put Claude-specific fields in `core`.
- Do not make every provider implement attach or rehydrate.
- Do not encode tribunal roles inside `subscription-runtime/core`.
- Do not use `metadata` as the long-term place for typed controls.

## Implementation Preference

Preferred path:

1. Harden task contracts.
2. Implement `provider-claude` as a task adapter using Claude BG internally.
3. Move reviewer onto the task port.
4. Move tribunal onto round member adapters.
5. Promote managed lifecycle only when it becomes a product contract.

This keeps the architecture open for future providers while avoiding premature
public lifecycle surface area.

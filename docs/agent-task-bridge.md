# Agent Task Bridge

Status: implemented

`@vioxen/subscription-runtime/agent-task` is the app-facing adapter kit for
systems that need to call a subscription-runtime worker without importing a
provider, worker, queue, store or runner implementation.

Use it for `qa-rig`, `hib-pr-reviewer` and control-layer apps when the host app
owns orchestration and wants a small JSON contract:

```txt
app adapter -> agent-task JSON bridge -> subscription-runtime provider/worker
```

The adapter layer must stay provider-neutral. Claude, Codex and future agents are
selected outside this package boundary through runtime configuration and
provider instance ids.

## Public Entry Points

```ts
import {
  createAgentTaskRequest,
  runAgentTaskBridge,
  streamAgentTaskBridge,
  assertAgentTaskCertification,
} from "@vioxen/subscription-runtime/agent-task";
```

The package exposes two CLIs.

Handler bridge, for apps that already have a JS/TS handler:

```sh
subscription-runtime-agent-task --handler ./handler.mjs --input request.json
```

CLI output defaults to event NDJSON. Use `--format result-json` when the caller
only needs the terminal result.

Provider worker bridge, for apps that cannot import TypeScript runtime code
directly, e.g. Python `qa-rig`:

```sh
subscription-runtime-run-agent-task \
  --provider claude \
  --state-root /var/lib/subscription-runtime \
  --input request.json
```

This CLI reads the same `AgentTaskRequest` JSON, runs it through
`worker-claude` or `worker-codex`, and writes the same result/event protocol.
Durable mode requires `SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY` plus provider
credentials such as `CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_AUTH_JSON_PATH`.
`--ephemeral` is available for sandbox tests where the caller supplies a fresh
provider credential and does not need durable session state.

## Request Shape

```ts
const request = createAgentTaskRequest({
  runId: "review-123",
  providerInstanceId: "claude:account-a",
  cwd: "/workspace/repo",
  timeoutMs: 120_000,
  task: {
    kind: "review",
    prompt: "Review this diff.",
    controls: {
      model: "claude-sonnet",
      permissionMode: "read-only",
      responseFormat: "json",
    },
    metadata: {
      app: "hib-pr-reviewer",
    },
  },
  context: {
    application: "hib-pr-reviewer",
    purpose: "pull-request-review",
    correlationId: "gh-pr-24",
    round: {
      roundId: "tribunal-24-r2",
      roundIndex: 2,
      totalRounds: 5,
      member: {
        id: "critic-codex",
        adapterId: "subscription-runtime-codex",
        agentType: "critic",
        provider: "openai",
        model: "gpt-5.5",
        independenceGroup: "openai:gpt-5.5",
      },
      adversaryOf: {
        id: "advocate-claude",
        adapterId: "subscription-runtime-claude",
        agentType: "advocate",
        provider: "anthropic",
        model: "sonnet",
        independenceGroup: "anthropic:sonnet",
      },
    },
  },
});
```

Requests, results and events are JSON-safe and versioned with
`protocolVersion: 1`. The bridge accepts provider-native task results/events and
normalizes them to agent-task JSON.

`context.round.member` is the portable identity for tribunal/quorum/adversarial
rounds. The runtime does not decide policy from it, but certification can prove
that a round member is independent from its adversarial counterpart by checking
both provider/model and `independenceGroup`.

## Handler Contract

A handler module can export `runAgentTask`, `handler`, `default`, `runTask` or
`streamTask`.

```ts
export async function runAgentTask(request, context) {
  await context.emit({
    protocolVersion: 1,
    type: "text_delta",
    occurredAt: new Date().toISOString(),
    text: "working",
  });

  return {
    protocolVersion: 1,
    status: "completed",
    outputText: "done",
    warnings: [],
  };
}
```

For streaming adapters, prefer `streamAgentTaskBridge` so the host can consume
events before the terminal result is available.

## Certification

Use certification in adapter tests before connecting a host app:

```ts
assertAgentTaskCertification({
  request,
  result,
  events,
  forbiddenSecrets: [process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ""],
  requireRoundMemberIdentity: true,
  requireRoundMemberIndependence: true,
  requireTerminalEvent: true,
});
```

Certification checks protocol validity, completed-event consistency, event
ordering, optional round-member independence and output secret redaction. It
intentionally does not scan the request body because prompts can contain
sensitive review evidence by design.

## Boundary Rule

Apps using this bridge should import `@vioxen/subscription-runtime/agent-task`
or a host-local adapter wrapper. They should not import:

- `@vioxen/subscription-runtime/provider-*`
- `@vioxen/subscription-runtime/worker-*`
- `@vioxen/subscription-runtime/queue-*`
- `@vioxen/subscription-runtime/store-*`
- `@vioxen/subscription-runtime/runner-*`

Provider selection belongs in runtime wiring, not in app review logic.

For the cross-repository rollout plan, see
`docs/host-app-integration-strategy.md`.

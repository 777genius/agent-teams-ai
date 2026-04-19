# Codex Native Runtime Integration Decision

**Status**: Decision  
**Date**: 2026-04-19  
**Owner repos**:

- `claude_team`
- `agent_teams_orchestrator`
- `plugin-kit-ai`

## Purpose

Record the chosen direction for improving Codex integration in the multimodel runtime without losing native Codex capabilities such as plugins, skills, and MCP.

## Chosen Plan Assessment

- Chosen plan: normalized internal event/log layer plus staged `Codex-native` backend lane
- Assessment: `🎯 9   🛡️ 9   🧠 7`
- Estimated first serious wave: `2200-4500` lines across `agent_teams_orchestrator`, `claude_team`, and `plugin-kit-ai`

## Current Reality

Today, `Codex` inside our multimodel runtime is **not** executed through the real Codex runtime.

Instead, the current path is:

- `claude_team`
- `agent_teams_orchestrator`
- internal Codex backend
- OpenAI Responses API

In practice this means:

- the orchestrator keeps Anthropic-style streaming semantics
- `Codex` is treated as a model backend, not as a native runtime
- native Codex plugins are not honestly end-to-end supported
- current `Codex` capability support is limited by our adapter, not by the real Codex runtime

## What We Learned

After deep code and docs analysis, the most important conclusions are:

1. `@openai/codex-sdk` and `codex exec --json` are the real official execution seam for embedded Codex runtime usage.
2. `codex exec` supports API-key mode, so API-key mode itself is not the blocker.
3. `Codex` native plugins, apps, skills, and MCP are part of the real Codex runtime flow.
4. Our current `agent_teams_orchestrator` query loop is deeply coupled to Anthropic-style events and tool semantics.
5. A full drop-in swap from the current Codex adapter to `@openai/codex-sdk / codex exec` would not be a safe transport-only change. It would change runtime semantics.
6. `plugin-kit-ai` is a good fit for plugin management and native plugin placement.
7. `codex app-server` is promising for richer control-plane features, but should not be the foundation of the first production rollout for plugin management.

## Chosen Direction

We will **not** force Codex into the current Anthropic-shaped runtime contract.

We will instead:

- add a new **internal normalized event/log layer**
- keep execution semantics provider-native where needed
- add a separate **Codex-native runtime lane**
- use `plugin-kit-ai` for plugin management and native plugin placement

In practical terms:

- current Codex path stays available as the fallback/default path at first
- real Codex runtime execution becomes a separate lane instead of a drop-in replacement
- unified logs come from normalization, not from pretending every provider has Anthropic-native runtime semantics

## Decision Summary

### We are doing this

- keep the current Codex adapter path as the fallback/default path initially
- introduce a new `Codex-native` backend lane using `@openai/codex-sdk / codex exec`
- introduce a normalized internal event/log format for all providers
- map Anthropic, Gemini, and future Codex-native events into that normalized format
- keep unified logging, transcript projection, analytics, and UI-facing event handling on top of the normalized layer
- use `plugin-kit-ai` for:
  - install
  - update
  - remove
  - repair
  - discover
  - catalog
  - native Codex plugin placement through native marketplace/filesystem layout

### We are not doing this

- not replacing the whole multimodel runtime in one shot
- not forcing real Codex runtime execution into fake Anthropic transport semantics
- not pretending a full `@openai/codex-sdk / codex exec` swap is a drop-in backend replacement
- not making `app-server plugin/*` the first production seam

## Why We Chose This

### Main benefit

This path gives us both:

- unified internal logs/events
- a real path to native Codex runtime capabilities

without requiring a full rewrite of the current multimodel runtime.

### Main reason against a direct full swap

The current orchestrator is deeply coupled to Anthropic-shaped runtime behavior:

- `tool_use`
- `tool_result`
- `content_block_start`
- `input_json_delta`
- `message_delta`
- current permission and sandbox flow
- current synthetic tool/result handling
- current transcript persistence and resume logic

`codex exec` emits a different event model:

- `thread.started`
- `turn.started`
- `turn.completed`
- `turn.failed`
- `item.started`
- `item.updated`
- `item.completed`

and item types such as:

- `agent_message`
- `reasoning`
- `command_execution`
- `file_change`
- `mcp_tool_call`

That is not just a different wire format. It is a different runtime shape.

## What Changes Per Repo

### `agent_teams_orchestrator`

This repo takes the biggest change.

We want to:

- introduce a provider-neutral normalized event/log model
- add adapter mappers from current Anthropic/Gemini style streams into that model
- add a separate `Codex-native` backend lane through `@openai/codex-sdk / codex exec`
- keep the current Codex adapter path alive as fallback during migration
- avoid forcing `codex exec` events into fake `tool_use/tool_result` transport semantics

We do **not** want to:

- replace the current Codex backend in one shot
- rewrite all providers around Codex-native semantics
- make transcript/log normalization depend on Anthropic wire events

### `claude_team`

This repo should stay relatively stable compared with the orchestrator.

We want to:

- keep one multimodel runtime concept
- stay capability-aware per provider/backend lane
- consume normalized runtime/log DTOs rather than assuming one provider-shaped event model
- integrate plugin management through `plugin-kit-ai`
- keep Codex plugin support gated behind the real Codex-native lane

We do **not** want to:

- invent a fake Codex plugin support state while execution still goes through the old adapter lane
- force UI logic to infer runtime truth from provider labels alone

### `plugin-kit-ai`

This repo remains the management engine, not the execution engine.

We want to:

- use it for catalog
- use it for discover
- use it for install/update/remove/repair
- use it for native Codex plugin placement through native marketplace/filesystem layout

We do **not** want to:

- make it responsible for running Codex plugins inside sessions
- blur installation and execution into one concern

## Target Architecture

### Runtime execution

- `Anthropic` can continue on the current path for now
- `Gemini` can continue on the current path for now
- `Codex-native` gets a dedicated backend lane through `@openai/codex-sdk / codex exec`

### Internal normalization

All runtime backends must project into a shared internal event/log model.

The normalized layer should represent concepts such as:

- turn started
- assistant text
- reasoning
- command execution
- MCP call
- file change
- approval request
- turn completed
- turn failed

The normalized format is the source of truth for:

- logs
- transcript projection
- analytics
- UI-facing activity/event summaries

The normalized format is **not** required to preserve provider-native wire semantics.

## Codex Plugins Strategy

For Codex plugins we want:

- native Codex runtime execution
- native Codex marketplace/filesystem placement
- provider-aware plugin management in `claude_team`

Therefore:

- `plugin-kit-ai` is the management engine
- real Codex runtime is the execution engine

This is important because plugin installation and plugin execution are different concerns.

Installing a native Codex plugin is not enough by itself if the session still runs through our current Responses API adapter path.

## App Server Position

`codex app-server` remains relevant, but not as the first critical path for this migration.

It is better positioned as a later control-plane enhancement for things like:

- auth state
- MCP status and OAuth flows
- skills/config inspection
- external config import

For the first production rollout, it should not be the hard dependency for plugin lifecycle management.

## Implementation Phases

### Phase 1

- design and introduce the normalized internal event/log layer
- keep current backends working
- define the internal mapping contract clearly

### Phase 2

- add a `Codex-native` backend lane through `@openai/codex-sdk / codex exec`
- keep the current Codex adapter as fallback
- validate API-key mode, working directory behavior, sandbox mode, approval policy, thread resume, and streaming

### Phase 3

- integrate `plugin-kit-ai` for provider-aware plugin management
- add native Codex plugin placement through native marketplace/filesystem model
- keep current UI provider-aware and capability-aware

### Phase 4

- optionally add selective `codex app-server` control-plane integration where it provides clear value

## Main Risks And Guardrails

### Risk 1 - treating `codex-sdk/exec` as a transport-only swap

This is the most dangerous mistake.

Guardrail:

- treat `Codex-native` as a separate runtime lane
- normalize logs/events above it
- do not assume the current Anthropic-shaped tool loop can be preserved unchanged

### Risk 2 - claiming Codex plugin support too early

Installing native Codex plugins is not enough if execution still runs through the current adapter path.

Guardrail:

- only advertise Codex plugin support when the session actually runs through the Codex-native lane

### Risk 3 - overcommitting to `app-server` too early

`codex app-server` is useful, but it should not become a hard dependency for the first production plugin rollout.

Guardrail:

- use it later for selective control-plane features
- do not block the first migration on `app-server plugin/*`

## Practical Rule

If we need **unified logs**, we normalize events.

If we need **native Codex capabilities**, we do not fake Codex into Anthropic runtime semantics.

That is the core architectural rule for this migration.

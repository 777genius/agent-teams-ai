# Runtime backend rationale: process by default, tmux as debug/manual mode

Date: 2026-05-13

Status: informational note, not a normative architecture spec.

This document captures the reasoning discussed during launch-runtime stabilization work. It may contain small inaccuracies or outdated external-project details, especially about third-party projects. Treat it as context and rationale, not as the source of truth. Current implementation, tests, and upstream project docs remain authoritative.

## Short version

We intentionally moved the desktop app toward **process backend by default** for app-launched teammates, while keeping **tmux as an explicit debug/manual mode**.

The reason is not that tmux is bad. The reason is that our product is not primarily a terminal multiplexer. It is an app-owned team runtime with UI state, launch diagnostics, restart/retry controls, provider auth handling, bootstrap proofs, notifications, and artifact packs.

For that product shape, the default runtime should be controlled by the app, not by a human attaching to panes.

## What tmux gives

tmux is useful when the product expects live terminal sessions:

- A human can attach to a pane and see exactly what the CLI sees.
- If the CLI asks for input, the user can manually press Enter or answer prompts.
- Panes can survive some app restarts.
- TTY behavior is closer to running the CLI manually.
- Debugging auth/login/TTY problems is easier because the terminal is visible.

This is why tmux is a natural default for terminal-first systems.

## Why not tmux like gastown/gascity

Based on the external-project research snapshot from this thread, `gastown` and `gascity` appear to be more terminal/session-oriented. This is an interpretation of their public docs/issues at the time of research, not a maintained compatibility claim:

- Their interaction model leans heavily on attachable sessions.
- Their session layer historically expects pane-like targets and terminal observation.
- In `gascity`, tmux appears as a default provider in session configuration.
- They use tmux because their flow values live interactive sessions, attach/revive/nudge, and human terminal control.

That is a valid design for a terminal-first product.

It is not automatically the best default for us because our desktop app has different ownership boundaries:

- We need reliable UI state for each member.
- We need deterministic launch success/failure state.
- We need structured diagnostics, not only "look at the pane".
- We need restart/retry/cleanup to be owned by the app.
- We need provider auth and tool approval to be modeled explicitly.
- We need headless teammate behavior to work without a terminal being open.

tmux also has known operational costs in this class of products:

- zombie sessions;
- broken pane targets;
- socket/version split-brain after upgrades;
- platform limitations, especially Windows;
- ambiguity between "pane exists" and "agent is actually ready";
- harder cleanup when app state and terminal state diverge.

So the difference is product shape:

- `gastown/gascity`: terminal/session-first, so tmux default is understandable.
- `claude_team`: desktop/app-owned lifecycle-first, so process default is more aligned.

## What process backend gives us

The process backend lets the app own the lifecycle:

- Runtime identity is represented as process metadata, not only pane id.
- `backendType: process` and `tmuxPaneId: process:<pid>` preserve compatibility with older shapes while making the backend explicit.
- Launch state can distinguish `spawned`, `bootstrap_submitted`, `bootstrap_confirmed`, `failed_to_start`, `bootstrap_stalled`, and provider failures.
- Diagnostics can be surfaced in member cards, notifications, launch summaries, and artifact packs.
- Restart and cleanup can target launch-owned processes instead of broad terminal state.
- App-managed bootstrap can avoid relying on the model to manually discover and call setup tools.

This is a better foundation for stable desktop launches than treating a pane as the primary runtime truth.

## Interactive prompts are still real

The main argument for tmux is valid: real CLIs sometimes ask interactive questions.

Examples:

- "Press Enter to continue"
- "Do you want to proceed? [y/N]"
- "Enter API key"
- "Please login"
- OAuth token expired
- provider quota or key limit prompt
- tool approval prompt

Our answer should not be "ignore all interaction". The correct answer is to split interaction into categories.

## How our architecture should handle interaction

### Structured approvals

Tool approvals should use structured protocol:

- CLI emits a `control_request`;
- app shows an approval UI or notification;
- app sends `control_response` through the owned channel;
- decision is persisted in runtime state.

This is better than asking the user to attach to tmux and press a key manually.

### Auth and login prompts

Auth/login prompts should usually be handled before launch:

- preflight provider auth;
- validate subscription/API-key mode;
- validate required settings/env;
- fail fast with actionable UI if auth is missing or expired.

Hidden teammate processes should not block waiting for a browser login or secret input.

### Safe known prompts

Some prompts can be handled through an allowlisted interactive prompt gate:

- exact "Press Enter to continue" style prompt;
- exact yes/no confirmation where the action is known and safe;
- one prompt at a time per process;
- timeout if user does not respond;
- event recorded in diagnostics/artifact pack.

For a lead process, the desktop app already owns `child.stdin`, so writing a newline is technically possible.

For teammate process backend, the desktop app may not directly own the child handle. The robust design is:

- detect prompt in process backend/orchestrator;
- surface structured prompt state to desktop;
- user chooses action in UI;
- the runtime owner writes to the teammate stdin;
- event is persisted.

Do not blindly write to arbitrary process stdin by PID.

### Unknown prompts

Unknown prompts should not be answered automatically.

Correct behavior:

- mark the member as waiting/blocked with a diagnostic;
- show the relevant output excerpt;
- suggest fixing auth/settings or using tmux debug mode;
- avoid sending random newline/yes/no input.

This prevents dangerous accidental confirmation and avoids hiding provider setup bugs.

## Why tmux remains useful

tmux should stay available as an explicit mode:

```bash
CLAUDE_TEAM_TEAMMATE_MODE=tmux pnpm dev
```

or via extra CLI args:

```bash
--teammate-mode tmux
```

Use it for:

- debugging unknown TTY behavior;
- reproducing provider CLI prompts manually;
- investigating strange live CLI output;
- cases where human terminal control matters more than app-owned lifecycle.

tmux is an escape hatch, not the production default.

## Why not full arbitrary terminal emulation

Trying to support all possible interactive terminal behavior inside process backend would be risky.

Problems:

- prompts are provider-specific and change over time;
- pressing Enter may be safe in one context and dangerous in another;
- stdin might be structured JSON, not text;
- a newline can land during an active model turn;
- secrets should not be requested through generic stdin;
- the app can accidentally mask auth or provider integration failures.

The safer contract is:

- app-managed launch should be non-interactive by default;
- known safe prompts may be handled through structured UI;
- auth/setup should be preflighted;
- unknown TTY needs tmux/manual debug mode.

## Current strategic choice

Recommended runtime policy:

1. Production default: process backend.
2. Provider setup: preflight and actionable diagnostics.
3. Tool approvals: structured app UI.
4. Known safe prompts: bounded interactive prompt gate.
5. Unknown prompts: fail/block visibly with diagnostics.
6. Debug/manual: explicit tmux mode.

This keeps the app in control of lifecycle state while preserving tmux where it is genuinely useful.

## Tradeoff summary

### Process default + tmux debug mode

Confidence: 9.3/10
Reliability: 9/10
Complexity: 6/10

Best fit for desktop/app-owned agent teams. Requires strong diagnostics and provider preflight.

### tmux default + process fallback

Confidence: 6.5/10
Reliability: 6.5/10
Complexity: 4/10

Good for terminal-first workflows. Less aligned with deterministic app-owned launch state.

### Fully abstract runtime providers

Confidence: 7/10
Reliability: 7.5/10
Complexity: 9/10

Potentially useful later, but too broad as a launch-stability fix.

## Bottom line

We did not reject tmux entirely. We rejected tmux as the default runtime truth for app-launched teams.

The desktop product should make teammate launch reliable through app-owned process lifecycle, structured evidence, diagnostics, and controlled recovery. tmux remains valuable for debug/manual sessions, especially when an unknown CLI prompt requires a real terminal.

# Agent launch architecture comparison research

Research date: 2026-05-07

Purpose: record factual research on how different systems launch or execute agents. This is informational context only, not an implementation recommendation.

## Scope

Systems compared:

| System | Repository / source | Snapshot |
|---|---|---|
| Our Agent Teams | Local `claude_team` + `agent_teams_orchestrator` | Local working tree, 2026-05-07 |
| Paperclip | `paperclipai` docs/code research from earlier pass | Public docs / local research |
| Gastown | `github.com/gastownhall/gastown` | cloned `cfbdf3c` |
| GoClaw Enterprise / Teams | `github.com/nextlevelbuilder/goclaw` | cloned `a97e502` |
| GoClaw OpenClaw-compatible gateway | `github.com/roelfdiedericks/goclaw` | cloned `6a7ccdb` |

Primary external references:

| Topic | Source |
|---|---|
| Gastown README | https://github.com/gastownhall/gastown/blob/main/README.md |
| Gastown agent provider integration | https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md |
| GoClaw agent loop | https://github.com/nextlevelbuilder/goclaw/blob/main/docs/01-agent-loop.md |
| GoClaw agent teams | https://github.com/nextlevelbuilder/goclaw/blob/main/docs/11-agent-teams.md |
| GoClaw team WS events | https://github.com/nextlevelbuilder/goclaw/blob/main/docs/13-ws-team-events.md |
| Paperclip agent runtime | https://github.com/paperclipai/docs/blob/main/agents-runtime.md |
| Paperclip adapters overview | https://paperclip.inc/docs/adapters/overview/ |

## Short answer

There are four distinct launch/execution models:

| Model | Used by | Essence |
|---|---|---|
| External live CLI process | Our Agent Teams | App/orchestrator launches real teammate runtimes and tracks bootstrap, PID, stderr, process health, runtime evidence, task/message state. |
| Bounded adapter run | Paperclip | A heartbeat or job starts a short agent run, adapter invokes CLI/provider, result is captured, run exits or times out. |
| Tmux session orchestration | Gastown | `tmux` is the universal runtime adapter. Agents run in terminal sessions, receive input through tmux, and are observed through panes/session state. |
| In-process agent loop | GoClaw Enterprise / Teams | Agent execution is a Go `Loop.Run(ctx, RunRequest)` scheduled through lanes. The agent is a logical loop inside the gateway, not necessarily a separate CLI teammate process. |

## What “in-process agent loop” removes from our live teammate product

In-process loop does not mean “bad”. It is often cleaner. But compared to our external process teammate model, it removes or changes several product properties.

| Product property | External process teammate, our model | In-process GoClaw-style loop |
|---|---|---|
| Real process identity | Each teammate can have PID/RSS/stdout/stderr/process lifetime. | Agent run is a gateway invocation; no independent teammate PID by default. |
| CLI-realism | Claude/Codex/OpenCode behave as their real CLI runtimes, including auth, prompts, provider errors, stderr quirks. | Provider/driver behavior is normalized inside gateway; fewer raw CLI lifecycle surfaces. |
| Per-member restart semantics | Restart means kill/relaunch or reattach a concrete runtime for that member. | Restart is usually cancel/reschedule a logical run/session. |
| Bootstrap evidence | We can distinguish process alive, bootstrap submitted, bootstrap confirmed, delivery proof, task proof. | The loop itself is already the controlled runtime; less need for low-level bootstrap proof. |
| UI runtime cards | UI can show memory, process state, liveness source, failed/stalled bootstrap, exact runtime diagnostics. | UI tends to show run/session/task status rather than OS/process-level teammate state. |
| TTY/process debugging | Process/tmux mode can expose raw CLI behavior when needed. | Debugging is gateway traces/events/logs, not a live CLI pane/process per member. |
| Failure classes | Auth prompt, no stdin, CLI did not submit bootstrap, process died, stale PID, provider CLI stderr. | Mostly provider/tool/session/run errors inside the loop. |
| Isolation boundary | OS process boundary per teammate. | Mostly logical/session isolation inside one gateway process, unless it delegates to external providers/tools. |

Important distinction: in-process loop is simpler and can be more stable for gateway/chat products. It is not a drop-in replacement for a desktop product whose value includes live external teammate runtimes.

## Our Agent Teams launch/execution model

Our current direction is app-managed live external teammate runtime.

Observed local architecture:

| Layer | Role |
|---|---|
| `claude_team` Electron app | UI, provisioning, runtime projection, team messages, tasks, diagnostics, retries. |
| `agent_teams_orchestrator` | Multi-agent runtime orchestration, teammate spawning, provider/runtime bridging. |
| Process backend | Default for app-launched teammates after recent changes. Launch-owned processes are tracked as runtime entities. |
| Optional tmux mode | Debug/manual mode, not production default. Useful for real TTY inspection. |
| App-managed bootstrap | Backend injects/records startup context and requires durable readiness evidence instead of trusting “process exists”. |
| Runtime projection | Maps launch state, process liveness, bootstrap proof, delivery proof, task state and diagnostics to UI. |

Key properties:

| Dimension | Current behavior |
|---|---|
| Agent lifetime | Long-lived teammate process/session, not just one request. |
| Availability proof | Process alive is not enough. Need bootstrap/runtime evidence. |
| Provider mix | Claude, Codex, OpenCode can coexist in one team. |
| User experience | Live team room: cards, memory, tasks, messages, runtime errors, restart/retry controls. |
| Complexity cost | High. Many edge cases around launch, cleanup, stale state, delivery, work-sync, retries. |

Technical assessment:

| Criterion | Score |
|---|---:|
| Live team product fit | 9.2/10 |
| Mixed provider fidelity | 8.7/10 |
| Runtime proof strictness | 8.8/10 |
| Simplicity | 5.8/10 |
| Maintainability today | 7.2/10 |
| Overall technical score | 8.5/10 |

## Paperclip launch/execution model

Paperclip is closest to a bounded job/heartbeat runner.

Research summary from earlier pass:

| Piece | Behavior |
|---|---|
| Agent invocation | Heartbeat or scheduled run calls adapter execution. |
| Runtime | Adapter starts/calls CLI or provider, captures output/status/errors. |
| Lifecycle | Run exits, times out, or is cancelled. |
| Concurrency | Wakeups coalesce if agent is already running. |
| Persistence | Status/logs/tokens/errors are stored per run. |

This is operationally clean because there is no expectation that every teammate is a continuously alive process with card-level runtime state.

Technical assessment:

| Criterion | Score |
|---|---:|
| Bounded execution design | 9.1/10 |
| Simplicity | 8.8/10 |
| Failure boundedness | 8.7/10 |
| Live teammate room fit | 6.3/10 |
| External CLI fidelity | 7.5/10 |
| Overall technical score | 8.2/10 |

## Gastown launch/execution model

Gastown is tmux-first.

Facts from `gastownhall/gastown`:

| Piece | Behavior |
|---|---|
| Main runtime adapter | `tmux` sessions. |
| Universal integration | Any CLI that runs in terminal can be started and controlled. |
| Work unit | Beads/issues and convoys. |
| Worker identity | Polecats have persistent identity and reusable worktrees. |
| Session lifetime | Sessions are ephemeral; identity and sandbox can persist. |
| Communication | Mail, nudges, hooks, Beads state, tmux input/output. |
| Monitoring | Witness, Deacon, Dogs, Doctor, cleanup commands. |
| Provider integration | Built-in/custom presets with command, args, env, process names, hooks, readiness delay/prompt. |

Gastown explicitly documents a Tier 0 tmux shim: start CLI in tmux, send work through keystrokes, detect liveness through pane process, read output through captured pane. It also notes that this level is timing-sensitive and lacks delivery confirmation.

Core model:

```text
gt sling <bead> <rig>
  -> allocate or reuse polecat identity/worktree
  -> create tmux session
  -> set env: GT_ROLE, GT_RIG, GT_POLECAT, BD_ACTOR, GT_AGENT, etc.
  -> inject startup beacon / prompt / hook context
  -> nudge with instructions if provider needs fallback
  -> Witness/Deacon patrol health and cleanup
```

Technical assessment:

| Criterion | Score |
|---|---:|
| Terminal-native ops | 9.0/10 |
| Persistent worker identity | 8.7/10 |
| Cleanup / doctor culture | 8.8/10 |
| Delivery proof strictness | 6.4/10 |
| Live product state consistency | 6.8/10 |
| Overall technical score | 8.0/10 |

## GoClaw Enterprise / Teams launch/execution model

This is `nextlevelbuilder/goclaw`, the relevant GoClaw for agent teams.

Core architecture from docs/code:

| Piece | Behavior |
|---|---|
| Agent unit | `Loop` configured with provider, model, tools, workspace and agent type. |
| Run entrypoint | `Loop.Run(ctx, RunRequest)`. |
| Loop pattern | Think -> Act -> Observe, with max iterations and tool execution. |
| Scheduler | First-class lane scheduler. |
| Lanes | `main`, `subagent`, `team`, `cron`. |
| Queueing | Per-session queues with debounce, drop policy, max concurrent. |
| Team model | Lead/member, task board, mailbox, delegation. |
| Task semantics | Atomic claim, status lifecycle, dependencies, blocker escalation, task events. |
| Events | Typed WS events for delegation, tasks, team messages and agent lifecycle. |

Core execution shape:

```text
Inbound message / teammate message / cron / delegation
  -> Scheduler.Schedule(lane, RunRequest)
  -> SessionQueue serializes or bounds per session
  -> Lane worker admits execution
  -> Router.Get(agentID)
  -> Loop.Run(ctx, req)
  -> Provider call + tools + finalization
  -> Events + stored session/task/trace state
```

GoClaw team member execution is conceptually a scheduled agent run, not an externally spawned teammate CLI process with bootstrap/check-in.

Technical assessment:

| Criterion | Score |
|---|---:|
| Scheduler architecture | 9.2/10 |
| Agent loop clarity | 8.9/10 |
| Team task model | 8.8/10 |
| Typed event model | 8.8/10 |
| Real external teammate runtime fidelity | 6.6/10 |
| Live process UI fit | 6.5/10 |
| Overall technical score | 8.7/10 |

## GoClaw OpenClaw-compatible gateway model

This is `roelfdiedericks/goclaw`. It is a different project than `nextlevelbuilder/goclaw`.

High-level facts:

| Piece | Behavior |
|---|---|
| Product class | Personal AI gateway / OpenClaw-compatible bot runtime. |
| Main strengths | Transcript search, memory graph, channels, persistent memory, delegated runs, ACP sessions. |
| Delegated work | `subagent_spawn`, `subagent_fanout`, `subagent_status`, `subagent_cancel`. |
| Runner | `DefaultRunner` starts active runs as goroutines with run IDs, timeout/cancel, optional concurrency lane semaphore. |
| UI/control | `/runners` dashboard, SSE events, Telegram/TUI summaries. |
| Cursor integration | ACP attachment to live Cursor session. |

Runner shape:

```text
subagent_spawn / fanout
  -> DefaultRunner.Start(ctx, RunSpec)
  -> create RunRecord queued
  -> goroutine waits for lane admission
  -> execute function runs child work
  -> registry records completed/failed/canceled/timeout
  -> events emitted
```

This is closer to Paperclip-style delegated bounded runs than to our live teammate process model.

Technical assessment:

| Criterion | Score |
|---|---:|
| Personal gateway/memory architecture | 8.8/10 |
| Delegated run boundedness | 8.5/10 |
| Channel/memory richness | 9.0/10 |
| Live external teammate fidelity | 5.8/10 |
| Team room fit | 6.4/10 |
| Overall technical score | 8.1/10 |

## Direct comparison table

| System | Launch/execution primitive | Separate OS process per agent? | Long-lived teammate? | Task board | Team messages | Scheduler | Tmux | Best fit |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Our Agent Teams | Launch-owned external CLI/process runtime | Yes | Yes | Yes | Yes | Partial/ad-hoc today | Optional/debug | Desktop live mixed-provider team room |
| Paperclip | Bounded adapter heartbeat run | Usually per run | No | Limited/not central | Not team-room focused | Yes, job-like | No core tmux | Reliable background/job agents |
| Gastown | Tmux session + worktree + Beads | Yes, through tmux | Session ephemeral, identity persistent | Beads/convoys | Mail/nudges | Scheduler/capacity exists | Core | Terminal-native multi-agent ops |
| GoClaw Enterprise | In-process scheduled agent loop | Not by default | Logical sessions/runs | Yes | Yes | First-class lanes | No core tmux | Multi-agent gateway/platform |
| GoClaw OpenClaw-compatible | Delegated goroutine runner + gateway sessions | Not by default | Logical runs/sessions | Not primary team board in same way | Channels | Runner lane semaphore | No core tmux | Personal gateway, memory, delegated runs |

## Honest overall scores

| System | Overall technical score | Why |
|---|---:|---|
| GoClaw Enterprise / Teams | 8.7/10 | Cleanest scheduler/team/task/event architecture among compared systems. |
| Our Agent Teams | 8.5/10 | Best fit for real live external Claude/Codex/OpenCode teammate product, but high complexity. |
| Paperclip | 8.2/10 | Very clean bounded runtime model, but not a live team-room system. |
| GoClaw OpenClaw-compatible | 8.1/10 | Strong personal gateway/memory/delegated run model, less comparable to our team runtime. |
| Gastown | 8.0/10 | Strong terminal ops and lifecycle culture, but tmux-first delivery/readiness is less proof-strict. |

## Research conclusions

The systems optimize for different truths:

| System | Optimized for |
|---|---|
| Our Agent Teams | User-visible live team of real external coding agents. |
| Paperclip | Bounded, simple, resumable background agent runs. |
| Gastown | Terminal-native agent ops at scale with durable work identity. |
| GoClaw Enterprise | Clean gateway-native multi-agent scheduling and team task orchestration. |
| GoClaw OpenClaw-compatible | Long-memory personal agent gateway with delegated subruns. |

Most useful conceptual takeaways for future reference:

| Idea | Source | Why it matters |
|---|---|---|
| First-class scheduler lanes | GoClaw Enterprise | Separates main/team/subagent/cron load and makes cancellation/backpressure more deterministic. |
| Typed team event catalog | GoClaw Enterprise | Makes UI and state transitions easier to reason about. |
| Persistent identity vs ephemeral session | Gastown | Useful framing for member identity, runtime session, task ownership and cleanup. |
| Bounded adapter runs | Paperclip | Good model for cron, background checks and non-live workers. |
| Patrol/doctor cleanup culture | Gastown | Good operational model for stale runtime/process/data cleanup. |

Non-recommendation note: this document intentionally does not propose changing our architecture. It records observed models for future design discussions.

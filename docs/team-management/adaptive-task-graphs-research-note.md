# Adaptive Task Graphs For Agent Teams

**Date:** 2026-05-14  
**Status:** Research note, not an approved implementation plan  
**Scope:** Team Management, task graph scheduling, lead/member coordination, token and conflict reduction

## Sources

- [AgentConductor: Topology Evolution for Multi-Agent Competition-Level Code Generation](https://arxiv.org/abs/2602.17100)
- [Improving the Efficiency of Language Agent Teams with Adaptive Task Graphs](https://arxiv.org/html/2605.06320v1)

## Why This Is Interesting

These papers point at the same product problem we already see in Agent Teams: multi-agent performance is limited less by raw model capability and more by coordination overhead.

The useful idea is not "replace our orchestrator with a research framework". The useful idea is to make the task board itself a more explicit coordination graph:

- tasks are graph nodes
- `blockedBy` / `blocks` are dependency edges
- ready work is the graph frontier
- workers should receive scoped local context, not full team history
- stalled work should be released or reassigned explicitly
- risky or high-impact work should get selective verification
- coordination quality should be measured, not inferred from vibes

This fits our existing direction because the product already has task dependencies, review workflow, stall monitoring, task logs, context tracking, and lead/member briefing surfaces.

## Most Valuable Ideas To Preserve

### 1. LATTE-style dynamic task graph

LATTE is the more directly useful paper for us.

Core idea:

- the lead owns global graph consistency
- workers can propose or claim local work
- structural updates are serialized through the lead or controller
- execution stays parallel where dependencies allow it
- the graph remains inspectable, so coordination decisions are visible in the UI

Relevant operators to consider:

- `Discover` - create a newly discovered task when implementation reveals missing work
- `Assign` - set an owner for a ready task
- `Claim` - allow an idle member to take an unowned ready task
- `Complete` - mark task completion
- `Release` - clear owner or return stalled work to the ready queue
- `Close` - close stale/completed tasks when tests or evidence prove completion
- `Verify` - insert a lightweight review/check task before downstream work proceeds

🎯 Product value: 9/10  
🛡️ Reliability if implemented incrementally: 8/10  
🧠 Complexity: 6/10  
Expected change size for a first useful version: about 700-1400 LOC.

### 2. Frontier-based scheduling

The board should be able to derive "what is actionable now" from graph state:

- a task is ready when all `blockedBy` tasks are completed or approved
- blocked tasks should not be started automatically
- ready unowned tasks can be offered to idle members
- ready owned tasks belong in the owner's operational queue
- lead briefing should show graph bottlenecks and unassigned frontier work

This connects directly to `task-queue-derived-agenda-plan.md`. The key addition is to treat the queue as a graph frontier, not just a filtered task list.

🎯 Product value: 9/10  
🛡️ Reliability: 8/10  
🧠 Complexity: 5/10  
Expected change size: about 500-1000 LOC if built on the current derived agenda work.

### 3. Selective verification instead of review everything

LATTE's `Verify` is useful because it scales review cost with risk:

- verify upstream tasks that many other tasks depend on
- verify work touching shared files or public contracts
- verify tasks whose owner reported uncertainty
- skip extra verification for small isolated changes unless policy requires it

This maps well to our existing review UI and task comments. A future implementation could create a verification task or request review based on graph impact.

🎯 Product value: 8/10  
🛡️ Reliability: 7/10  
🧠 Complexity: 5/10  
Expected change size: about 350-800 LOC.

### 4. Straggler release as first-class behavior

LATTE explicitly models stalled workers and `Release`. We already have task-stall monitoring, but the next step is to make release/reassign a structured board action, not only a message nudge.

Useful behavior:

- detect a task with weak or stale progress evidence
- notify or nudge the current owner first
- if still stalled, clear owner or reassign with context
- preserve evidence and avoid duplicate nudges
- never auto-start new runtime lanes as a side effect

This must stay compatible with existing OpenCode delivery watchdog and stall-monitor semantics.

🎯 Product value: 8/10  
🛡️ Reliability: 7/10  
🧠 Complexity: 6/10  
Expected change size: about 600-1200 LOC.

### 5. Coordination metrics as a product surface

LATTE is especially useful because it externalizes coordination and measures failures:

- idle rounds
- straggler tail latency
- inter-agent messages
- file conflicts or concurrent writes
- redundant output
- wasted tokens
- task graph growth and bottlenecks

For Agent Teams, this could become a "team efficiency" diagnostic panel and a safer prerequisite before changing scheduling behavior.

🎯 Product value: 8/10  
🛡️ Reliability: 9/10  
🧠 Complexity: 4/10  
Expected change size: about 350-800 LOC.

## AgentConductor Ideas Worth Keeping

AgentConductor is less directly implementable because it depends on an RL/SFT-trained orchestrator and competition-code benchmarks. Still, one product idea is valuable:

**Task difficulty should control graph density.**

Possible lightweight version for Agent Teams:

- easy task - solo or small graph, minimal messaging, no extra verification by default
- medium task - split by independent deliverables, use dependencies only where real ordering exists
- hard task - more explicit roles, denser review/checkpoints, stronger integration pass
- failed execution feedback - adapt the graph instead of repeating the same topology

Do not adopt the paper's full GRPO/SFT training path for now. It is too heavy for the app and not necessary to get product value.

🎯 Product value: 7/10  
🛡️ Reliability: 6/10  
🧠 Complexity: 7/10  
Expected change size for a heuristic MVP: about 600-1300 LOC.

## Objectivity And Risk Notes

The LATTE paper is directionally credible but should not be treated as production proof.

Strong points:

- the core claim matches practical distributed-systems intuition
- the paper compares against several coordination styles, not only one weak baseline
- it evaluates multiple collaborative task types
- it emphasizes metrics we can independently measure
- the mechanism is simple enough to port incrementally

Limitations:

- it is an arXiv preprint, not final production validation
- benchmark tasks are controlled research tasks, not our full Electron plus runtime matrix
- baseline implementations may not match best possible production implementations
- reported improvements should be validated against our own teams, logs, and providers

Practical conclusion:

⚠️ Treat LATTE as a strong design signal, not a dependency or spec. Implement the ideas gradually behind our existing task board, lead/member briefings, and runtime-specific guardrails.

## Recommended Internal Path

1. Add coordination metrics first.
2. Derive a graph frontier from current task state.
3. Make lead and member briefings use the frontier as the operational queue.
4. Add structured release/reassign for stalled work.
5. Add selective verification for high-risk graph nodes.
6. Only after that, consider difficulty-aware graph density hints.

This ordering gives us evidence before automation. It also keeps the rollout compatible with existing `blockedBy`, review flow, task-stall monitor, OpenCode delivery watchdog, and context tracking.


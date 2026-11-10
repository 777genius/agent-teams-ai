# Agent Teams with Claude Opus 4.8

Claude Opus 4.8 made a single agent noticeably stronger. But the real productivity jump comes when this model powers **a whole team of agents** that talk to each other, coordinate, and autonomously carry a task through to the result.

Here's what that looks like in practice.

## A team of agents instead of just one

You assemble a team of several Opus 4.8 agents and assign roles: lead, backend, frontend, reviewer — whatever fits your task. From there they work in parallel, each in their own area.

If you're not ready for a full team yet, there's a solo mode with a single agent that manages its own task list. You can grow it into a full team later.

## They talk and coordinate

This isn't a bunch of independent chats. The agents:
- message each other inside the team
- hand off results and ask each other for clarification
- code-review each other's work
- create and close tasks on a shared kanban board on their own

And here's something you usually don't see anywhere else: **you can run multiple teams at once, and they coordinate between themselves**. Spin up parallel teams for different tracks (say, backend and frontend, or two features at once) — their leads will talk to each other, sync progress, and pass results down the chain.

You set the goal at a high level — breakdown, distribution, and execution happen without you.

## Everything is visible in the UI

In real time:
- **Kanban** with tasks moving across statuses
- **Diff viewer** for every task: accept / reject / comment
- **Agent-to-agent chat** plus direct messages with any of them
- **Detailed logs** for every agent — what it did, which commands it ran, which decisions it made
- **Per-task view**: open a card on the kanban and see everything tied to it — code changes, agent conversations, comments, logs. No confusion about what belongs where
- **Active agent sessions** with open links
- **Notifications** when the team is done or needs your input

## Not just Claude

Beyond Opus 4.8, you can plug **Codex** and **OpenCode** agents into the same team _(200+ models, 70+ LLM providers)_. Different runtimes coexist within a single team — pick the strengths of each where they fit best, without locking yourself into one vendor.

## Under the hood

Local, no cloud, free, open source. It works through the Claude / Codex / OpenCode CLIs you already have installed — no separate app-level API keys required.

---

> Screenshots and video below.

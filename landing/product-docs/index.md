---
title: Agent Teams Docs – Run AI Agent Teams from a Local Desktop App
description: Documentation for Agent Teams, a free desktop app for AI agent orchestration. Create teams, watch work on a kanban board, review code changes, and coordinate Claude, Codex, OpenCode, and multimodel workflows.
layout: home
hero:
  name: Agent Teams Docs
  text: Run AI agent teams from a local desktop app
  tagline: Create teams, watch work move across a kanban board, review code changes, and coordinate Claude, Codex, OpenCode, and multimodel workflows without giving up local control.
  actions:
    - theme: brand
      text: Beginner workflow
      link: /guide/beginner-workflow
    - theme: alt
      text: Install
      link: /guide/installation
    - theme: alt
      text: Concepts
      link: /reference/concepts
features:
  - icon: "01"
    title: Team-first workflow
    details: Define roles, launch a lead, and let agents split, claim, and coordinate tasks.
    link: /guide/create-team
    linkText: Create a team
  - icon: "02"
    title: Live kanban board
    details: Watch tasks move through todo, in progress, review, done, and approved as agents work.
    link: /guide/agent-workflow
    linkText: Understand workflow
  - icon: "03"
    title: Built-in code review
    details: Inspect task-scoped diffs, accept or reject hunks, and comment where agents need direction.
    link: /guide/code-review
    linkText: Review changes
  - icon: "04"
    title: Runtime-aware setup
    details: Use Claude, Codex, OpenCode, or multimodel providers through the access you already have.
    link: /guide/runtime-setup
    linkText: Configure runtimes
  - icon: "05"
    title: Local-first control
    details: The desktop app reads local project and runtime state. Your code stays on your machine unless a selected provider receives prompt context.
    link: /reference/privacy-local-data
    linkText: Privacy model
  - icon: "06"
    title: Debuggable teams
    details: Trace task logs, runtime output, teammate messages, and live processes when a launch or task gets stuck.
    link: /guide/troubleshooting
    linkText: Troubleshoot
---

<InstallBlock />

## Start here

Agent Teams is a free desktop app for orchestrating AI agent teams. You are not just sending isolated prompts to one agent: you create a team, assign roles, and watch agents coordinate work through a task board.

<DocsCardGrid />

## Next steps after launch

After creating your first team, explore these guides to go further:

- **Runtime setup** - configure Claude, Codex, OpenCode, or multimodel providers: [Configure runtimes](/guide/runtime-setup)
- **Beginner workflow** - follow the complete first-run path from project to approval: [Start the walkthrough](/guide/beginner-workflow)
- **Create your first team** - set up lead, builder, reviewer, roles, models, and Worktree: [Create the team](/guide/create-first-team)
- **Run and monitor work** - read the board, comments, task detail, and logs: [Run the team](/guide/run-and-monitor-work)
- **Review and approve** - inspect task results and code changes before approval: [Review work](/guide/review-and-approve)
- **Agent workflow** - understand how agents coordinate through the task board: [Understand workflow](/guide/agent-workflow)
- **Team brief examples** - learn prompt patterns from real-world briefs: [See examples](/guide/team-brief-examples)
- **Code review** - inspect diffs, accept or reject changes: [Review changes](/guide/code-review)
- **Troubleshooting** - diagnose stuck launches, missing teammates, and task failures: [Troubleshoot](/guide/troubleshooting)
- **Git worktree strategy** - use worktree isolation when multiple teammates edit the same repo in parallel: [Learn about worktrees](/guide/git-worktree-strategy)
- **Release notes** - see what's new in each version: [View releases](/reference/release-notes)

## Reference

Use the reference pages when you need exact terminology, provider behavior, contributor architecture, or privacy boundaries.

<DocsCardGrid type="reference" />

## Product preview

<ZoomImage src="/screenshots/product-preview.png" alt="Agent Teams kanban board" caption="Task status, teammate activity, and review workflow stay visible in one workspace." />

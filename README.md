<p align="center">
  <img src="resources/icons/png/1024x1024.png" alt="claude-devtools" width="120" />
</p>

<h1 align="center">claude-devtools</h1>

<p align="center">
  <strong><code>Read 3 files</code> told you nothing. This shows you everything.</strong>
  <br />
  A desktop app that reconstructs exactly what Claude Code did — every file path, every tool call, every token — from the raw session logs already on your machine.
</p>

<br />

<p align="center">
  <video src="https://github.com/user-attachments/assets/55e7412e-2737-4729-a863-249f04ebb9ef">
    Your browser does not support the video tag.
  </video>
</p>

---

## Why This Exists

### Claude Code stopped telling you what it's doing.

Recent Claude Code updates replaced detailed tool output with opaque summaries. `Read 3 files`. `Searched for 1 pattern`. `Edited 2 files`. No paths, no content, no line numbers. The context usage indicator became a three-segment progress bar with no breakdown. To get the details back, the only option is `--verbose` — which dumps raw JSON, internal system prompts, and thousands of lines of noise into your terminal.

**There is no middle ground in the CLI.** You either see too little or too much.

claude-devtools restores the information that was taken away — structured, searchable, and without a single modification to Claude Code itself. It reads the raw session logs from `~/.claude/` and reconstructs the full execution trace: every file path that was read, every regex that was searched, every diff that was applied, every token that was consumed — organized into a visual interface you can actually reason about.

### The wrapper problem.

There are many GUI wrappers for Claude Code — Conductor, Craft Agents, Vibe Kanban, 1Code, ccswitch, and others. I tried them all. None of them solved the actual problem:

**They wrap Claude Code.** They inject their own prompts, add their own abstractions, and change how Claude behaves. If you love the terminal — and I do — you don't want that. You want Claude Code exactly as it is.

**They only show their own sessions.** Run something in the terminal? It doesn't exist in their UI. You can only see what was executed through *their* tool. The terminal and the GUI are two separate worlds.

**You can't debug what went wrong.** A session failed — but why? The context filled up too fast — but what consumed it? A subagent spawned 5 child agents — but what did they do? Even in the terminal, scrolling back through a long session to reconstruct what happened is nearly impossible.

**You can't monitor what matters.** Want to know when Claude reads `.env`? When a single tool call exceeds 4K tokens of context? When a teammate sends a shutdown request? You'd have to wire up hooks manually, every time, for every project.

**claude-devtools takes a different approach.** It doesn't wrap or modify Claude Code at all. It reads the session logs that already exist on your machine (`~/.claude/`) and turns them into a rich, interactive interface — regardless of whether the session ran in the terminal, in an IDE, or through another tool.

> Zero configuration. No API keys. Works with every session you've ever run.

---

## Key Features

### :mag: Visible Context Reconstruction

Claude Code doesn't expose what's actually in the context window. claude-devtools reverse-engineers it.

The engine walks each turn of the session and reconstructs the full set of context injections — **CLAUDE.md files** (global, project, and directory-level), **@-mentioned files**, **tool call inputs and outputs**, **extended thinking**, **team coordination overhead**, and **user prompt text** — then accumulates them across turns with compaction-phase awareness. When a context reset occurs mid-session, the tracker detects the boundary, measures the token delta, and starts a new phase.

The result is a per-turn breakdown of estimated token attribution across 6 categories, surfaced in three places: a **Context Badge** on each assistant response, a **Token Usage popover** with percentage breakdowns, and a dedicated **Session Context Panel** with phase-filtered drill-down into every injection.

### :hammer_and_wrench: Rich Tool Call Inspector

Every tool call is paired with its result in an expandable card. Specialized viewers render each tool natively:
- **Read** calls show syntax-highlighted code with line numbers
- **Edit** calls show inline diffs with added/removed highlighting
- **Bash** calls show command output
- **Subagent** calls show the full execution tree, expandable in-place

### :bell: Custom Notification Triggers

Define rules for when you want to receive **system notifications**. Match on regex patterns, assign colors, and filter your inbox by trigger. Built-in triggers catch common errors out of the box; add your own for project-specific patterns.

### :busts_in_silhouette: Team & Subagent Visualization

Claude Code now spawns subagents via the Task tool and coordinates entire teams via `TeamCreate`, `SendMessage`, and `TaskUpdate`. In the terminal, all of this collapses into an unreadable stream. claude-devtools untangles it.

- **Subagent sessions** are resolved from Task tool calls and rendered as expandable inline cards — each with its own tool trace, token metrics, duration, and cost. Nested subagents (agents spawning agents) render as a recursive tree.
- **Teammate messages** — sent via `SendMessage` with color and summary metadata — are detected and rendered as distinct color-coded cards, separated from regular user messages. Each teammate is identified by name and assigned color.
- **Team lifecycle** is fully visible: `TeamCreate` initialization, `TaskCreate`/`TaskUpdate` coordination, `SendMessage` direct messages and broadcasts, shutdown requests and responses, and `TeamDelete` teardown.
- **Session summary** shows distinct teammate count separately from subagent count, so you can tell at a glance how many agents participated and how work was distributed.

### :zap: Command Palette & Cross-Session Search

Hit **Cmd+K** for a Spotlight-style command palette. Search across all sessions in a project — results show context snippets with highlighted keywords. Navigate directly to the exact message.

### :globe_with_meridians: SSH Remote Sessions

Connect to any remote machine over SSH and inspect Claude Code sessions running there — same interface, no compromise.

claude-devtools parses your `~/.ssh/config` for host aliases, supports agent forwarding, private keys, and password auth, then opens an SFTP channel to stream session logs from the remote `~/.claude/` directory. Each SSH host gets its own isolated service context with independent caches, file watchers, and parsers. Switching between local and remote workspaces is instant — the app snapshots your current state to IndexedDB before the switch and restores it when you return, tabs and all.

### :bar_chart: Multi-Pane Layout

Open multiple sessions side-by-side. Drag-and-drop tabs between panes, split views, and compare sessions in parallel — like a proper IDE for your AI conversations.

---

## What the CLI Hides vs. What claude-devtools Shows

| What you see in the terminal | What claude-devtools shows you |
|------------------------------|-------------------------------|
| `Read 3 files` | Exact file paths, syntax-highlighted content with line numbers |
| `Searched for 1 pattern` | The regex pattern, every matching file, and the matched lines |
| `Edited 2 files` | Inline diffs with added/removed highlighting per file |
| A three-segment context bar | Per-turn token attribution across 6 categories with compaction-phase tracking |
| Subagent output interleaved with the main thread | Isolated execution trees per agent, expandable inline with their own metrics |
| Teammate messages buried in session logs | Color-coded teammate cards with name, message, and full team lifecycle visibility |
| `--verbose` JSON dump | Structured, filterable, navigable interface — no noise |

---

## Getting Started

### Prerequisites

- **Node.js** 20+
- **pnpm** 10+
- macOS or Windows

### Install & Run

```bash
git clone https://github.com/matt1398/claude-devtools.git
cd claude-devtools
pnpm install
pnpm dev
```

That's it. The app auto-discovers your Claude Code projects from `~/.claude/`.

### Build for Distribution

```bash
pnpm dist:mac     # macOS (.dmg)
pnpm dist:win     # Windows (.exe)
pnpm dist         # Both platforms
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Development with hot reload |
| `pnpm build` | Production build |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm lint:fix` | Lint and auto-fix |
| `pnpm test` | Run all tests |
| `pnpm test:watch` | Watch mode |
| `pnpm test:coverage` | Coverage report |
| `pnpm check` | Full quality gate (types + lint + test + build) |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines. Please read our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

IPC handlers validate all inputs with strict path containment checks. File reads are constrained to the project root and `~/.claude`. Sensitive credential paths are blocked. See [SECURITY.md](SECURITY.md) for details.

## License

[MIT](LICENSE)

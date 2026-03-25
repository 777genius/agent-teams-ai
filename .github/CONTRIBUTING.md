# Contributing

Thanks for contributing to Claude Agent Teams UI.

## Project Philosophy & Scope

claude-devtools exists to make the invisible parts of Claude Code visible — the token flows, context injections, tool executions, and session dynamics that are otherwise hidden behind the CLI. It is not a general-purpose dashboard or an IDE.

Our priorities:

1. **Parity with Claude Code** — When Claude Code ships new capabilities (agent teams, context tracking, new tool types), we adopt them quickly so users always have full visibility.
2. **Context engineering insight** — Features that help users understand *what* is consuming their context window, *how* tokens flow through a session, and *where* to optimize. If it doesn't help someone make better decisions about their Claude Code usage, it probably doesn't belong here.
3. **Stability over novelty** — A reliable, fast tool for professional workflows. We'd rather do fewer things well than many things poorly.

**What we generally do not accept:**
- Large custom features that don't directly serve context visibility or Claude Code parity.
- Speculative features that add maintenance burden without solving a concrete problem users face today.
- PRs that significantly expand scope without prior discussion in an Issue.

If you're considering a non-trivial contribution, **open an Issue first** to check alignment with the current roadmap. This saves everyone time and keeps the project focused.

## Prerequisites
- Node.js 20+
- pnpm 10+
- macOS or Windows

## Setup
```bash
pnpm install
pnpm dev
```

## Quality Gates
Before opening a PR, run:
```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Pull Request Guidelines
- Keep changes focused and small — one purpose per PR.
- Add/adjust tests for behavior changes.
- Update docs when changing public behavior or setup.
- Use clear PR titles and include a short validation checklist.
- **Large changes (new features, new dependencies, large data additions) must have a discussion in an Issue first.** Do not open a large PR without prior agreement on the approach.
- Avoid committing large hardcoded data blobs. If data can be fetched at runtime or generated at build time, prefer that approach.

## AI-Assisted Contributions

AI coding tools are welcome, but **you are responsible for what you submit**:

- **Review before submitting.** Read every line of AI-generated code and understand what it does. Do not submit raw, unreviewed AI output.
- **Do not commit AI workflow artifacts.** Planning documents, session logs, step-by-step plans, or other outputs from AI tools (e.g. `docs/plans/`, `.speckit/`, etc.) do not belong in the repository.
- **Test it yourself.** AI-generated code must be manually verified — run the app, confirm the feature works, check edge cases.
- **Keep it intentional.** Every line in your PR should exist for a reason you can explain. If you can't explain why a piece of code is there, remove it.

## What Does NOT Belong in the Repo
- Personal planning/workflow artifacts (AI session plans, task lists, etc.)
- Large static data that could be fetched at runtime
- Generated files that aren't part of the build output
- Experimental features without prior discussion

## Commit Style
- Prefer conventional commits (`feat:`, `fix:`, `chore:`, `docs:`).
- Include rationale in commit body for non-trivial changes.

## Reporting Bugs
Please include:
- OS version
- app version / commit hash
- repro steps
- expected vs actual behavior
- logs/screenshots when possible

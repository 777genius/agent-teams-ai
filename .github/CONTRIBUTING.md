# Contributing

Thanks for contributing to Claude Agent Teams UI!

## Before You Start

For big features and major changes, please discuss them in our [Discord](https://discord.gg/qtqSZSyuEc) first: https://discord.gg/qtqSZSyuEc so we can figure out the best approach together and avoid conflicts.

Small fixes, bug reports, and minor improvements are always welcome - just open a PR.

## Prerequisites
- Node.js 20+
- pnpm 10+
- macOS, Windows, or Linux

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

Or all at once:
```bash
pnpm check
```

## Pull Request Guidelines
- Keep changes focused and small - one purpose per PR.
- Add/adjust tests for behavior changes.
- Update docs when changing public behavior or setup.
- Use clear PR titles and include a short validation checklist.
- Avoid committing large hardcoded data blobs. If data can be fetched at runtime or generated at build time, prefer that approach.

## AI-Assisted Contributions

AI coding tools are welcome, but **you are responsible for what you submit**:

- **Review before submitting.** Read every line of AI-generated code and understand what it does. Do not submit raw, unreviewed AI output.
- **Do not commit AI workflow artifacts.** Planning documents, session logs, step-by-step plans, or other outputs from AI tools do not belong in the repository.
- **Test it yourself.** AI-generated code must be manually verified - run the app, confirm the feature works, check edge cases.
- **Keep it intentional.** Every line in your PR should exist for a reason you can explain. If you can't explain why a piece of code is there, remove it.

## What Does NOT Belong in the Repo
- Personal planning/workflow artifacts (AI session plans, task lists, etc.)
- Large static data that could be fetched at runtime
- Generated files that aren't part of the build output

## Commit Style
- Prefer conventional commits (`feat:`, `fix:`, `chore:`, `docs:`).
- Include rationale in commit body for non-trivial changes.

## Reporting Bugs
Please include:
- OS version
- App version / commit hash
- Repro steps
- Expected vs actual behavior
- Logs/screenshots when possible

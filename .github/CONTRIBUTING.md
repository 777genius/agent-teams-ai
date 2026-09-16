# Contributing

Thanks for contributing to Agent Teams!

## Before You Start

For big features and major changes, please discuss them in our [Discord](https://discord.gg/qtqSZSyuEc) first: https://discord.gg/qtqSZSyuEc so we can figure out the best approach together and avoid conflicts.

Small fixes, bug reports, and minor improvements are always welcome - just open a PR.

## Contributor License Agreement

You keep copyright in what you write.

By opening a pull request (or pushing commits to one) you agree to [CLA.md](CLA.md) v2. You do not add your name to a table. Do not open a PR if you do not agree.

GitHub's Terms of Service already license that PR under AGPL-3.0. CLA v2 is the extra grant so the project owner can also sublicense your work (for example commercially or under Apache-2.0) while keeping the AGPL-3.0 grant from the submission date.

If the work belongs to your employer, say so in the PR. Do not include someone else's commits unless they agree to the CLA. Bots such as Dependabot do not need to agree.

## Prerequisites
- Node.js 24.16.0 LTS
- pnpm 10+
- macOS, Windows, or Linux

On macOS, official Node.js 24 prebuilt binaries require macOS 13.5+ for source development.

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

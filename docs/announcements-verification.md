# Announcements implementation verification

Date: 2026-09-05. Verification used the isolated `feat/announcements` worktree for PR #578.

## Automated checks

- Native TypeScript 7 typecheck: passed.
- Focused Vitest run: 204/204 passed across domain, main, source/cache, shell, IPC, preload, renderer, Markdown, shared overlay behavior, review guards and graph behavior.
- Publishing invariants: 12/12 passed; immutable-content check against `origin/main` passed.
- Actual landing generation: passed, including 121 prerendered routes. The generated deployed-shape feed byte-matches the generator output.
- `git diff --check` for the implementation scope: passed.
- Changed-file ESLint passed without warnings. The repository i18n validator still reports its pre-existing cross-catalog backlog; the seven corrected announcement catalogs parse successfully without key changes.
- The source-size guard passed for 2,768 production files and all frozen legacy caps.

Production author content contains only `feed.config.json`. Both `landing/public/announcements/feed.v1.json` and the generated Nuxt output contain `autoShowEnabled: false`, `items: []`, revision `67851cfed97b51f4caa7c2ebb4e861ea2a294338c423590feca54d2b0b313a3c`.

## Isolated Electron E2E

Every run used a separate temporary Electron `userData` root and Claude root, a loopback-only content server, an explicitly verified Electron PID and the `dev:mcp` renderer CDP endpoint. No project, team, agent, terminal, provider action or native folder picker was opened. Native focus was staged only for the owned temporary window; all workflow input used CDP clicks and keys.

The isolated Electron regression ran at `f2f0b6a0513d9db49c8ef3786a31c74922ca09f3`. It repeated automatic rich-content delivery, bounded asset loading, close persistence, restart suppression and manual access to all ten history items. Later review fixes cover lifecycle, accessibility and main-owned asset quotas with focused automated tests. The Electron UI was not relaunched after the user requested background-only verification. The current E2E helper was syntax-checked and now requires a real loaded hero image instead of accepting its fallback placeholder.

Verified behavior:

- zero usage: no automatic dialog; manual history immediately showed ten articles;
- persisted usage seeded just below 30 minutes: actual elapsed window time crossed the threshold and only the latest article opened;
- close plus restart: handled/dismissed state persisted and older articles did not cascade;
- a genuinely newer ID appeared automatically on a later foreground event;
- editing the same ID changed its manual body to `UPDATED SAME ID` without another automatic presentation;
- manual history blocked auto replacement while open;
- offline refresh disabled auto, showed the offline state and kept a cached article readable;
- expired items never appeared automatically, were labelled `No longer current`, and remained manually readable;
- a fresh profile was excluded from `showToNewUsers: false` items after more than 30 minutes, while manual history remained available;
- raw HTML did not execute, unsafe schemes produced no actionable links, all three authored images loaded, and no document viewport overflow was present;
- dark/light themes, 1280×900 and 800×600 layouts, Escape, close controls, focus movement, table/code overflow and a reachable footer were exercised;
- after all three fixture feeds were replaced with empty feeds, a final application restart reported `items: 0`, `candidateId: null` and rendered the empty history state.

Representative screenshots were captured for the isolated desktop verification run.

## Release boundary

No merge, app release, Render deployment or live content publication was performed. Live Render MIME/cache/404 headers therefore remain a deployment-time verification from the publishing runbook. The repository and generated production output are intentionally empty, so this branch cannot expose a test post to users. Before enabling production content, protect `main` with PR-only changes and require `announcements-content-check`.

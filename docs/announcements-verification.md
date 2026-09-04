# Announcements implementation verification

Date: 2026-09-04. Baseline commit: `690390af772017fb16327c6f4842803f84379a24`. Verification used the uncommitted implementation working tree.

## Automated checks

- `pnpm typecheck`: passed.
- Focused Vitest run: 92/92 passed across domain, main, source/cache, shell, IPC, preload, renderer, Markdown and shared overlay behavior.
- Publishing invariants: 9/9 passed; immutable-content check against `HEAD` passed.
- Actual landing generation: passed, including 121 prerendered routes. The generated deployed-shape feed byte-matches the generator output.
- `git diff --check` for the implementation scope: passed.
- The broad type-aware lint run found two implementation errors. Both were corrected and their owner-scoped ESLint runs passed. The run also reported pre-existing repository warnings.
- The source-size guard still reports the pre-existing unowned five-line growth in `src/renderer/index.css` (1955 vs frozen 1950); the announcement implementation does not add CSS there. All new announcement production files stay below the 800-line limit.

Production author content contains only `feed.config.json`. Both `landing/public/announcements/feed.v1.json` and the generated Nuxt output contain `autoShowEnabled: false`, `items: []`, revision `67851cfed97b51f4caa7c2ebb4e861ea2a294338c423590feca54d2b0b313a3c`.

## Isolated Electron E2E

Every run used a separate temporary Electron `userData` root and Claude root, a loopback-only content server, an explicitly verified Electron PID and the `dev:mcp` renderer CDP endpoint. No project, team, agent, terminal, provider action or native folder picker was opened. Native focus was staged only for the owned temporary window; all workflow input used CDP clicks and keys.

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

Representative screenshots are stored under `/Users/belief/.codex/visualizations/2026/09/04/01a06d09-7ee4-7070-8cf6-3f602d09be7a/announcements`.

## Release boundary

No commit, push, PR, app release, Render deployment or live content publication was performed. Live Render MIME/cache/404 headers therefore remain a deployment-time verification from the publishing runbook. The repository and generated production output are intentionally empty, so this working tree cannot expose a test post to users.

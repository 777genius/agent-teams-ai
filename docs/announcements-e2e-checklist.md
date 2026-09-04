# Announcements desktop QA inventory

This is an execution checklist, not proof that unchecked scenarios passed. Record evidence under the generated sandbox, together with the tested commit SHA. Do not create teams, authenticate providers, open terminals, or select real projects.

## Fixture and runtime

1. `node scripts/e2e/announcements-desktop.mjs --seed` creates a fresh `announcements-desktop-e2e-*` directory under the canonical OS temp directory. It contains isolated `user-data` and `claude` roots, author fixtures and generator-produced hashed bodies/assets. Production author content remains untouched.
2. `node scripts/e2e/announcements-desktop.mjs --serve --root <root> --port 9477` starts the owned loopback fixture server. Keep its PID for narrow cleanup.
3. Start `pnpm dev:mcp` with `AGENT_TEAMS_ELECTRON_USER_DATA_DIR=<root>/user-data`, `AGENT_TEAMS_ELECTRON_CLAUDE_ROOT=<root>/claude`, and `AGENT_TEAMS_ANNOUNCEMENTS_FEED_URL=http://127.0.0.1:9477/announcements/feed.v1.json`. Use the project runtime-safe dev environment. The harness does not launch Electron.
4. `node scripts/e2e/announcements-desktop.mjs --verify --root <root> --app-pid <Electron-main-pid> --cdp-port 9222 --scenario initial` validates process isolation evidence before attaching to exactly one intended renderer. It writes inspection JSON and a PNG into the sandbox. `rich` and `empty` inspect those states after operator navigation.
5. Mutate the feed with a bounded HTTP POST, for example `curl --max-time 10 -X POST 'http://127.0.0.1:9477/__fixture?scenario=new'`. Available scenarios: `ten`, `new`, `edited`, `expired`, `cohort`, `offline`, `online`, `empty`. The server uses the production generator, including `bodyPath` and `bodySha256`.

Use real CDP input dispatch or Playwright clicks/keyboard for navigation and dismissal. Evaluation is restricted to DOM inspection and sandbox setup; invoking application handlers from evaluation does not count as workflow evidence. The helper `scripts/e2e/announcements/cdp.mjs` exposes bounded `send`, `inspect`, `click`, and `key` operations.

## Behavioral evidence

| Check               | Procedure                                                                                                                     | Required observation                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Fresh profile       | Start with zero usage and ten posts                                                                                           | No automatic modal. News entry immediately opens manual history with ten posts.                                              |
| Accumulated usage   | Close sandbox app. Run `--seed --root <root> --usage-ms 1798000`. Relaunch same profile; let actual usage tick pass threshold | Latest post auto-opens after real elapsed time, never before eligibility. State writes retain time across launches.          |
| Single latest       | Ten eligible posts                                                                                                            | Only fixture-10 auto-opens. Closing does not enqueue fixture-09.                                                             |
| Close/restart       | Dismiss latest with Escape or close button, stop and relaunch same profile                                                    | Same ID and older posts remain absent automatically. Manual history still works.                                             |
| New ID              | Publish `new`, refresh through UI or wait actual poll                                                                         | Fixture-11 auto-opens when idle and eligible.                                                                                |
| Same-ID edit        | Dismiss newest, publish `edited`, refresh                                                                                     | No repeated automatic presentation; manual body contains UPDATED SAME ID.                                                    |
| Expiry              | Fresh disposable profile, publish `expired`, seed eligible usage while stopped                                                | No auto modal; expired posts remain readable manually.                                                                       |
| Cohort              | Fresh disposable profile, publish `cohort`, seed eligible usage while stopped                                                 | No auto modal for fresh cohort; manual history remains available. Also exercise legacy/unknown eligibility in service tests. |
| Offline cache       | Read rich post online, publish `offline`, refresh via UI                                                                      | Cached manual body works; offline state appears; no unvalidated automatic claim. Restore `online`.                           |
| History blocks auto | Open manual history, publish new ID and wait actual poll                                                                      | History is not replaced by an automatic article. Close history, then verify eligible handling.                               |
| Legacy overlay      | Open existing app dialog through UI, publish new ID/poll                                                                      | Existing dialog stays foremost; auto waits until overlay closes.                                                             |
| Empty final feed    | Publish `empty`, refresh via UI, restart                                                                                      | No auto modal and no history items; manual empty state works. Run `--verify ... --scenario empty`.                           |

Reseeding refuses an active sandbox Electron process. Preserve existing state fields when changing accumulated usage; never edit real profiles. Restart checks require closing the owned Electron process gracefully so shutdown persistence can complete.

## Rich Markdown and safety

Fixture content covers headings 1-6, bold/italic/strike, nested quotes, ordered/nested/task lists, GFM rich table and links, inline code, TypeScript/Python/JSON/Bash/text fences, 35 long code lines, an unbroken word, Cyrillic/Japanese/emoji, a wide PNG banner, authored raster pipeline, and tiny GIF.

- [ ] Review desktop wide/narrow widths in light and dark themes. Capture actual renderer PNGs for each. Check modal title/footer, body scrolling, table/code horizontal scrolling, no viewport overflow, and readable colors.
- [ ] Scroll entire document and inspect all three loaded images. `--verify --scenario rich` checks body completion, image loading and viewport overflow; capture additional scrolled screenshots for table/code sections.
- [ ] Tab navigation, visible focus, Escape dismissal and focus restoration work.
- [ ] Unsafe javascript/file/command/task/team/vscode/data links are inert text. Raw script, iframe and button cannot execute. DOM inspection must find no unsafe actionable hrefs.
- [ ] Interact with unsafe rendered labels using actual input and record no shell/external/file IPC or filesystem effects. DOM sanitization alone does not prove absence of privileged effects; use focused security tests or an explicit IPC spy in the isolated test setup.
- [ ] Safe HTTPS link behavior is covered by focused tests; avoid opening outside browsers merely to prove a click in this run.

Harness verification reports only the assertions it actually executes. Remaining table rows require recorded manual/CDP evidence or focused test results. Stop only the owned fixture server and sandbox app after publishing and verifying the final empty feed; leave unrelated processes untouched.

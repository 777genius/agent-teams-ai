# Comment notification desktop regression

Run from the repository root on Linux with installed frozen dependencies and
rebuilt Electron native modules:

```sh
xvfb-run -a -s '-screen 0 1280x900x24' node scripts/e2e/comment-notification-desktop.mjs
```

Requires Node/pnpm versions pinned by the project, `xvfb-run`, `dbus-daemon`, `libnotify4`, and
`/usr/bin/python3` with `dbus` and `gi`. The harness owns `pnpm dev:mcp`; keep its
default CDP port 9222 free. Root-owned Linux CI uses Electron's `NO_SANDBOX=1`.

Each run creates a new `comment-notification-TEST-*` directory in the system
temporary directory. HOME, Claude data, Electron userData, TMPDIR and XDG roots
are isolated. The fixture contains a new empty TEST project and no provider
credentials. Its runtime wrapper answers version checks and rejects all other
calls with exit 77. Blocked startup availability probes are retained as evidence;
lifecycle commands are rejected and fail the test. No team, agent or terminal is
launched.

The test exercises real Electron main/preload/renderer, task and inbox readers,
filesystem watching, comment forwarding journal, notification persistence and
the `org.freedesktop.Notifications.Notify` boundary on a private D-Bus session.
Missing native notification support fails the run. Ordinary inbox and fresh
comment controls must reach the native boundary, so silence alone cannot pass.

Assertions cover:

- Historical comments from current and removed members on startup.
- An old comment recovered after inbox baseline with a new envelope timestamp.
- New comments exactly once, including one created during the first task fetch.
- Repeated and reordered snapshots, renderer reload and full app restart.
- Comment toast toggle, independent ordinary inbox delivery, and unchanged
  preexisting read/unread history.

The initial-fetch race holds only the API module's `getAllTasks` transport using
CDP response interception, then delegates to real preload IPC. It does not mock
task data, clocks, notification logic or the native notification API.

The final stdout line names the artifact directory. `evidence.json` includes
per-step counts and history, `native-notifications.ndjson` records native calls,
and screenshots show the actual renderer. `desktop.log` streams while the test
runs. Artifacts remain available after success or failure; only owned processes
are stopped. Exit 0 means all assertions passed. This proves Linux Electron
notification dispatch; it does not exercise macOS or Windows notification UI.

The production fix keeps internal `task_comment_notification` forwarding
envelopes out of user notifications in both inbox and sent-message paths. The
task detector owns comment notifications and applies the context-start cutoff,
including the first snapshot. Forwarding/journal recovery and existing unread
records remain intact. Related prior fix: https://github.com/777genius/agent-teams-ai/pull/629.

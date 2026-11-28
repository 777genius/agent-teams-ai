# PR Monitor desktop integration

Baseline: `589e3cf5cf59fd8d1e3224e8ed6df8ebeaf1e65c`.
Package provenance: [`vendor/pr-monitor/manifest.json`](../../vendor/pr-monitor/manifest.json).

## Scope and ownership

The project-scoped Pull Requests tab composes the reusable PR Monitor packages.
`@pr-monitor/core` owns models and CI, review and merge projections;
`@pr-monitor/github` owns bounded GitHub reads, provider mapping and its real Get
Modular group; `@pr-monitor/react` owns list and timeline presentation. Desktop
owns selected projects, explicit account consent, native credentials, transport
adapters, polling and process boundaries.

The feature follows `docs/FEATURE_ARCHITECTURE_STANDARD.md` under
`src/features/pr-monitor`. Pure application ports and authorization transitions
stay in `core/application`; technical mechanisms live in `main/infrastructure`;
composition wires those ports; IPC, HTTP and preload are thin input adapters;
renderer hooks own interactions and `renderer/ui` is presentational. The shell
imports public feature entrypoints. Existing ESLint configs include explicit
feature boundary rules, composing the preceding feature guards.

## Project and account authorization

Main resolves a project ID against the current context's existing
`projectScanner.scanWithWorktreeGrouping()` result, then lazily uses the existing
Git identity resolver for that known worktree. The renderer cannot submit a path,
provider URL, shell command, token or arbitrary repository. Non-local contexts
and non-GitHub remotes fail with a safe, actionable result.

Connect GitHub checks `gh auth status --hostname github.com --active --json hosts`.
It parses the active account state, since JSON output alone is not proof of
successful authentication. A valid signed-in CLI account is preferred. The
adapter uses existing CLI discovery, PATH and bounded subprocess helpers;
credentials remain with GitHub CLI. Identity is checked before and after each
list/detail operation. Switching CLI accounts invalidates the repository grant
and discards the result, including a revocation during the final identity check.

Repository grants last for the process and own an abort controller and a fresh
reader. Disconnect, context replacement, sign-out and a new login abort previous
work. Readers and ETags never move to a new grant/account. Get Modular owns
construction; the application owns active account, cancellation and refresh.
All provider operations are reads. The library's shared path validator owns the
endpoint grammar; the CLI adapter also binds it to the authorized repository and
a fixed github.com host.

## Backendless sign-in

When CLI authentication is unavailable, a separately configured GitHub App can
authorize Desktop through Device Flow. No callback server, custom backend or
client secret is required. Main requests the code, bounds polling and handles
pending, slower polling, denial, expiration and cancellation. Only the public
verification code, URL and expiry cross IPC. Device, access and refresh tokens
stay in main. Every new/refreshed token is checked against GitHub user identity
before being retained; an identity change fails closed.

Configure the public client ID with `AGENT_TEAMS_GITHUB_CLIENT_ID` and set
`AGENT_TEAMS_GITHUB_APP_KIND=github-app`. The dedicated App must enable Device
Flow and have read permissions for Pull requests, Checks, Actions, Commit
statuses and Metadata. Install it for repositories to monitor; organization
approval may be required. Expiring user tokens and refresh are supported. No
other application's client ID is borrowed. Without registered configuration the
UI reports that sign-in is not configured and offers the authenticated CLI route.

An authorized OAuth App can instead use `AGENT_TEAMS_GITHUB_APP_KIND=oauth-app`.
Its `repo` scope permits more than read-only access, which the login UI discloses.
PR Monitor still issues only its restricted reads. Prefer the dedicated GitHub
App's selected repository access and read permissions.

The token vault reuses `ApiKeyService` through a dedicated main-only instance in
`pr-monitor-credentials`, separate from the generic service whose lookup API is
renderer-accessible. It opts into a strict secure-backend policy: missing/locked
system keychain, encryption failure or insecure persisted record is rejected.
The existing local fallback policy remains unchanged for unrelated callers.
Serialized writes and post-await cancellation checks remove a new credential if
login was canceled during replacement. Sign out and Forget saved sign-in erase
the saved connection; Disconnect revokes that repository's process-local grant.

Official protocol references:

- [GitHub App device authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)
- [OAuth App device authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GitHub CLI account status](https://cli.github.com/manual/gh_auth_status)

## Process and UI boundaries

IPC requires the primary WebContents, its top frame and exact shell renderer URL
(hash navigation is allowed). It compares protocol and host as well as pathname
and query, including production file URLs. A foreign page in that WebContents
cannot use the feature. HTTP has read-only parity with the same project service
and existing same-origin/loopback checks. Login and consent actions are native.

Polling runs every 30 seconds while visible, backs off after failure and honors
Retry-After for manual and automatic reads. Hidden/inactive views stop scheduling.
Context epochs and operation ownership discard stale results. Local account
transitions and authorization revocation clear old observations immediately,
including during a provider cooldown. Cached timelines remain visibly stale
after transient failures. CI, review and merge remain independent; previous-head
reviews do not imply approval after a new push.

## Dependency delivery

The three 0.1.0 archives are pinned to one source commit and SHA-256 manifest.
Their lockfile integrities are checked by frozen installation. The local core
override resolves unpublished transitive imports. React and React DOM are patched
together from 19.2.4 to exact 19.2.5 so the library and consuming hosts use one
qualified cohort without a second runtime.

## Verification and delivery gates

Focused tests cover project membership, contexts, explicit consent, credential
isolation, strict OS encryption, refresh/cancellation races, request bounds, IPC
origins, HTTP parity, outdated selections and rate limiting. Use pinned native TS7:

```sh
pnpm typecheck:pr-monitor
pnpm exec vitest run test/features/pr-monitor test/features/notification-channels/credentialIsolation.test.ts
```

The Linux native scenarios create an owned display, disposable project/config
and isolated vault, then drive the real `dev:mcp` renderer through CDP. Only the
external GitHub CLI or issuer/REST boundary is a fixture. No agent runtime may
run. Device Flow exercises the actual OS keychain and rejects local AES fallback;
it does not claim a live authorization against the owner's GitHub App.

```sh
dbus-run-session -- node scripts/e2e/pr-monitor/linux-session.mjs
dbus-run-session -- node scripts/e2e/pr-monitor/linux-session.mjs --device-flow
```

Linux needs Xvfb, DBus, GNOME Keyring and libsecret. CI installs these and configures
Chromium's sandbox helper. Restricted local containers may opt into
`PR_MONITOR_E2E_NO_SANDBOX=1` for this disposable test. Explicit test binary paths
are supported with `PR_MONITOR_E2E_XVFB` and `PR_MONITOR_E2E_KEYRING`.
`PR_MONITOR_E2E_OUTPUT_DIR` retains screenshots and a structured receipt.

Native cases cover list/detail, independent lanes, stale-head review, attempt
history, a new head, 401, bounded 429 cooldown, revocation, token isolation and
renderer errors. The dedicated workflow requires both CLI and Device Flow cases.
Development Electron evidence is distinct from packaged qualification and live
account login. Source-size, inherited full checks, independent review and required
current-commit CI remain the integration PR's merge gates.

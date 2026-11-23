# Notification Channels — local-first research and choice gate

Status: **Research only / DECISION REQUIRED** · 2026-11-23
Repository baseline: `main` at `e876918f362e2fad55dbf47996e3ba346dbc22b9`.
Independent companion: `docs/plans/2026-11-23-user-attention-inbox-mvp.md` (in another Draft PR).
**No provider, dependency, runtime, authentication design or implementation is approved by this PR.**

## 1. Requirement and invariants

- Feature 2 is **outbound delivery routing and user-managed destinations**, not the User Attention Inbox, and not bidirectional messenger conversations.
- No vendor-hosted Agent Teams backend, always-running external daemon, mandatory Docker/Python installation, or new local web server as a default requirement.
- When the **desktop app is running**, it may send HTTPS requests directly, use a packaged CLI child process on demand, or run a strictly local sidecar while needed.
- When the desktop app is **closed**, no new local outbound deliveries are possible. Do not advertise background/offline delivery without some other always-on infrastructure.
- Existing in-app notification storage and OS toasts retain their exact default behavior. External destinations are **opt-in**, with test-send and visible per-destination health.
- Settings are usable by a normal non-technical user (guided setup, masked token, test, explain errors). Advanced users can configure arbitrary supported destinations.
- Preserve feature-standard dependency direction and HTTP/server portability: no delivery policy in Electron IPC or React, no `window.electronAPI` in feature UI.
- Do not mix agent-to-agent messages, hidden prompts, private internal metadata, or full raw message feeds into external notifications.

## 2. Existing code and integration boundary

| Existing owner | Current fact | Implication |
| --- | --- | --- |
| `src/shared/types/notifications.ts` | `TeamEventType` includes `user_inbox`, `task_clarification`, `task_status_change`, `task_comment`, `task_review_requested`, `task_blocked` and others | Reuse event taxonomy; no new trigger parser |
| `src/renderer/components/settings/sections/NotificationsSection.tsx` | Existing toggles `notifyOnUserInbox`, `notifyOnClarifications`, `notifyOnToolApproval` etc. | Put destination routing near these, preserve switches and defaults |
| `src/main/services/infrastructure/NotificationManager.ts` | Single history pipeline, max 100 entries, storage even with OS toast suppressed; emits `notification-new` | Tap committed normalized events, not renderer toast detection; notification history is **not** an offline delivery queue |
| `src/renderer/store/team/teamGlobalTaskNotifications.ts` | Renderer detects clarification and sends `showMessageNotification` to main; de-dup in memory; first-fetch seeding | Do not dispatch every fetch/restart or use renderer de-dup as provider delivery authority |
| `src/main/index.ts` | Inbox/sent message notification paths already generate `user_inbox` events | Reuse committed events and respect existing explicit source suppression |
| `src/main/services/team/provisioning/TeamProvisioningToolApprovalNotifications.ts` | Tool approval is its own transient/native notice path | Needs separate opt-in event bridge if included; **not silently covered** by NotificationManager |
| `src/renderer/api/httpClient.ts` / `src/main/http` | Existing Fastify HTTP endpoint and SSE, but incomplete browser APIs | New facade can have thin IPC/HTTP adapters; no mandatory HTTP listener for desktop outbound requests |
| `docs/research/messenger-connectors-uncertainty-pass-27.md` … `-35.md` | Pre-existing research on Telegram identity/ACK/replies/topics | Reuse when separately designing **inbound** Telegram, not needed for outbound notifications |

## 3. Candidate implementations — verified sources and trade-offs

### Option A — native Node/TypeScript HTTPS senders (no binary, no server)

Deliver directly from existing application runtime via a tiny `DeliveryChannelPort`/adapter set:

- Telegram: official `sendMessage` over HTTPS, after explicit bot-token + chat binding; user needs to initiate bot chat before notification. Manual chat ID fallback, opt-in test send. Do not set webhook for outbound-only.
- Generic HTTPS webhook: safe fixed payload; Discord/Slack incoming webhook variants only where official endpoint contract differs.
- ntfy: POST to selected topic on ntfy.sh or user's service; message is processed by that service. Never claim third-party services are private or guaranteed free.
- Add an optional *adapter* for an existing external automation service; do not bundle n8n/Novu.

Pros: smallest operational burden, best OS packaging, native settings UI, fastest onboarding for 3-5 popular channels. Cons: maintain provider API quirks; not instantly 100+ destinations. **Ease 8/10**, breadth 4/10, UX 9/10. Estimated **550-1,100 production LOC + 350-650 tests**, excluding extended localization/packaging.

Sources:
- https://core.telegram.org/bots/api#sendmessage
- https://ntfy.sh/ and https://docs.ntfy.sh/privacy/

### Option B — packaged Shoutrrr CLI (multi-provider, no server)

**Two different projects/maintenance histories; do not confuse them.**

- Original: `containrrr/shoutrrr`, latest tagged v0.8.0 from 2023; avoid making that frozen release the default without review.
- Maintained fork: `nicholas-fedor/shoutrrr`, releases and platform binaries documented through v0.22.x in October 2026. Supports Telegram, Discord, Slack, Matrix, email, ntfy, Gotify, generic webhook, etc.
- One-shot Go CLI can send notifications without a persistent HTTP service. Its CLI supports `SHOUTRRR_URL` from environment and message from stdin, reducing secrets in *command-line arguments*. Environment values still have local process exposure risk, and verbose output may reveal URL/body; never enable verbose in production.
- Browser Playground can help **generate** provider URLs, but browser test-send is limited by CORS. It is not an authenticated local configuration manager. Favor 3-4 polished native presets plus an Advanced Service URL.
- Need assess fork pin, license (MIT as published), binary provenance, code signing/notarization, updates, size, arm64/x64/Windows/Linux builds and subprocess timeout/restart/cancellation. Never execute arbitrary shell.

Pros: broad service catalog, no Python, no long-running server, thin integration. Cons: separate Go binary to ship/patch; service URL handling and onboarding UX; fork maintenance risk; child-process secret handling. **Ease 6/10**, breadth 8/10, UX 7/10 with a native wizard. Estimate **800-1,550 production LOC + 500-900 tests**, plus packaging/E2E. A candidate for **best breadth-to-operations ratio**, subject to spike.

Sources:
- https://github.com/containrrr/shoutrrr/releases
- https://github.com/nicholas-fedor/shoutrrr
- https://shoutrrr.nickfedor.com/v0.22.1/usage/cli/send/
- https://shoutrrr.nickfedor.com/v0.22.1/playground/

### Option C — Apprise CLI / Python library (very broad, without permanent server)

- `caronc/apprise` reached v2.2.0 in November 2026, announcing **183 services** and a security fix. v2 is a breaking API generation; do not copy v1 integration snippets without review.
- CLI executes notifications and can load provider URLs from a **permission-restricted local config file**; recommend this over secrets on process command lines.
- Official **Apprise URL Builder** is a browser-based, client-side form for preparing a service URL. User can open it from app, build a configuration, and paste it; browser URL deliberately excludes secrets.
- Out-of-the-box desktop packaging means bundling Python/Apprise with all required dependencies on 3 OSes, distributing patched versions and validating notarization/AV behavior. Asking user to install Python is **not** out-of-box.
- Alternative: optional connector to an already installed Apprise executable. Do not treat this as the default experience.

Pros: widest catalog and familiar provider UI/documentation. Cons: major size, supply-chain/runtime complexity and security patching. **Ease 4/10**, breadth 10/10, UX 7/10 with URL Builder + our settings. Estimate **1,100-2,100 production LOC + 600-1,050 tests**, plus bundled Python distribution work.

Sources:
- https://github.com/caronc/apprise/releases?after=v0.8.1
- https://appriseit.com/library/
- https://appriseit.com/url-builder/
- https://appriseit.com/library/configuration/

### Option D — on-demand LOCAL Apprise API + its ready-made web UI

- `caronc/apprise-api` has a built-in web configuration manager; documented local port (default 8000), persistent configs, optional authentication, API and test-send.
- If Apprise API is **also the delivery engine**, it must run for the **entire desktop session** (closing Settings must not stop delivery). If it is only an on-demand configuration page, another local engine must deliver after Settings closes, creating a second runtime/sync problem. In either mode bind `127.0.0.1` on an ephemeral port, authenticate every request, protect credentials/CSRF/DNS rebinding, close the process on app exit. **Never** expose it to LAN/public internet or ship the unauthenticated default.
- This is still a **local backend process** and a heavy Python/Django-based distribution (or Docker image), even though no hosted Agent Teams server exists. It cannot send new messages after app exits. Treat on-demand website setup and ongoing notification delivery as distinct responsibilities, not as a free substitute for a running dispatcher.
- Need assess whether API's own storage and our app config become two conflicting authorities; prefer using it as an advanced **external** service rather than default bundled UI.

Pros: ready visual manager and >100 channels, minimal UI code. Cons: biggest deployment/lifecycle/security/duplicate-state surface, not actually "no backend". **Ease 2-3/10**, breadth 10/10, UX 8/10 once running. Rough **1,600-3,000 integration production LOC + 800-1,500 tests**, **plus** bundling/size/security.

Sources:
- https://github.com/caronc/apprise-api
- https://github.com/caronc/apprise-api/releases

### Option E — webhook to an existing user service (n8n/Make/Zapier/IFTTT/ntfy/Gotify)

- Agent Teams only needs an HTTPS webhook adapter, while connected service handles fan-out. **No backend hosted by Agent Teams**, but external service/account/self-hosting is the user's responsibility.
- Lowest engineering cost, especially for power users. Not "works instantly" without user setting up a flow; privacy/price/availability differ by service.
- ntfy/Gotify deliver push but are destination systems, not replacements for routing and provider-agnostic notification policy.
- **Ease 9/10**, breadth 8/10 through external workflows, UX 4/10 for novices. Estimate **450-900 production LOC + 300-500 tests** for generic webhook/policies/UI, excluding external workflows.

Sources:
- https://ntfy.sh/
- https://github.com/gotify/server
- https://github.com/n8n-io/n8n

### Rejected as default: Novu or n8n embedded

Novu self-hosted requires multiple services (API, worker, WS, MongoDB, Redis); n8n is also a separate runtime/workflow service. Both are powerful but violate the simplicity/no-running-backend constraint **as mandatory embedded defaults**. Can be targets behind generic webhook. Source: https://docs.novu.co/community/self-hosting-novu/overview and https://github.com/n8n-io/n8n .

## 4. Side-by-side decision table

Subjective scores (10 = more desirable). LOC includes feature UI/routing/security, **not** independent provider/backend runtime source code.

| Option | App-owned always-on service? | Extra runtime | Broad catalog | Easy onboarding | Production LOC | Technical risk |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| A. Native HTTPS | No | None | 4/10 | 9/10 | 550-1,100 | Low-medium |
| B. Shoutrrr CLI fork | No | Packaged Go binary | 8/10 | 7/10 | 800-1,550 | Medium |
| C. Apprise CLI | No | Packaged Python+deps | 10/10 | 7/10 | 1,100-2,100 | Medium-high |
| D. Local Apprise API web | **Yes, on demand** | Local Python/Django service | 10/10 | 8/10 | 1,600-3,000 | High |
| E. Generic webhook | No (externally: maybe) | External user service | 8/10 | 4/10 | 450-900 | Medium |

**Provisional research preference, NOT a selection:** A is the simplest shipped UX for 3-5 channels. B is a credible alternative if the product requires 15+ services without implementing each. C/D only justify their packaging burden if a very broad catalog + ready-made web interface is the dominant requirement. E should be supported whichever approach is selected.

## 5. UI design regardless of provider choice

Settings > Notifications > **Delivery channels** (a distinct section, never hide existing notification toggles):

1. Destination cards: **Desktop (existing, enabled)**, Telegram, Webhook, ntfy, Discord/Slack, **Advanced** (if selected engine supports more).
2. Add destination -> service-specific short wizard: instructions, masked credentials, connection/test-send, confirm target, save. Display errors **without tokens**. Never require URL syntax for top providers.
3. Per-event routing grid: **Agent sent you a message**, **Task needs your clarification** (existing two critical switches), optional **Tool needs approval**, **Manual action required due to error**. Each row selects destination chips; reasonable default **Desktop only** and no external destination.
4. Destination status: enabled/disabled, last test result, recent delivery outcome (do not claim sent if timeout/unknown). Provide "Send test" and "Disconnect".
5. Delivery data privacy: default minimal content (team + event title + app link), user opt-in to include **sanitized preview**. Never transmit prompt/system blocks, attachments, raw session traces or secrets.
6. App link opens correct task/chat only if the app supports a secure deep-link handler. Initially use an actionable label plus local identifiers; do not invent a clickable URL to a nonexistent hosted app.
7. UI is React/Radix and shared renderer API; choose native settings **by default**. Offer external URL Builder as an optional help link. Do not launch a public localhost configuration server merely to avoid writing a few input fields.

### Telegram-specific UX caveat

Outgoing `sendMessage` does not require inbound webhook. A user must start the bot or otherwise authorize delivery. A connect wizard may briefly inspect `getUpdates` if compatible with the bot's current mode, but **must not delete existing webhooks or hijack bots**. Always support manual chat ID and a test/verification message. Separate, stronger pairing/identity validation is needed if enabling replies.

## 6. Architecture boundary for chosen future implementation

```text
existing notification producers
  -> committed normalized notification/event  (dedupe once)
  -> core/application: route by event type and user preference
  -> DeliveryPort                          (no Electron/transport types)
  -> optional adapters:
       main: HTTPS native / Shoutrrr process / Apprise CLI / Apprise API
       HTTP/server: same application facade, authenticated settings/read routes
  -> delivery outcomes and tiny bounded retry journal
settings renderer -> app API abstraction -> validated prefs + secret references
```

Reuse event types and `NotificationManager`'s existing persistence/dedupe semantics. Do **not** wire all source producers a second time. Only committed new events are candidates; startup historical records are **not** replayed. Provider dispatch should be nonblocking and not hold main Electron event loop. The tool-approval path currently bypasses the standard stored notification stream, so adding it requires a focused, explicit adapter and separate tests.

- Secret material belongs behind a `CredentialStorePort` with OS/app-safe storage, not plaintext in `AppConfig`, arbitrary service URLs, renderer logs or analytics. Keep settings DTOs masked; use secretRef/token handle.
- Normalize notification title/body/event identity, dedupe, optional **bounded** local retry with exponential backoff and typed outcome: `delivered` / `failed` / `unknown`; no retry storm or misleading "exactly once" guarantee (Telegram external API has no client-supplied idempotency key).
- Generic URL/webhook must defend against SSRF (loopback/LAN/metadata/redirects/DNS rebinding) as appropriate to explicitly allowed local advanced workflows; default HTTPS public endpoints. Restrict headers, payload length, timeouts and redirects.
- For CLI engines, use `spawn` / `execFile` with `shell:false`, securely pinned binary path, process kill/timeouts, redaction. URL in CLI argv is not acceptable; env is safer but **not fully secret**; assess config file/secure pipe if available. No verbose provider logs or exceptions containing credentials.
- Do not send test messages until user expressly clicks test/verification. Test-send and save/enable are separate actions; validate target ownership sufficiently to avoid leaking private notifications to wrong chats.
- Configuration version migration defaults all new external routes to off. OS native/in-app settings behavior unchanged even when routing fails.
- Local service (if later chosen) is process-lifecycle owned: loopback only, random port, auth, explicit start/stop, shut down on app exit, no long-running background install. HTTP parity for new configuration APIs should not require running that sidecar in Electron.

## 7. Targeted spikes required BEFORE choosing a provider

| Spike | Must prove | Fail / go-no-go condition |
| --- | --- | --- |
| A: native | Telegram + ntfy + generic webhook test in isolated fixture, short in-app wizard; no long-running process | Can't validate target with understandable UX; unsafe webhook |
| B: Go CLI | Pin/checksum specific fork release; macOS arm64/x64, Windows x64, Linux; stdin message + secret transport; packaged Electron and child termination; generated URL example | Token leaks, binary size/signing failure, unmaintained/untrusted dependency |
| C: Apprise CLI | Current v2.2.x version + security advisory patched, packaging with Python and signed app; two service tests; file credential security | Runtime install required / bundling or patch burden unacceptable |
| D: local web UI | Loopback authenticated browser config under packaged app, CSRF/DNS rebinding tests, no Internet exposure, clean exit and secret sync | Requires Docker, insecure defaults, duplicated config or unbounded background process |

No spike or implementation is performed in this research PR. These are explicit gates for a subsequent implementation PR after user decision.

## 8. Threats and default-safe policy

- **Privacy:** external service gets what we send; use opt-in routing and minimum payload; provide preview toggle and clear service disclosure. Public ntfy.sh topic names can be guessable; use a strong/random topic with account controls where possible.
- **Identity:** Telegram bot token/chat ID mistakes can leak messages; confirm with user-visible test, not only syntactic validation.
- **Delivery truth:** timeout after provider accepted is **unknown**, not proven failure; avoid automatic duplicates on blind retry.
- **Runtime:** app quit/offline/restart/URL changes; retries bounded, process not orphaned, local server not left running.
- **Context:** root/workspace changes and multiple team names; no routing another workspace's private content.
- **Logs:** redact URLs, tokens, message bodies, API responses; error copy must be safe to paste into support tickets.
- **Supply chain:** freeze dependency version/checksum/licensing and scan shipped binaries; Apprise v2.2.0 security patch makes old unpinned version unsafe to assume.
- **HTTP:** never expose bot secrets in client route or broaden existing HTTP server to LAN simply for configuration.

## 9. Reviewed alternatives (four critical passes)

1. **Operational simplicity**: rejected default Novu/n8n/always-on Apprise API because shipping a local Electron app should not require databases or a daemon.
2. **Delivery correctness**: rejected "just forward each renderer toast" and unbounded retry. Built on normalized committed events, no replay of historical notifications; explicit unknown outcome.
3. **Security & packaging**: rejected URL secrets on command line, unauthenticated localhost config UI, arbitrary webhook SSRF, or promise that an external service is private. Also corrected the local API lifetime fallacy: closing configuration UI cannot terminate a delivery engine still needed while the app runs.
4. **UX/DRY**: rejected rebuilding full per-provider settings forms when an OSS engine could handle many services; balance 3-4 guided native presets plus advanced service URL/help page. Do not share a notification list with the Action Inbox.

## 10. Decision requested from product owner

Pick **one delivery engine** for the default install:
- **A — Native minimal**: Telegram + webhook + ntfy + 1-2 popular destinations; smallest and cleanest.
- **B — Shoutrrr CLI**: bundled Go binary, 15+ ready destinations and guided presets; candidate broad-without-backend.
- **C — Apprise CLI**: 183-service ambition, Python packaging accepted.
- **D — Apprise API local web UI**: prefer ready-made website, willing to accept on-demand Python server and security burden.
- **E — Webhook-first**: external automations are primarily the user's responsibility.
- **F — Thinwrap TypeScript**: no extra executable/server; built-in Telegram, Discord, Slack, Teams and Google Chat adapters.

**Decision superseded on 2026-11-23:** the owner explicitly authorized autonomous, end-to-end implementation on this PR. Selected **F — Thinwrap**: outbound only, native presets in the existing settings UI, no extra binaries, and no added resident service. This resolves the original owner-choice gate; do not interpret the earlier question as an active blocker.

Suggested narrow follow-up after choice: one implementation PR, small domain route policy, one selected engine adapter, initial 2 priority events, guided UI, tests, packaged E2E. Keep the User Attention Inbox PR independent.


---

## 11. Deep dive (2026-11-23): actual TypeScript libraries, not just CLI/servers

This section supersedes the five-option shortlist as the **current discovery set**. It DOES NOT approve an implementation. Compare standalone NPM packages before deciding to ship a Go/Python executable. All numerical scores/LOC below are estimates, NOT benchmark results. Sources were inspected at their actual project files and published docs. Reverify installed NPM tarball, version and lockfile before adoption.

### 11.1 The strongest ergonomic fit: `@ambersecurityinc/notifly` 0.7.2

Primary source: https://github.com/ambersecurityinc/notifly (actual `package.json`, `src/dispatcher.ts`, `src/builder/index.ts`, `src/builder/schemas.ts`, `src/services/{telegram,webhook,ntfy}.ts`, `src/security.ts` and tests).
NPM: https://www.npmjs.com/package/@ambersecurityinc/notifly
Web: https://notifly.sh/

What is **already built** (not a promise):
- `notify({ urls }, { title, body, type })` with capped concurrent sends (source dispatcher sets `MAX_CONCURRENCY = 10`), preserving per-destination success/failure;
- Service registry with URL schemes: Discord, Slack, Telegram, ntfy, Gotify, email **via HTTP gateway** (not SMTP), Microsoft Teams classic and Workflows, Pushover, Pushbullet and generic webhook. Roughly 10-11 service entries, some aliases, **not 183 Apprise plugins**.
- `@ambersecurityinc/notifly/builder` exports `getServiceSchemas`, `searchServices`, `validateFields`, `buildUrl`, `decomposeUrl` and `smartParse`. Schema fields carry label, helpText, required, sensitive, validation pattern, select options. **This genuinely cuts custom settings form code**.
- `smartParse` can recognize copied raw Discord/Slack/Teams/Gotify/ntfy webhook URLs, not any arbitrary provider.
- It uses standard `fetch`, no extra runtime server/binary/Python, and the version's own `package.json` uses TypeScript **7.0.2**. npm readme reports **zero runtime dependencies** and MIT.

Important **safety/quality limitations found by source audit**:
1. The repo is very young (created 2026-03-26, `0` GitHub stars and `0` forks at inspection, NPM around **tens** of weekly downloads; popularity is **not** maturity). It has tests, but **no independent shipping/E2E evidence for our desktop**. Pin exact version and check maintenance/releases. This can be a reason to reject it after audit.
2. `validateHost()` in `src/security.ts` explicitly documents that hostname-only checking does **not** mitigate DNS rebinding; generic `fetch` follows redirects unless constrained. The default generic webhook adapter cannot be treated as a hardened SSRF boundary; validated **connect-time** DNS/IP or a restricted destination policy is required when users can configure destinations and a remote HTTP client can access settings.
3. The generic webhook deliberately **blocks plaintext HTTP and private/loopback IPs**. That is safe-by-default but conflicts with a user's legitimate LAN/self-hosted endpoints (Gotify/ntfy) and local-only development. Do not silently promise arbitrary `localhost` or LAN webhooks; decide either public HTTPS-only v1 or an explicit advanced local trusted-host policy implemented at our network boundary. No unrestricted opt-out.
4. Service URLs encode **secrets** (Telegram token, Slack/Discord webhook token, Gotify token, Workflows `sig`). The URL Builder outputs complete URLs. Never write those into ordinary `AppConfig`, renderer telemetry, logs, app deep links, or support bundles. The UI can hold typed fields ephemerally; transport to trusted application service, then encrypted store and masked previews. Reconstruct URL in memory only for send.
5. `src/services/base.ts` and `webhook.ts` turn non-2xx into errors; `src/errors.ts` hides response body from enumeration, but `errorMessage()` returns ordinary `err.message`. Recheck all transport/framework error paths for URL/secret leakage and normalize messages at **our** boundary. No assumption that `success:false` means provider definitely did not receive message after timeout.
6. `webhook.ts` composes the target from host+pathname and parses custom query into header/body overrides, so not every signed arbitrary query URL survives unchanged; use a separately validated raw HTTPS webhook path only if required by user workflows, otherwise advertise the limited schema.
7. `registerService` mutates a global registry (could overwrite built-in schemes). Do not expose user-provided code/plugins via this feature. Use only pinned built-in names or app-vetted adapters.

**Recommendation level:** **best initial UX/implementation spike**, conditional on security/audit gates below; **not** an unconditional dependency choice.

### 11.2 `@thinwrap/notifications` 1.x (TypeScript alternative)

Sources:
- https://github.com/thinwrap/notifications-ts
- https://www.npmjs.com/package/@thinwrap/notifications

- Unified TypeScript `Email`/`Sms`/`Push`/`Chat` facades with typed provider IDs; NPM lists **35 providers** across **four categories**, not 35 chat-style destinations. Chat catalog contains Telegram, Slack, Discord, Microsoft Teams, WhatsApp Business, Google Chat, Mattermost, Rocket.Chat, LINE. It does **not** claim ntfy/Gotify in its published catalog.
- No vendor SDKs, zero runtime dependencies, injected `fetch` and normalized provider errors (source README explicitly describes URL secret/redaction precautions); MIT, Node 18+.
- **No published schema-driven configuration builder / Smart Paste equivalent**. We would implement more settings field metadata ourselves or adopt a separate schema package, which erodes DRY and increases maintenance.
- No server/binary required, but many providers assume a paid/managed API account. Strong fit for B2B Email/SMS/Push expansion, **weaker for fast end-user Telegram/ntfy/webhook onboarding**.
- New project (created 2026-06), modest adoption; security review still required. Verify NPM current version (website snapshots show 1.1.1 while publisher listing mentions 1.2.0) rather than hardcode a stale version.

**Recommendation level:** viable fallback if broader commercial delivery APIs matter more than ready-made UI metadata.

### 11.3 Established engines versus implementation ergonomics

**Shoutrrr fork (Go CLI):**
- https://github.com/nicholas-fedor/shoutrrr and https://shoutrrr.nickfedor.com/v0.22.1/usage/cli/generate/
- Source-doc `generate` is an **interactive terminal prompt**, including a Telegram-specific wizard that can discover user chat IDs after a message. It is *not a ready React UI component*, but its user prompts provide UX design inspiration. The playground is a public web form/URL generator, not a local private configuration authority.
- `send` can consume `SHOUTRRR_URL` env and body from stdin, so the app can spawn once per delivery with `shell:false` and no resident backend. URLs in environment variables still have leak risk; process memory and platform packaging must be audited.
- Go toolchain (source currently declares Go 1.27) is a **build requirement**; end users do not need Go if a binary is correctly bundled. Every supported desktop architecture must have trusted, signed/pinned artifacts, including Windows ARM64 if shipped.
- Better breadth/maturity of service catalog than young TS libs, but less direct UI reuse than Notifly's headless builder; binary release provenance/licensing and integration test required.

**Apprise Python CLI and API:**
- https://github.com/caronc/apprise/releases and https://appriseit.com/url-builder/
- 2026-11 `v2.2.0` adds total **183 services** and contains a security fix. The public URL Builder is **client-side** but is not a local settings store or notification sender. Source code is mature and broad; official CLI still needs a Python runtime (if bundled as desktop default).
- Apprise API supplies an actual ready-made browser configuration UI; an **Apprise API server must stay running during the entire desktop runtime if it is also the sender**. Shutting it off when the setup page closes would break delivery. Requires additional auth, process supervision and duplicate-setting reconciliation.
- Avoid embedding as default unless >100 plugins and web-admin outweigh packaging cost. Optional **externally configured Apprise API destination** is viable but moves server ownership to user.

**`@novu/providers`:** despite being a separate stateless package, the published 2.6.6 snapshot has ~**41 runtime dependencies**, NPM release appears much older than the 2026 platform; lacks a ready standalone channel setup UI, so **reject as the local-first default**. Novu Cloud/CLI channel connection is a different, hosted model. Sources: https://www.npmjs.com/package/@novu/providers and https://www.npmjs.com/package/novu .

### 11.4 Quantified comparison (2026-11-23, realistic App-owned code)

All numbers below estimate **feature code added/changed in our repo**, not lines in third-party libraries, native packages, binaries, or localization translations for every language. Test estimates include targeted unit/adapter and a modest E2E suite, **not** proving real API delivery on all platforms.

| Engine | No resident service | Headless React-ready form metadata | Approximate ready channels | Owned production LOC | Tests/E2E LOC | Integration ease / confidence |
| --- | --- | --- | ---: | ---: | ---: | --- |
| **Notifly 0.7.2** | Yes | **Yes, built-in** | ~10-11 | **850-1,500** | **500-900** | **9/10** ease, **6/10** confidence |
| **Thinwrap** | Yes | No | 35 total, **9 chat** | 1,000-1,750 | 550-950 | 7/10, 6/10 |
| **Shoutrrr Go CLI** | Yes | Terminal wizard, **not native UI** | many service plugins | 950-1,800 | 550-1,050 | 6/10, 7/10 |
| **Apprise CLI** | Yes | External URL Builder, not embedded | **183** | 1,250-2,300 | 600-1,100 | 4/10, 8/10 engine / 4/10 packaging |
| **Apprise API sidecar** | **No** (process during app use) | **Yes, separate web UI** | **183** | 1,600-3,000 | 800-1,500 | 3/10, 6/10 |
| **Novu Providers** | SDK only: yes | No | 40+ transitive packages; many provider types | 1,100-1,900 | 650-1,100 | 4/10, 5/10 |

**Notifly breakdown (indicative 850-1,500 production LOC):** thin dispatch adapter 100-180; secure credential persistence/validation 160-300; event-to-destination preferences + bounded outcomes 190-320; schema-driven settings UI 260-420; IPC/HTTP composition & localization wiring 140-280. Existing notification event types and Radix settings controls are reused; do not add own Telegram/Slack/Discord sender implementations.

**Why published provider counts don't settle the choice:** Apprise includes obscure services; Thinwrap mixes email/SMS/push/chat; Notifly covers most requested household integrations. Mature catalog breadth vs UX code footprint are separate axes.

### 11.5 Concrete in-app configuration UX (no local website needed)

Suggested in `Settings → Notifications → Delivery channels`:

```text
Desktop [On, existing]     Telegram [Connect]      Discord [Connect]
Slack [Connect]            ntfy [Connect]          Webhook [Advanced]
[Add destination] -> search services (library searchServices)
   -> dynamic Radix form from schema (label, sensitive, helpText)
   -> for Discord/Slack "Paste webhook URL" via smartParse
   -> Telegram: bot token, chat ID; explain BotFather & start conversation
   -> Save masked credentials to trusted application port; show a named destination
   -> [Send test] [Disable] [Edit] [Remove]
Routing:
  Agent sends message directly to you     Desktop [x]  Telegram [ ]
  Task needs your clarification          Desktop [x]  Telegram [ ]
  Tool approval (future separate bridge) Desktop [x]  Telegram [ ]
```

Do **not** open an external public web page with secrets in query params or embed a remote page in Electron. For a remote builder, show an explicit **"Open help/URL builder"** link only; secrets typed there are outside our trust boundary. Creating a bare localhost settings server is unnecessary if the library already supplies UI schemas for the existing React settings page.

**Source of truth:** existing NotificationManager for committed event identity; one small external-destinations settings model + encrypted secret store; existing desktop toasts unchanged. No new generic notification database or message bus. Destination provider never sees app filesystem paths, full prompts or internal logs. User can opt into sanitized preview (default off). Encrypted secrets remain main-owned; dynamic fields in renderer are ephemeral entry values.

### 11.6 Short risk-first spike to authorize a provider

Gate `N0` (~100-220 **spike code lines**, discard after review): install exact pinned Notifly release in disposable branch/sandbox, inspect NPM tarball versus GitHub source and TypeScript 7 compatibility. Verify `getServiceSchemas` / `buildUrl` / `smartParse` and `notify`. Simulate Telegram, Discord, ntfy and webhook with injected/mock fetch. **No real token/test message without explicit opt-in**.

Gate `N1` security (~150-300 test lines): prove no secret in error string/logger/config, invalid token is masked, URL parser rejects malformed targets, malicious redirects/private-IP-DNS do not escape HTTP policy (or keep **every** configurable-host adapter disabled in v1, including custom webhook, ntfy and Gotify). Test Android/mobile push is **provider service behavior**, not an app feature; no assurance of background delivery after app exits.

Gate `N2` packaging (~150-250 E2E lines): actual Electron pack/dev renderer and Mac/Windows/Linux artifact smoke for zero extra executable, no dependency on browser DOM, private route auth and no config leak through HTTP. Perform same scripted send contract against Shoutrrr on failure to qualify Notifly (including binary provenance and secret handling).

**Go/no-go:** Choose Notifly only if source and distribution audit are acceptable; choose Shoutrrr if catalog maturity/coverage is worth packaging; choose Apprise CLI/API only for breadth/ready remote UI. If none qualifies, write down the failed proof and ask owner to select fallback; never quietly rewrite a multi-provider dispatch engine.

### 11.7 Critical-review revisions (additional 4 passes)

1. **Ecosystem review:** original A/B/C/D/E left out native TypeScript OSS packages; added Notifly and Thinwrap, and separated **chat channel count** from all-purpose provider count.
2. **Real-source review:** Notifly ships useful builder metadata and Smart Paste, **but** is under 1.0 with tiny adoption and incomplete SSRF/DNS redirect protection; made selection conditional and generic webhook advanced-only pending security proof.
3. **UX/DRY review:** native settings UI can be generated from library schema; external builder/API server is **not necessary** for desktop onboarding. Reuse the project's Radix controls and existing notification toggles; don't build duplicate service-specific forms.
4. **Packaging/security review:** Shoutrrr needs Go for building but **not** for end user; Apprise CLI needs a bundled Python runtime; local Apprise API must remain running if it sends. Reconfirmed encrypted secret handles and explicit offline limitations.

**Provisional research recommendation (still requires product owner's choice):** favor **Notifly** with a strict security + maintenance spike for a light, native, no-backend first release; keep **Shoutrrr** as a proven functional fallback for broader catalog, subject to its own packaging evidence. Initial rollout only 2 event types: `user_inbox`, `task_clarification`. Do not merge decision into production before approval.


---

## 12. Confirmed functional blocker in Notifly 0.7.2 — Telegram token format

**Evidence (23 Nov 2026):** actual source and tests:
- `src/builder/url-builder.ts` returns `tgram://${fields['bot_token']}/${fields['chat_id']}` without encoding.
- `src/url-parser.ts` passes this string to standard `new URL(urlString)`.
- `src/services/telegram.ts` reads `url.hostname` as `botToken`.
- `src/builder/url-builder.test.ts` expects `tgram://bot123:ABC/-1001234` but **does not parse it**.
- `src/services/telegram.test.ts` / `src/url-parser.test.ts` only parse stand-in tokens **without a colon**; they call `send` separately with injected plain config.

A real Telegram Bot API token conventionally looks like `123456789:AA...` (colon in token). Node's URL parser rejects the exact URL that the library's builder emits:

```js
new URL('tgram://123456789:AAexample/987654321');
// TypeError: Invalid URL
```

This was directly reproduced with the built-in Node WHATWG URL parser (without network or a real credential). Therefore the library's documented **Telegram build → parse → notify path cannot be counted as working for normal bot tokens in v0.7.2**. Encoding the colon as `%3A` changes `url.hostname` to contain encoded text and is **not** evidence of a successful end-to-end Telegram API call.

**Revised status:** `@ambersecurityinc/notifly@0.7.2` is a **promising UI-builder concept but NOT an acceptable default notification engine for this requested Telegram MVP** until an upstream version fixes the issue and proves a real-format token round-trip with a mocked `fetch` and packaged E2E. Do **not** privately fork or patch the library in our app without separately approved, tiny, well-tested scope. Its SSRF/redirect and low-maintenance issues remain additional blockers.

### Decision update after failure of N0 reasoning check

- **Recommendation #1 for ready many channels with no hosted backend:** pinned **nicholas-fedor/Shoutrrr** CLI after packaged binary/secret-handling spike. It has built-in CLI URL generation/verification, including Telegram-specific interactive setup; a native Radix settings screen need only offer a few preset fields plus a secure Advanced URL entry, not recreate provider protocols.
- **Recommendation #2 for an all-TypeScript release without binaries:** `@thinwrap/notifications`, especially if 9 chat plus email/SMS API integrations are enough. Requires our own small setup schema for the first 3-4 services, but sends via a ready OSS facade.
- **Recommendation #3 conditional:** Notifly **only after an upstream fix and independent security review**, because its headless builder could reduce future UI work.
- **Maximum catalog alternative:** Apprise CLI/API if user deliberately accepts Python packaging or a local server.

**No implementation decision made here:** the owner still chooses, now with a verified reason Notifly should not be the default **today**. The reported `11.4` LOC estimate for Notifly is valid only after the blocking upstream version exists; it does not include fixing third-party code. Updated recommendation overrides the provisional text at the end of `11.7`.


## 13. Implementation decision and first vertical slice (2026-11-23)

Owner authorized implementation rather than another decision round. Thinwrap is pinned to `@thinwrap/notifications@1.2.0` (no extra native binary) and constrained to its built-in **Telegram, Discord, Slack, Teams and Google Chat** senders. The app owns one narrow input form per credential kind; it does not reimplement those vendor protocols.

- Source events: committed `NotificationManager` events; only explicit allowlisted, unread team event types are eligible. No historical replay, raw agent text, usernames, team names or filesystem paths are sent.
- Security: existing encrypted `ApiKeyService`; 0600 metadata file contains only credential references. Incoming HTTP mutations require same-origin, loopback Host and loopback peer IP. Every outbound request must remain on the exact vendor HTTPS host and webhook path, with redirects disabled and a 10-second timeout.
- UI and portability: existing React/Radix settings page via shared cross-process contracts; Electron IPC and local-only Fastify HTTP adapters use the same application service. Native desktop notifications remain unchanged; external channels start disabled.
- **Not supported in v1:** raw arbitrary webhook URLs, ntfy, Gotify, local LAN targets, remote multi-user settings, guaranteed delivery while the app is closed, native push SDKs, or retries after uncertain provider outcomes. The HTTP safety gate applies to **all configurable-host adapters**, not just custom webhook. Add new hosts only after DNS/redirect/IP policy proof.
- Verification: focused application, domain, HTTP and provider-adapter tests are included. Genuine external sending requires user-supplied credentials and explicit Test; no test should send to a real third party without the user's click. Full packaged multi-OS E2E remains a release gate, not a claim made by the research doc.


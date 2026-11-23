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

Then confirm **(i)** external notifications outbound-only for the MVP, **(ii)** whether native presets or link to a URL Builder is acceptable, and **(iii)** whether additional binaries may ship in the desktop app. Do not implement or merge provider choice before these answers.

Suggested narrow follow-up after choice: one implementation PR, small domain route policy, one selected engine adapter, initial 2 priority events, guided UI, tests, packaged E2E. Keep the User Attention Inbox PR independent.

# Notification delivery routing UX — implementation plan

Date: 2026-11-24
Base: main @ `8264896286000f49d3ccb25cc62a90c015785f1f`
Scope: UI/notification routing follow-up to merged #1280; no production credentials, no external live sends.

## Goal

Settings → Notifications: manage named providers in one block. Next to the existing type-specific notification switches, choose **one or more** destinations (Desktop by default; named Telegram, Discord, Slack, Teams or Google Chat channels when configured). Event-on/off remains distinct from destination selection. Avoid introducing a second provider configuration or queue.

## Architecture

- Preserve the encrypted isolated credentials vault, v1 metadata format and existing `channel.events` as the **single external routing source of truth**. A channel's provider/credential is edited only in the channel block. Reverse the routing UI: each supported event row toggles membership in saved channels; each mutation uses the current `notificationChannels.save` API and preserves secret references.
- Add `notifications.desktopDisabledEvents: TeamEventType[]` as a bounded, validated optional preference normalized to [] for existing configs. This controls **native toasts only** in `NotificationManager.addTeamNotification`; it never disables event production or external delivery. Legacy global enabled/snooze/trigger switches retain their semantics.
- Distinguish intentionally source-suppressed/hidden events from a disabled native toast. Never send previously read, duplicate or hidden notifications externally. Where budget alerts intentionally suppress only native toasts, allow external delivery only for explicitly configured/active channels and still honor global pause.
- Keep `NOTIFICATION_DELIVERY_EVENTS` and safe fixed labels in sync with supported team event types, without sending raw agent messages/task titles/user data. Provider request allowlist and no-retry behavior remain unchanged.
- Inline selector uses existing Radix Popover + Checkbox and keyboard accessibility; show current destinations, disabled/unavailable channels, explicit empty warning, no unexpected auto-enabling. Existing desktop defaults remain unchanged after upgrade.
- For a setting without a supported outbound team-event producer (e.g. generic errors or tool approval), display Desktop-only instead of a nonworking provider selector. Present additional independently emitted eligible events (e.g. runtime recovery, scheduled failure) in one compact subsection.

## Acceptance / tests

1. Fresh and migrated config show Desktop delivery by default; enabling an external destination does not alter Desktop. Mutating `desktopDisabledEvents` is strictly validated through config IPC; persisted preference survives restart.
2. User can route an enabled type Desktop + multiple providers or exclusively to a provider; native toast is suppressed only for the latter, while outgoing sanitized notifications are still delivered. Global enabled/snooze and source-suppressed events inhibit outbound.
3. Secrets never reach list/routing UIs, remain encrypted, and are preserved when editing route membership. Disabled or missing-credential provider is not represented as working. Deletion cannot retain an orphaned route.
4. Every interactive selector updates through the real renderer API (Electron IPC; local same-origin standalone HTTP) and shows persistence/error feedback; inaccessible remote-browser origins cannot edit credentials.
5. Unit tests for event mapping, config validation, migration, cross-route dispatch/suppression and failures. Extend `scripts/e2e/notification-channels-desktop.mjs`: real CDP click of event destination popover, verify persisted channel events + desktop exclusion and delivery/no-toast behavior, screenshot before/after. Standalone HTTP test continues unchanged except new route metadata checks. Run TS7 typecheck, lint, Vitest, real Electron + standalone E2E and packaged OS smoke as applicable.
6. Independent review (Codex/CodeRabbit/ReviewRouter when available), address actionable issues, only merge after verified tests/required CI and mergeability; check post-merge main.

## Review 1 — correctness

**Issue:** Treating the existing notification toggle as Desktop-only would unintentionally start sending notifications even if a user turned the event off. **Decision:** Keep the existing event gate, store native destination separately. Selectors are disabled when event gate is off; route settings persist without modifying the gate.

## Review 2 — scope/security

**Issue:** The former channel-centric editor and a new event-centric editor could diverge, and some local notification types have no external delivery producer. **Decision:** Only one `channel.events` field; remove per-channel event picker, show unsupported events as Desktop-only and cover the actual producer mapping in tests. Do not auto-enable a newly created external endpoint. Reuse existing persistence, IPC, CSS and feature boundaries.

## Estimate

~700–1100 LOC changed, ~12–17 files. Complexity 7/10, target reliability 8/10, confidence 8/10 pending real E2E. No new packages, no background service, no arbitrary webhooks or provider-specific redesign.

## Review 3 — concurrency and partial selection (2026-11-24)

- **Risk:** Two rapid edits or concurrent windows can replace the same `channel.events` membership with stale data. **Decision:** Serialize route edits within the renderer and add optional `expectedEvents` compare-and-swap validation inside the existing service mutation lock. A stale request fails safely instead of silently losing another subscription; full-form saves retain their established replacement semantics. No new endpoint or package.
- **Risk:** An indeterminate Desktop checkbox becomes impossible to restore if only one of several events has an external destination. **Decision:** Require complete external coverage only when disabling a fully enabled Desktop route.
- **Onboarding:** Localize provider-specific instructions and links through settings catalogs, guide Microsoft Teams Workflows users to its **Anyone** mode for unauthenticated external posts, and remove directional guidance that points to the wrong switch.
- **Acceptance additions:** concurrent route-save regression, invalid guard validation, partial Desktop restore, EN/RU documentation, and localized catalog parity for all 30 supported locales. Existing real Electron E2E remains required, along with actual workflow PASS and independent review. Do not count queued, cancelled or skipped as PASS.

Actual scope is broader than the initial estimate because of localization catalogs and generated typing; keep provider transports and credential security logic unchanged. No arbitrary webhook until a separately reviewed SSRF/DNS-rebinding design is approved.

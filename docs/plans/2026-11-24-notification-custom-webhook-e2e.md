# One PR: custom outbound webhook + Telegram onboarding + delivery status (2026-11-24)

Scope: reuse existing notification channel metadata, encrypted vault, per-event routes, existing IPC/HTTP endpoints, Thinwrap adapters for five vendor destinations, existing real Electron/standalone CI workflow. No persistent worker, inbound bot, schema migration, arbitrary headers or retries.

## Design / critique

1. **Avoid duplicate infrastructure.** Do not add a backend or reimplement Telegram. Thinwrap supports send-only; Telegram private chat IDs remain manual, public channels use @username. Explain BotFather, chat start, group/channel prerequisites with official links.
2. **Generic webhooks need more than URL validation.** A DNS-only preflight can rebind before connect. Validate URL + all resolved addresses, pin the verified A/AAAA records using Node HTTPS lookup, enforce standard HTTPS port & certificate, refuse redirects and private/reserved IPv4/IPv6. No transport dependency, proxy inheritance or arbitrary payload.
3. **Failures need low-cost visibility.** Expose latest automatic result in-memory for active app session, persist existing manual Test status unchanged, no filesystem write per event and no raw vendor exception/URL, show Refresh and specific actionable UI hints.
4. **One repository PR.** Focused domain, transport, service and UI regression tests. Existing workflow must exercise real Electron renderer→IPC→vault, and standalone HTTP; extend with custom webhook mock and rejected DNS/redirect scenarios. Treat queued/skipped as NOT PASS.

Estimated: ~350–550 production LOC, ~250–450 test/E2E, 6/10 complexity, 8/10 reliability when qualification passes, 7/10 confidence. No changes to other modules or delivery policy.

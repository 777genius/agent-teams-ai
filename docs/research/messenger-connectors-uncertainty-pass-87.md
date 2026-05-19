# Messenger Connectors Uncertainty Pass 87

Date: 2026-05-01
Focus: policy coherence for reply projection, fallback route containers and official relay transport

## Question

Do the current docs still read as one product and implementation strategy after many passes, or are there policy-level contradictions hidden in older implementation snippets?

## Findings

The core architecture is coherent, but three wording seams could mislead implementation:

1. Fallback route container wording sometimes made advanced forum supergroup sound like an MVP fallback.
2. Older capture snippets could be read as "visible assistant text can become a Telegram reply" even though the current decision is exact-proof auto-send only.
3. Relay wording mixed "SSE" with "EventSource" risk. The current decision is main-process HTTP streaming with an SSE wire format, not renderer `EventSource`.

## Current Policy

```text
Route containers:
  preferred: private-chat topic after capability + activation + client compatibility proof
  MVP fallback: private DM with /teams selector
  later advanced option: forum supergroup with explicit user setup

Provider auto-send:
  allowed only from ExternalReplyProjectionIntent
  requires exact relayOfMessageId, explicit provider link, or exact sidecar proof
  plain assistant text is local history or manual-review candidate only

Official relay transport:
  desktop opens main-process HTTP streaming/SSE-wire downlink
  desktop uses HTTPS/POST ACK and control uplink
  renderer EventSource is not the official relay transport
  WSS remains a later fallback if deployment/proxy behavior requires it
```

## Why This Matters

The dangerous bug is not "wrong wording". The dangerous bug is a future implementation path like:

```text
lead plain assistant text
  -> file watcher sees user-visible text
  -> provider outbox enqueues Telegram send
  -> internal narration leaks to Telegram
```

That violates the current trust boundary. Local capture and provider projection must remain separate responsibilities.

## Applied Cleanup

- Reworded default fallback so forum supergroup is clearly not the MVP fallback.
- Reworded single-message lead capture so visible assistant text without proof is local/manual-review only.
- Reworded valid provider auto-send sources around exact `relayOfMessageId`, explicit provider link and sidecar proof.
- Reworded relay transport as main-process HTTP streaming/SSE-wire plus HTTPS/POST ACK.

## Top 3 Options

1. Tighten current policy wording while preserving historical passes - 🎯 10   🛡️ 9   🧠 3, about `40-110` changed lines.
   - Best fit because the current architecture is right and only needed sharper boundaries.

2. Remove all old sections that mention weaker visible-text capture or WebSocket-first relay - 🎯 7   🛡️ 7   🧠 7, about `800-1800` changed lines.
   - Cleaner search results, but loses reasoning history and creates churn.

3. Leave policy conflicts to the summary only - 🎯 6   🛡️ 6   🧠 2, about `10-30` changed lines.
   - Fast, but implementation readers can still copy old snippets.

## Decision

Use option 1.

Current docs now read as one implementation story: exact-proof provider projection, no plain-text assistant auto-send, DM selector as MVP fallback, and main-process HTTP streaming relay.

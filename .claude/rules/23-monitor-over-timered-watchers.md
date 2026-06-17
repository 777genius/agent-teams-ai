# Monitor Over Timered Watchers

When output from an external process is expected to arrive multiple times over a session (PR review verdicts firing as pushes land, CI pipelines step by step, watchdog logs, etc.), use the **Monitor tool** (persistent background process with stdout-line-per-event semantics) — NOT repeated `Bash + sleep` polls or short-interval `ScheduleWakeup` calls.

## Why

- **One process, many events** — the Monitor translates a long-running shell loop's stdout lines into notifications. Each line becomes a chat event you receive automatically; you keep working without polling.
- **Timered watchers waste cycles** — `Bash + sleep 30 + grep` re-runs the entire setup every poll, doesn't aggregate state across polls, and is brittle when polling intervals overlap with notification windows.
- **`ScheduleWakeup` is for self-pacing `/loop`** — not for multi-event observation. Mis-using it for "tell me when X happens" produces stale wake-ups and wasted context.

## When the rule binds

- More than 1 expected event from the same source.
- Watching state-deltas (queue depth changing, `/health` field flipping, new PR comments).
- Tailing logs for repeating signatures.
- Any "tell me on every state change" semantic.

## Prefer curated stream endpoints over raw event sources

When the system you're monitoring exposes BOTH a raw event source (a queue, a log file, a database table) AND a curated stream endpoint (e.g. an SSE/WebSocket feed that is pre-filtered server-side, carries verdict/state-deltas in the event itself, and supports a query parameter to scope the feed to repos / projects / users you care about) — **prefer the curated endpoint**.

Why:
- The curated endpoint already does the filtering you'd otherwise replicate client-side (and probably get wrong).
- Events arrive with the payload already shaped (verdict, status, IDs, URL) — no follow-up reads to enrich them.
- Reconnect + reconcile is a documented protocol (typically a `/list` companion for backfill), not a bespoke client-side state machine.

Pattern: arm a Monitor that tails the SSE/WebSocket; on each event, emit one digestible line; on reconnect, call the snapshot/`/list` companion to fill any gap before acting on "no activity since last event."

When the curated endpoint is unavailable (token unset, deployment doesn't have it), fall back to the raw source with explicit acknowledgement that you're in degraded mode. Use the raw source ALSO for purposes the curated endpoint doesn't serve (e.g. pre-flight duplicate-detection checks vs. verdict-tracking).

## When NOT to use Monitor

- Single-shot wait ("tell me when the build finishes" → use `Bash run_in_background` with an `until <condition>` loop; one notification, ends in seconds).
- Strictly periodic poll where you genuinely don't care about state-deltas, just a snapshot at a fixed cadence (rare).

## Pattern

```bash
# Inside the Monitor command:
prev=""
while true; do
  cur=$(snapshot_state)
  if [ "$cur" != "$prev" ]; then
    echo "[$(date +%H:%M:%S)] state: $prev -> $cur"
    prev="$cur"
  fi
  sleep 30
done
```

Each delta-detected line becomes a separate notification. The session-length watch survives until `TaskStop` or session end.

## Cost discipline

Each notification consumes a chat-event context slot. Apply smoothing filters in the monitor script itself for cosmetic-only transitions (e.g., 2-tick smoothing on a noisy queue counter). The monitor should emit signals worth acting on, not raw state.

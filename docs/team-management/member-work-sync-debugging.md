# Member Work Sync Debugging

`member-work-sync` stores member-scoped control-plane state under each team member:

```text
~/.claude/teams/<team>/members/<member-key>/.member-work-sync/
  status.json
  reports.json
  outbox.json
  journal.jsonl
```

`member-key` is the normalized, percent-encoded member name. The canonical name is stored in:

```text
~/.claude/teams/<team>/members/<member-key>/member.meta.json
```

Use the journal for local debugging:

```bash
tail -f ~/.claude/teams/<team>/members/<member-key>/.member-work-sync/journal.jsonl
```

The journal is append-only JSONL and records sync decisions, not raw agent transcripts. Useful events:

- `reconcile_started`, `agenda_loaded`, `decision_made`, `status_written`
- `report_received`, `report_accepted`, `report_rejected`
- `nudge_planned`, `nudge_delivered`, `nudge_skipped`, `nudge_retryable`, `nudge_superseded`
- `member_busy`, `watchdog_cooldown_active`, `team_inactive`, `legacy_fallback_used`

When planning is skipped by `blocking_metrics` or `phase2_not_ready`, the event includes
`phase2_readiness:*` diagnostics plus observed rates and matching thresholds in `metadata`.
The same fields are recorded if dispatcher revalidation blocks a queued nudge.
For the Phase-2-gated targeted path, `would_nudge_rate_high` and
`fingerprint_churn_high` are diagnostic-only, while `report_rejection_rate_high` remains
delivery-blocking. Existing explicit review, task-protocol, and native-stale recovery paths
retain their own eligibility rules.

Team-level shared/index state remains under:

```text
~/.claude/teams/<team>/.member-work-sync/
  indexes/
  report-token-secret.json
```

The indexes are implementation details used to avoid scanning every member directory on the hot path.

A scheduled dispatch timeout aborts that dispatch pass so a late readiness or revalidation result
cannot write a new inbox nudge after shutdown. If the pass already acquired an outbox claim, the
item remains fenced and can be reclaimed after the five-minute claim lease expires.

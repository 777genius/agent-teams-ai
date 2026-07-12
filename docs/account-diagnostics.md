# Account Diagnostics

Account diagnostics answers operational questions without binding the host app to
Codex, Claude or a specific worker implementation:

- which account slots are configured;
- which slots are scheduler-eligible now;
- which slots are blocked by usage limits;
- when a known limit should reset;
- which slots need relogin;
- which slots share the same stable provider account.

The default diagnostic path is non-invasive. It reads configured inventory,
safe identity metadata and cached `WorkerAccountCapacityStore` signals. It does
not run provider commands unless `--probe` or `--health` is explicitly passed.

## CLI

```bash
subscription-runtime-account-status --provider codex
subscription-runtime-account-status --provider codex --probe
subscription-runtime-account-status --provider all --json
subscription-runtime-account-status --only reconnect_required
```

Useful account sources:

```bash
subscription-runtime-account-status \
  --provider codex \
  --codex-home-root ./codex-accounts \
  --account-capacity-root ./runtime-state

subscription-runtime-account-status \
  --provider claude \
  --claude-config-root ./claude-accounts \
  --capacity-account account-a=claude-oauth:account-a
```

Environment fallbacks:

- `SUBSCRIPTION_RUNTIME_CODEX_ACCOUNTS_ROOT`
- `SUBSCRIPTION_RUNTIME_CLAUDE_ACCOUNTS_ROOT`
- `SUBSCRIPTION_RUNTIME_ACCOUNT_CAPACITY_ROOT`
- `SUBSCRIPTION_RUNTIME_STATE_ROOT`
- `CODEX_AUTH_JSON_PATH`
- `CLAUDE_CONFIG_DIR`

## Status Model

Each account returns a `ProviderAccountDiagnostic`:

```ts
type ProviderAccountAvailability =
  | "available"
  | "limited"
  | "reconnect_required"
  | "auth_unknown"
  | "unhealthy"
  | "unknown";
```

Recommended actions:

- `none` - scheduler can use the slot.
- `wait` - usage or quota limit is active.
- `relogin` - auth has been revoked or invalidated.
- `inspect` - the runtime cannot prove the account is usable.

The list use-case also returns a provider-neutral pool summary:

- `safeToSchedule` - at least one returned slot is scheduler-eligible now.
- `schedulerEligibleSlotIds` - slots a scheduler may use immediately.
- `limitedSlotIds` - slots blocked by usage or quota limits.
- `reconnectRequiredSlotIds` - slots that need human relogin.
- `nextAvailableAt` and `nextAvailableSlotIds` - earliest known limit reset.
- `decision` - `schedule`, `wait`, `relogin` or `inspect`.

`accountKeyHash` is a provider-scoped SHA-256 hash of a stable provider account
id. Raw tokens and raw OAuth material are never returned. If the provider does
not expose a stable non-secret account id, duplicate detection is skipped for
that slot.

Operator-facing displays may include optional `displayName`, `email`,
`shortName` and `operatorLabel` fields. These are labels only. The stable slot
id, such as `account-a`, remains the scheduler key, auth directory name and
capacity key.

For Codex pools, labels can be stored next to the auth slots:

```json
{
  "account-a": { "email": "operator@example.com" },
  "account-g": { "displayName": "usa18303530342" }
}
```

Supported file names are `account-labels.json`, `account-metadata.json` and
`accounts.metadata.json` under the Codex auth root.

## Architecture

The implementation is split by Clean Architecture boundaries:

- `src/account-diagnostics` owns provider-neutral domain types, merge policy,
  reset parsing, the list use-case and the `WorkerAccountCapacityStore` bridge.
- `src/worker-codex/account-diagnostics-adapter.ts` maps Codex auth and probe
  output into provider-neutral signals.
- `src/worker-claude/account-diagnostics-adapter.ts` maps Claude config,
  capacity account ids and probe output into provider-neutral signals.
- `src/worker-local/account-diagnostics-cli.ts` is the CLI composition root.

The use-case depends on ports:

- `ProviderAccountRegistryPort`
- `ProviderAccountIdentityReaderPort`
- `ProviderAccountCapacityReaderPort`
- `ProviderAccountHealthProbePort`
- `AccountDiagnosticClock`

Provider adapters depend inward on those ports. The neutral module must not
import `provider-*`, concrete workers, queues, stores or runners.

Detailed provider quota observation lives in
`packages/agent-account-observability`. Use that package for Codex app-server
rate limit buckets and future Claude Code statusline quota adapters, then map
the normalized facts back into this diagnostics read model.
The Codex goal account status live-check path already uses it for app-server
quota buckets with controlled exec fallback.

## Edge Cases

- `codex login status` can report a session as logged in while a real refresh
  token is already revoked. `--probe` is the stronger signal and overrides old
  cached capacity.
- Usage limits and revoked tokens both block scheduling, but actions differ:
  `limited` maps to `wait`, while `reconnect_required` maps to `relogin`.
- Reset text may be local clock text such as `2:43 AM`. Diagnostics preserve
  `rawResetText` and normalize `limitResetAt` when possible.
- Slot names are not stable account identities. Duplicate detection uses the
  stable provider account key hash, not the slot id.
- Claude may not expose email or provider account id. In that case the adapter
  can use `capacityAccountId`; otherwise it reports a safe slot fallback.
- Limits can be model-specific. Adapters should attach `model` to inventory
  when the account slot is bound to a model.
- CI must not attempt relogin interactively. It should consume
  `recommendedAction` and fail or notify.

## Authoring A Provider Adapter

New providers should implement the four ports and return only safe metadata.
The adapter should classify at least:

- usable account;
- quota or usage limit, preferably with reset time;
- revoked or invalid auth;
- permission/setup failures;
- unknown runtime failures.

If the provider exposes a stable non-secret account id, hash it with
`hashProviderAccountKey`. Never hash or return refresh tokens, access tokens,
id tokens, OAuth secrets or raw auth files.

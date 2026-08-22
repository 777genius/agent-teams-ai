# Hosted OpenCode downstream policy

- Decision date: 2026-08-22
- Status: temporary Core v1 compatibility policy
- Upstream: `anomalyco/opencode`
- Downstream: `777genius/opencode-anomaly`
- Functional patch: downstream PR #1
- Reproducible artifact pipeline: downstream PR #2

## Decision

Agent Teams does not maintain an independently evolving OpenCode distribution. The downstream is a
small, reviewable patch queue over a named upstream release. Upstream remains the source of product
features, fixes, and security updates. The downstream exists only for the hosted approval contract
that upstream OpenCode does not currently expose atomically and for the build evidence needed to pin
that contract to exact executable bytes.

The current Core v1 candidate uses upstream `v1.18.4` at
`49c69c5ed3ccf706b61b3febb43c8aaff7f8325e`, functional source
`476b667c385210b19fbd15bcb57456cacb0ae9e7`, and reviewed patch SHA-256
`dbd8b2c1eda38043e3bfc9e2b809f4ef393fa075349ed219109a7deaca0c590e`. The patch changes 17
files. This pin is an acceptance baseline, not permission to stay on OpenCode `v1.18.4` indefinitely.

## Why stock OpenCode is insufficient for this flow

Stock OpenCode can list pending permission requests and reply to a request by ID. That is adequate
for a single trusted in-process operator, but not for the Agent Teams hosted flow where observation,
browser authorization, owner delivery, process replacement, and recovery are separate steps.

The hosted owner must reject a decision when any observed authority changed between read and write:

- runtime instance;
- config generation;
- session incarnation;
- request incarnation; or
- permission digest.

An external `list -> reply(requestId)` sequence cannot make those checks and the mutation atomic.
The request can be cancelled, replaced, or recreated with the same visible ID after the list. A
blind retry after a transport failure can also duplicate or misattribute an effect. Downstream PR #1
adds the conditional approval v2 endpoints and exact schema/fencing needed to fail closed in those
cases.

If upstream adds an equivalent atomic conditional-reply contract, or exposes a supported plugin
boundary that can implement it with the same authority guarantees, the functional patch must be
removed and Agent Teams must return to stock OpenCode artifacts.

## Why the artifact pipeline is separate

Downstream PR #2 does not add runtime behavior. It proves that the reviewed source produces the
bytes installed by Agent Teams:

- exact base, source tree, and regenerated patch identity;
- two independent builds with a reproducibility comparison;
- native verification on Linux x64/arm64, macOS x64/arm64, and Windows x64;
- a manifest binding every archive and executable SHA-256 to the source; and
- a protected prerelease that remains `productionEligible=false` until no-fake acceptance passes.

This PR can be replaced by another immutable container or release pipeline, but the source-to-binary
binding cannot be removed. A mutable tag, latest download, or unverified locally built binary is not
acceptable for approval delivery.

The current non-production candidate is `v1.18.4-agentteams.1`, produced by hardened workflow run
`32579388230`. Its manifest SHA-256 is
`99c5fa1dbc52ea3512cffa48f10d444c9fb7029171129d176ad4c85fa237b8cb`.

## Upstream update policy

The downstream must continuously follow upstream instead of accumulating an unbounded fork:

1. Track upstream `dev` and stable releases in the fork.
2. After Core v1 no-fake acceptance, immediately port the 17-file patch to the newest supported
   stable OpenCode release before production promotion.
3. For every later stable or security release, run the port and compatibility lane. Security fixes
   take priority over feature work.
4. Regenerate the patch from the new exact base; never merge unrelated fork history into the
   product pin.
5. Re-run focused approval tests, strict parsing tests, two-build reproducibility, all native
   verifiers, artifact installation, and sandbox actual-owner E2E.
6. Update `opencode-hosted-runtime.lock.json` only from the resulting signed-off manifest and commit
   the exact digest change.
7. Keep only the current supported patch line and short-lived migration branches. Do not add general
   OpenCode product customizations to this downstream.

The daily `OpenCode upstream tracker` workflow makes this policy observable. It compares the
immutable downstream base with GitHub's latest non-prerelease upstream release and maintains one
tracking issue while the pin is behind. The issue is a port trigger, not permission to update the
lock from unverified upstream binaries.

Current drift and the next verified port are tracked in
[`agent-teams-ai#471`](https://github.com/777genius/agent-teams-ai/issues/471). This issue must remain
the single operational follow-up instead of relying on memory or turning the downstream into a
permanent fork.

A downstream release is stale and production promotion stays closed when any of these is true:

- a newer upstream security release has not been assessed;
- the patch no longer applies cleanly;
- upstream changed permission/session semantics without a compatibility decision;
- reproducibility or a native verifier fails; or
- the product lock, manifest, executable digest, and owner admission disagree.

## Merge and activation order

1. Review the functional patch in OpenCode PR #1.
2. Build and verify its exact source through PR #2.
3. Pin the produced non-production artifacts in Agent Teams PR #252.
4. Pin the same source and executable digest in orchestrator PR #44.
5. Run one new sandbox-only no-fake flow:
   `request -> durable pending -> authenticated browser decision -> owner delivery -> reconciliation`.
6. Prove restart, stale authority, replacement, ambiguous settlement, cross-team isolation, and
   cleanup cases.
7. Only then change the three product/orchestrator/manifest production capability gates together.

The OpenCode PRs are therefore not independent product features that should merge early. PR #1 is
the required compatibility delta for the current contract. PR #2 is required supply-chain evidence
for the current release method. Both remain replaceable when upstream or the release architecture
provides equivalent guarantees.

## Removal criteria

Delete the downstream dependency when all of the following are true:

- an upstream release provides equivalent atomic observation and conditional reply fences;
- Agent Teams adapters pass the same contract and adversarial tests against stock OpenCode;
- the no-fake sandbox E2E passes with a stock, immutable upstream artifact; and
- product and orchestrator pins are migrated in one coordinated change.

Until then, treat the downstream as a bounded compatibility adapter, not a permanent product fork.

# Phase 03: approval actual-owner closure

- Status: `active / product binding only`
- Packet revision: `phase-03-actual-owner-closure-r2`
- Current node: `P3.A.PRODUCT_BINDING`
- Terminal state: `HOLD`

## Outcome

Close the remaining Hosted Core v1 approval actual-owner boundary with one thin vertical slice. The
product consumes only launcher-signed v4 per-team route authority, the orchestrator starts its actual
control owner before active admission, and one sandbox-only no-fake E2E proves the complete approval
decision path. Production eligibility stays false until all three exact revisions pass together.

## Current scope

Only [P3.A product binding](lanes/p3-a-product-binding.md) is launchable. The independent r1
adjudication proved a concrete missing seam: product has no authenticated activation-v1 producer
between exact owner readiness and final ready. The r2 lane may implement only that vertical slice
inside its declared paths. Product remains the logical signer; orchestrator owns persistence because
the production run-directory mount is read-only to product.

The orchestrator PR #44 review, cross-repository E2E, and coordinated activation are successor nodes.
Their implementation packets are intentionally not materialized before their predecessors are
accepted.

## Non-goals

- no new general lifecycle coordinator or runtime platform;
- no legacy v2/v3 approval route activation;
- no broad Hosted parity, terminal, review, attachments, member recovery, or destructive recovery;
- no OpenCode product customization beyond the bounded atomic approval compatibility patch;
- no real project, real provider agent, shared user state, or production rollout; and
- no production gate or artifact eligibility change in this packet.

See [controller-packet.md](controller-packet.md) for acceptance and
[execution-dag.md](execution-dag.md) for the only legal ordering.

# Hosted Web Phase 1

Current authority is `phase-01-p1-i-format-remediation-router-r1`; terminal state is `HOLD`.

## Accepted predecessors and current blocker

Formal P1.R2 evidence remains integrated and frozen with `ACCEPT` and P0/P1/P2 `0/0/0`. The accepted
P1.I lint remediation is integrated and its handoff is the 69th canonical P1.I input. The current
clean remote-equal authority is `b482e816a90e9bb988a0797565241bae4d60b690`.

Terminal job `agent-teams-hosted-web-refactor-p1-i-integration-v17-r1` returned `BLOCKED`/`HOLD` with
immutable patch SHA-256 `d94f8dfa6548427e007402e8771c469c8e661cd64de3a8728dec042a509aebbe`
and manifest SHA-256 `1b88a6e8e53199f0b1905d4f4c194525bcb86db185f0e4748acf60f69bb78f94`.
Its audited rejection ledger is retained. All gates passed except exact 74-path Prettier, which found
only `docs/research/hosted-web/phase-1/reviews/routes-ratchets.md` unformatted. The patch is provenance
only and must not be materialized or applied; its five outputs must never be integrated.

## P1.I.FORMAT.REMEDIATION

The current packet is [`p1-i-integration.md`](lanes/p1-i-integration.md). It first authorizes one
serial producer over exactly the P1.R1 Markdown and
`.codex-handoff/phase-01-p1-i-format-remediation.json`. The worker applies repository-pinned Prettier
only to the Markdown, proves exact formatter derivation and semantic-token preservation, records
hashes, runs every declared format/diff/scope/scan check, self-reviews, emits its strict result, and
ends `HOLD`.

The required profile is model `gpt-5.6-sol`, reasoning effort `xhigh`,
`serviceTier: "default"`, with Fast prohibited. Root is the sole orchestrator and `controller-v17`
remains `HOLD` and observation-only.

After producer termination and immutable two-path output capture, root may admit exactly one fresh
independent reviewer under the same profile. `ACCEPT` allows root `mark_reviewed` and exact two-path
broker integration and push. `REJECT` allows no integration or successor launch and only separately
admitted remediation bounded to the same paths and findings.

## P1.I.INTEGRATION

After accepted format-remediation integration, exact pushed-authority attestation, clean remote
equality, and a successful pinned-Prettier check over the exact 69 canonical inputs, root may launch
one fresh P1.I five-output producer directly without another router. Its input set remains the
existing 69 paths: the frozen 68-path manifest evaluated at the accepted Markdown bytes plus
`.codex-handoff/phase-01-p1-i-lint-remediation.json`. The format-remediation handoff is not a 70th
input. All 14 gates and exact counts remain mandatory; P1.I output ownership remains unchanged at five
JSON paths. After creating them, the producer runs exact 74-path Prettier over the 69 inputs plus five
outputs.

The fresh producer must derive new outputs from canonical authority. The blocked patch and blocked
five-output bytes are never producer inputs and may not be materialized, applied, copied, or
integrated.

P1.F, Phase 2+, unrelated product workers, controller replacement, and successor controllers remain
blocked. See [`execution-dag.md`](execution-dag.md).

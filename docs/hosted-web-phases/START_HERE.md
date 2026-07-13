# Hosted-web execution: start here

This is the canonical entrypoint for every hosted-web controller and worker. Phase 0 is accepted and
frozen at `f4fa24aac9615a4ce10632965a2244a2e11a273e`. Phase 1 serial bootstrap, foundations,
routes, conformance, and formal P1.R1 are accepted. The P1.1D additive-response remediation product
candidate now exists and is immutable. Product work is complete for this review cycle; the only
current authority is one fresh independent review with corrected input provenance.

## Deterministic reading order

Read only this bounded sequence before working:

1. `AGENTS.md`.
2. This file.
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`.
4. `docs/hosted-web-phases/README.md`, then `docs/hosted-web-phases/EXECUTION_INDEX.json`.
5. The current `docs/hosted-web-phases/phase-01/controller-packet.md` named by the
   ProjectScopedControl `codex_goal_project_refill_worker` reviewer admission.
6. The single assigned review-only packet:
   `docs/hosted-web-phases/phase-01/lanes/p1-1d-additive-response-remediation.md`.
7. Only the exact files and headings in that packet's mandatory-read list.

Do not recursively explore documentation or evidence directories. Accepted inputs, rejected records,
the immutable candidate, and both integration-ledger records are read-only.

## Current route and corrected review input

`P1.1D-additive-response-remediation` remains the sole current node, now in review-only mode under
packet revision `phase-01-p1-1d-additive-response-review-r2`. Capacity is zero until this exact
seven-path docs-only correction router is policy-integrated and the same durable controller has
atomically bound the review-only scope while remaining `live=true`. After both gates, capacity is
exactly one fresh independent reviewer using reasoning effort `xhigh` and service tier `default`.
This docs job does not launch that reviewer.

The immutable product candidate has `baseSha`
`1b37afb02bec25a1f08432d733595b553101ecab`. The reviewer has `canonicalSha`, `phaseStartSha`,
`planBundleCommit`, and worktree `HEAD`
`bbfd2551baaa904061e705511f07716e0f6db17d`. These product and reviewer roles must not be
collapsed. The candidate's legitimate hashes likewise have distinct roles:

- runtime nine-path handoff carrier SHA-256:
  `1f9c6a2a28e5540c61d1395bc51a34a7c0db31855bae575abc9582f839118b49`;
- final eight-path semantic reconstruction SHA-256:
  `fa46617652b072e887563f5a751f7bd0260e0e1d4fb96b628badea91ea7ae9d6`; and
- reviewed-workspace snapshot SHA-256
  `521d8bab2ed7bc4334b38a5786dd5685f5e4f033c3962cab566f9ab3b60d0000`, which is consumed only to
  locate and verify the prior rejection-ledger record. It is not a candidate handoff or semantic hash.

The prior independent reviewer returned binding `REJECT` P1. Its strict result SHA-256 is
`29ad2243be1a1e0c7aa95cb1a32ae32b8f15db8ebe1a260cd41dd85d2c079934`. The sole reason was a stale
external review instruction that mislabeled transient interim hash `7672e922` as the final handoff
hash. That assertion existed only outside the candidate. The final candidate neither contains nor
claims `7672e922`. The rejection remains `REJECT`; this correction does not reinterpret it as
`ACCEPT`.

The rejected predecessor docs router is separately preserved as immutable reviewed output
`1ad2849056be658ab629b9810914ace7eab3287745ecb39c1d76ac1c124d0eb7`, patch SHA-256
`657c1c5ff6421f6b206ef14509586d09fad72e8c511efe1a6f9bf6b8dce5f577`. Its review-only transition
is reproduced here with corrected base provenance and the existing ProjectScopedControl admission
shape; the rejected output itself is not modified or integrated.

## Authority and HOLD

The producer and prior reviewer outputs have formal rejected integration-ledger records, and runtime
admission reports no blocking output debt. Those facts permit only a fresh review; they do not admit
product work or integration. The same durable controller remains responsible. The producer-to-review
authority transition requires a structured scope update, not controller replacement or a new
controller launch. Reviewer admission uses `codex_goal_project_refill_worker` with outer
`workerRole: reviewer`, reasoning effort `xhigh`, service tier `default`, and `serial-builtin`
`preStartAdmission`. Its internal contract remains `kind: worker-launch`, `format: 1`,
`reviewKind: review`, with `inputPatchHash` equal to the runtime nine-path carrier above. No
separate reviewer-launch tool or public contract exists.

No product change, producer retry/refill, product integration, commit, push, P1.R2, P1.I, P1.F,
Phase 2+, or any of the five PR conflict files is authorized. A fresh reviewer must return explicit `ACCEPT` or
`REJECT`. Until that later result is returned and separately routed, product integration remains
blocked and the controller holds.

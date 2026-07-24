# P1.I format remediation and integration lane

## Authority and provenance

- Project: `agent-teams-hosted-web-refactor`
- Phase: `phase-01`
- Current node: `P1.I.FORMAT.REMEDIATION`
- Serial successor: `P1.I.INTEGRATION`
- Lane packet revision: `phase-01-p1-i-integration-r3`
- Router revision: `phase-01-p1-i-format-remediation-router-r1`
- Router `packetBaseSha`: `b482e816a90e9bb988a0797565241bae4d60b690`
- Remediation evidence ID: `P1.I.FORMAT.REMEDIATION`
- Downstream evidence IDs: `P1.I.INTEGRATION` and `P1.I.ROLLBACK`
- Profile for every producer and reviewer: `gpt-5.6-sol`, `xhigh`,
  `serviceTier: "default"`; Fast is prohibited
- Root role: sole orchestrator
- Durable controller: `controller-v17`, `HOLD`, observation-only
- Terminal state after every authorized attempt: `HOLD`

The canonical authority is clean and remote-equal. It contains the accepted lint remediation and the
existing 69 canonical P1.I inputs. Terminal job
`agent-teams-hosted-web-refactor-p1-i-integration-v17-r1` returned immutable `BLOCKED`/`HOLD`:

- patch SHA-256: `d94f8dfa6548427e007402e8771c469c8e661cd64de3a8728dec042a509aebbe`;
- manifest SHA-256:
  `1b88a6e8e53199f0b1905d4f4c194525bcb86db185f0e4748acf60f69bb78f94`;
- audited rejection ledger: present;
- gate result: 13 of 14 passed; and
- sole failure: exact 74-path Prettier reports
  `docs/research/hosted-web/phase-1/reviews/routes-ratchets.md` unformatted.

The rejected patch and its blocked five outputs are provenance only. They must never be materialized,
applied, copied, repaired, salvaged, reviewed for acceptance, or integrated. This lane inserts one
exact formatting remediation before a fresh P1.I evidence-freeze producer.

This router author starts nothing. No worker starts until the router has independent acceptance,
broker integration and push, and root has immutably bound the exact broker-returned pushed commit as
`postRouterIntegrationAuthoritySha`, proved a clean worktree, and attested equality to the sole result
of `git ls-remote origin refs/heads/refactor/hosted-web-feature-boundaries`.

## Exact mandatory reads

Read in this order. Directory reads, globs, recursive research reads, implicit siblings, rejected
patch materialization, and the whole master plan are not authorized:

1. `AGENTS.md`
2. `docs/hosted-web-phases/START_HERE.md`
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. `docs/hosted-web-phases/phase-01/lanes/p1-i-integration.md`
8. `CLAUDE.md`
9. `AGENT_CRITICAL_GUARDRAILS.md`
10. `docs/FEATURE_ARCHITECTURE_STANDARD.md`
11. `docs/hosted-web-phases/PACKET_STANDARD.md`
12. `docs/hosted-web-phases/phase-01/README.md`
13. `docs/hosted-web-phases/phase-01/execution-dag.md`
14. `docs/hosted-web-phases/phase-01/architecture-and-contracts.md`
15. `docs/hosted-web-phases/phase-01/conformance-and-tests.md`
16. `docs/hosted-web-phases/phase-01/operations-and-risk.md`
17. `docs/hosted-web-phases/phase-01/packet-inputs.md`
18. the exact 68 paths in `EXECUTION_INDEX.json.phase1CanonicalInputs`, in exact group and path order
19. `.codex-handoff/phase-01-p1-i-lint-remediation.json`, the accepted 69th P1.I input

The index must be expanded and validated as 68 distinct manifest paths and 69 distinct existing P1.I
inputs before reading the first manifest path. Nothing nearby becomes an input implicitly. The
format-remediation handoff created by this lane is not a 70th P1.I input.

## P1.I.FORMAT.REMEDIATION start gate

Root must capture one immutable pre-start snapshot proving:

1. this exact seven-path router is independently accepted, broker-integrated, and pushed;
2. `postRouterIntegrationAuthoritySha` is the exact broker-returned pushed commit and equals local
   `HEAD`, admission `expectedSourceCommit`, and the worker contract authority fields;
3. the worktree is clean and the explicit remote ref equals that SHA;
4. all existing 69 Phase 1/P1.I inputs are present at their canonical bytes from
   `b482e816a90e9bb988a0797565241bae4d60b690`;
5. `.codex-handoff/phase-01-p1-i-format-remediation.json` and all five P1.I outputs are absent;
6. the immutable exact-74 finding is exactly the one unformatted Markdown path above;
7. the rejected patch and its five candidate outputs have not been materialized or applied;
8. no remediation producer/reviewer, P1.I producer/reviewer, P1.F, Phase 2+, unrelated product worker,
   or successor controller is active;
9. dependencies are broker-materialized offline and worker install/fetch/update is disabled; and
10. admission uses the exact default-only profile.

Any mismatch ends `HOLD` without launch. Root uses this admission shape:

```text
operation: codex_goal_project_refill_worker
workerRole: producer
node: P1.I.FORMAT.REMEDIATION
model: gpt-5.6-sol
reasoningEffort: xhigh
serviceTier: default
sourceRemote: origin
sourceBranch: refactor/hosted-web-feature-boundaries
expectedSourceCommit: <postRouterIntegrationAuthoritySha>
preStartAdmission.mode: serial-builtin
preStartAdmission.contract.kind: worker-launch
preStartAdmission.contract.format: 1
preStartAdmission.contract.canonicalSha: <postRouterIntegrationAuthoritySha>
preStartAdmission.contract.baseSha: <postRouterIntegrationAuthoritySha>
preStartAdmission.contract.phaseStartSha: <postRouterIntegrationAuthoritySha>
preStartAdmission.contract.packetRevision: phase-01-p1-i-integration-r3
preStartAdmission.contract.controllerPacket: docs/hosted-web-phases/phase-01/controller-packet.md
preStartAdmission.contract.lanePacket: docs/hosted-web-phases/phase-01/lanes/p1-i-integration.md
preStartAdmission.contract.phaseId: phase-01
preStartAdmission.contract.laneId: p1-i-format-remediation
preStartAdmission.contract.inputPatchHash: null
preStartAdmission.contract.reviewKind: implementation
```

No fallback model, tier substitution, Fast mode, concurrent worker, retry, refill, producer-side
reviewer launch, network query, moving source ref, or rejected patch/input binding is authorized.

## Exact remediation ownership and edit

The producer owns exactly these two paths, in this order:

1. `docs/research/hosted-web/phase-1/reviews/routes-ratchets.md`
2. `.codex-handoff/phase-01-p1-i-format-remediation.json`

Before any write, record the canonical Markdown SHA-256 and semantic-token SHA-256 and compute the
expected formatted bytes with the repository-installed Prettier module using the Markdown filepath.
Then the only authorized repository writer command is:

```bash
pnpm exec prettier --write docs/research/hosted-web/phase-1/reviews/routes-ratchets.md
```

The Markdown after that command must hash exactly to the precomputed expected formatter output. A
second formatter evaluation must be byte-identical. No other `--write`, format/fix command, editor,
patch, substitution, append, generated file, or cleanup is permitted.

No word, link, heading, list marker, table value/alignment, inline-code token, fenced-code byte, HTML
token, identifier, command, SHA, disposition, finding, or successor statement may change. Only
repository-pinned Prettier formatting is legal.

There is no product, test, fixture, P1.I output, dependency, config, lockfile, router, review, registry,
temporary repository output, or third-path exception.

## Exact semantic-token proof

The producer and reviewer use this algorithm over the canonical base bytes and candidate bytes:

1. normalize CRLF/CR line endings to LF;
2. identify fenced code blocks opened by three or more backticks or tildes and retain each fence token
   and every content line byte-for-byte;
3. identify Markdown table-delimiter rows only when every nonempty pipe-delimited cell matches
   `^:?-{3,}:?$`; replace only each delimiter's hyphen run with `---` while retaining leading/trailing
   alignment colons and pipe structure;
4. retain inline-code spans and HTML comment tokens byte-for-byte;
5. emit the remaining ordered non-whitespace tokens without changing punctuation or text; and
6. SHA-256 hash the UTF-8 JSON encoding of that ordered token array.

Before and after token hashes must be equal. Fenced-code and inline-code token arrays must also be
equal independently. Table alignment-colon arrays must be equal. This is supplemental to exact
formatter derivation: the post-write raw SHA must equal the SHA of Prettier's output computed from the
canonical raw input before the write.

The handoff records the exact algorithm version
`phase1-markdown-semantic-token-v1`, before/after raw hashes, before/after semantic-token hashes,
fenced/inline token hashes, table-alignment hashes, pinned Prettier version, expected format hash, and
post-write format hash.

## Required remediation checks

Validate pinned formatter derivation before and after the sole write. The producer may use a Node
process that imports the repository-installed `prettier` package to compute bytes/hashes in memory;
it may not write through the API. The CLI command above remains the only Markdown writer.

After the handoff is final, run exact two-path Prettier:

```bash
pnpm exec prettier --check \
  docs/research/hosted-web/phase-1/reviews/routes-ratchets.md \
  .codex-handoff/phase-01-p1-i-format-remediation.json
```

Acceptance is exit `0` with exactly two matched paths. Parse the handoff as JSON and recompute all
recorded hashes and token proofs.

Read-only Git is authorized only for these provenance, diff, and scope observations; staging,
checkout, apply, commit, merge, push, reset, integration, rejected patch access, or index mutation is
forbidden:

```bash
test "$(git rev-parse HEAD)" = "$postRouterIntegrationAuthoritySha"
git diff --check
git diff --cached --quiet
git diff --name-only "$postRouterIntegrationAuthoritySha" -- \
  docs/research/hosted-web/phase-1/reviews/routes-ratchets.md
git ls-files --others --exclude-standard
git status --short
```

The tracked diff must contain exactly the Markdown, the untracked set must contain only the handoff,
the staged set must be empty, and status must resolve to exactly two paths. The Markdown diff must be
exactly the pinned formatter output already proved from canonical input.

Scan the exact same two paths and classify every match:

```bash
remediation_paths=(
  docs/research/hosted-web/phase-1/reviews/routes-ratchets.md
  .codex-handoff/phase-01-p1-i-format-remediation.json
)
test "${#remediation_paths[@]}" -eq 2
rg -n -i '(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|bearer|cookie|authorization)' "${remediation_paths[@]}"
rg -n -i '(provider|anthropic|claude|openai|opencode|gpt-[0-9])' "${remediation_paths[@]}"
rg -n '(/Users/|/home/|/root/|/tmp/|~/|[A-Za-z]:\\Users\\|real[-_ ]project)' "${remediation_paths[@]}"
file --mime-type "${remediation_paths[@]}"
```

Also prove both paths are valid UTF-8 text with no NUL byte. Required model/profile metadata,
repository-relative paths, provenance hashes, scan-command text, and explicit prohibited-action
language are control text, but every match still requires classification. Any real secret,
auth/provider payload, private/real-project/task-temporary path, raw command/runtime body, binary, or
unclassified match fails.

Do not run product tests, ESLint, typecheck, full lint, app/runtime flows, or a second writer. The
immutable terminal record already establishes that every non-format P1 gate passed; this lane changes
no product/test token and must not reinterpret those gates as remediation checks.

## Remediation handoff and self-review

`.codex-handoff/phase-01-p1-i-format-remediation.json` follows `PACKET_STANDARD.md` and records:

1. schema, phase, node, lane, packet/router revision, evidence ID, and terminal `HOLD`;
2. `baseSha`, `canonicalSha`, `planBundleCommit`, `phaseStartSha`, and `headSha`, all equal to
   `postRouterIntegrationAuthoritySha`;
3. the exact two `changedPaths` in writer order;
4. the immutable terminal job, `BLOCKED`/`HOLD`, rejected patch/manifest hashes, audited-ledger
   presence, exact-74 failure, and never-integrate disposition without importing rejected bytes;
5. canonical Markdown raw SHA, expected pinned-Prettier output SHA, final Markdown SHA, pinned Prettier
   version, and idempotence result;
6. exact semantic-token algorithm version and all equal before/after semantic/fenced/inline/table
   hashes with semantic token change count zero;
7. exact two-path Prettier, JSON parse, diff, scope, scan, UTF-8/NUL and MIME results;
8. explicit self-review of formatter derivation, complete Markdown diff, token proof, hashes, writer
   scope, handoff, classifications, and rejected-attempt quarantine;
9. no claim of independent acceptance, integration, P1.I completion, or successor authority; and
10. `nextAction: "independent-verification"` and `terminalState: "HOLD"`.

Before returning, the producer rereads the complete Markdown diff and handoff. Any ambiguity, scope
expansion, missing classification, token/content change, hash/gate failure, or unsupported claim ends
`HOLD` with no self-repair outside the two paths.

The strict producer result is:

```text
P1_I_FORMAT_REMEDIATION_PRODUCER_RESULT {"status":"VERIFIED","evidenceId":"P1.I.FORMAT.REMEDIATION","changedPathCount":2,"semanticTokenChangeCount":0,"nextAction":"independent-verification","terminalState":"HOLD"}
```

`VERIFIED` is legal only when every gate passes. On failure, replace only `status` with `BLOCKED` or
`FAILED`. The result plus broker-captured immutable bytes/hashes for both paths is required; heartbeat,
PID, tmux, changed-file notice, or provider observation is insufficient.

## Independent remediation review

After producer termination and immutable two-path capture, root proves no remediation producer or
reviewer is active and prepares exactly one fresh independent reviewer:

```text
operation: codex_goal_project_prepare_verifier
workerRole: reviewer
reviewScope: P1.I.FORMAT.REMEDIATION
model: gpt-5.6-sol
reasoningEffort: xhigh
serviceTier: default
sourceRemote: origin
sourceBranch: refactor/hosted-web-feature-boundaries
expectedSourceCommit: <postRouterIntegrationAuthoritySha>
inputPatchHash: <brokerCapturedFormatRemediationImmutableOutputHash>
reviewKind: review
```

The reviewer is fresh and independent of the router author, format producer, terminal blocked-attempt
worker, and prior Phase 1 workers. It is read-only over the exact two candidate paths, broker-captured
canonical base bytes, and execution documents needed to evaluate them. It has no writer, repair,
lifecycle, integration, retry, refill, network, provider, runtime, agent-flow, registry,
rejected-patch, or real-project authority.

It independently inspects the exact Markdown diff, proves pinned formatter derivation, reruns semantic
token/fenced/inline/table equivalence, validates every hash, runs exact two-path Prettier and scans,
validates the handoff and self-review, and returns exactly one immutable result:

```text
P1_I_FORMAT_REMEDIATION_REVIEW_RESULT {"disposition":"ACCEPT","findingCounts":{"P0":0,"P1":0,"P2":0},"reviewedPathCount":2,"integrationPathCount":2,"semanticTokenChangeCount":0,"terminalState":"HOLD"}
```

`ACCEPT` requires complete proof and zero P0/P1/P2 findings. `REJECT` uses the same schema with
nonzero finding counts and immutable finding details. Admission, provider, environment, or
missing-result incidents remain `HOLD` and are not synthetic `REJECT`.

On `ACCEPT`, root may mechanically call `mark_reviewed`; only then may the broker integrate and push
exactly the two paths in writer order. On `REJECT`, root may not mark reviewed, the broker may not
integrate, and P1.I may not start. The only permitted follow-up is a separately admitted bounded
remediation addressing immutable findings within these same two paths and the same default-only
profile. It grants no broad cleanup, unrelated edit, direct retry, or integration authority.

## Direct P1.I.INTEGRATION continuation

After accepted format-remediation integration, root resolves the exact broker-returned pushed commit
as `postFormatRemediationIntegrationAuthoritySha` and proves:

1. clean worktree and exact equality to the explicit remote branch ref;
2. the integration changes exactly the two accepted remediation paths;
3. all integrated bytes/hashes equal the independently accepted immutable candidate;
4. all 68 manifest paths and the accepted lint-remediation handoff are present, making the unchanged
   P1.I input set 69 distinct paths;
5. only `routes-ratchets.md` differs among those 69 inputs from
   `b482e816a90e9bb988a0797565241bae4d60b690`, and it equals the accepted pinned-Prettier output;
6. the format-remediation handoff is present as provenance but excluded from the 69 P1.I inputs;
7. all five P1.I outputs are absent;
8. rejected patch/output bytes were never materialized, applied, copied, or selected for integration;
   and
9. exact pinned Prettier over all 69 canonical inputs exits `0`.

Those facts directly satisfy the prerequisite for one fresh five-output producer. No further docs
router is required. Root then admits one fresh `P1.I.INTEGRATION` producer at
`postFormatRemediationIntegrationAuthoritySha` using the same default-only profile and lane packet
revision.

The P1.I producer retains exact output ownership:

1. `.codex-handoff/phase-01-p1-i.json`
2. `docs/research/hosted-web/phase-1/decision-register.json`
3. `docs/research/hosted-web/phase-1/estimate-reconciliation.json`
4. `docs/research/hosted-web/phase-1/evidence-index.json`
5. `docs/research/hosted-web/phase-1/integration-report.json`

Its read-only input set is the 68 paths in `phase1CanonicalInputs`, evaluated at accepted format
authority, followed by `.codex-handoff/phase-01-p1-i-lint-remediation.json`: 69 distinct inputs. The
format handoff is not an input. The rejected patch, manifest, and blocked outputs are not inputs or
salvage carriers.

The fresh producer must generate all five output files anew from those canonical inputs. It must not
reuse, copy, compare for adoption, materialize, or integrate any blocked output. The existing 14 P1
gate IDs remain mandatory. Exact checks are:

- full Phase 1 plus team-lifecycle Vitest: 13/13 files and 60/60 tests;
- focused ratchet Vitest: 1/1 file and 3/3 tests;
- typecheck: seven inherited, zero owned, zero unexpected;
- full `pnpm lint`: exit `0`;
- Prettier and classified scans: exact 69 inputs plus five fresh outputs, 74 paths;
- scratch-only rollback/apply proof: the same exact 54 payload paths, from P1.S0 to
  `postFormatRemediationIntegrationAuthoritySha`, with forward byte equality and reverse absence;
- diff/scope: exactly five untracked P1.I outputs with no staged or tracked change; and
- provenance, predecessors, tests, negatives, ratchet, security, decision, estimate, evidence
  lifecycle, integration report, handoff, self-review, and terminal `HOLD` requirements.

The fresh P1.I producer strict result is:

```text
P1_I_PRODUCER_RESULT {"status":"VERIFIED","evidenceIds":["P1.I.INTEGRATION","P1.I.ROLLBACK"],"changedPathCount":5,"nextAction":"independent-verification","terminalState":"HOLD"}
```

After terminal immutable five-path output, root may start exactly one fresh independent P1.I
milestone reviewer. That reviewer is read-only over 69 inputs plus five outputs (74 paths), uses the
same default-only profile, and returns `ACCEPT` or `REJECT`. On `ACCEPT`, root may `mark_reviewed` and
the broker may integrate and push exactly the five P1.I outputs. On `REJECT`, no integration occurs.

## Stop conditions and HOLD

Stop and end `HOLD` on authority drift, profile mismatch, extra/missing path, writer command/target
beyond the exact pinned formatter, output not exactly derived from canonical input, any semantic-token
or content drift, hash mismatch, Prettier failure, staged path, scope/diff mismatch, unsafe or
unclassified scan match, binary output, false handoff field, incomplete self-review, early/concurrent
reviewer, integration before `ACCEPT` and `mark_reviewed`, rejected-byte materialization/use, or
unsupported successor claim.

No current action authorizes product/test edits, fetch, install, app/server/runtime/team launch,
agent-flow tests, real-project access, registry writes, stage, commit, merge, push, raw Git integration,
lifecycle action, P1.F, Phase 2+, unrelated product work, controller replacement, or a successor
controller. The router author performs none of those actions and ends `HOLD`.

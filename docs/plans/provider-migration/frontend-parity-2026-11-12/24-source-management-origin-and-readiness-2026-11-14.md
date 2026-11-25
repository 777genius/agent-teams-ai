# Source management identity and Windows readiness observations

## Exact original failures on 6a17df2

Source `6a17df216d38c55584c6e64803b25fa4cc25e1ef` is the parent of this
fixture-only correction. The two Windows source journeys reached different
failures in [process acceptance run 43650333700](https://github.com/777genius/agent-teams-ai/actions/runs/43650333700).
Their original archives were downloaded and verified before the local workspace
became unavailable.

| Tuple | Job | Artifact | ZIP SHA-256 |
| --- | --- | --- | --- |
| Windows x64 | 132617139342 | 14135864020 | `b46c8618fa6ee5a881089afa5fde56784ce3d75721af9c415aa40e5da393f713` |
| Windows ARM64 | 132617139290 | 14136166808 | `ff8f2ad7f8af761ab8e7d41505da123864fa6bd76c67434c9daa5e64c2c8f5d0` |

The x64 job passed the formerly failing deadline fixture, original Windows
Node/Electron Job checks and Main/Host finite provider routes. Its Codex source
journey published A, launched Team A, published B and reached B management.
The public B metadata and outer source identity checks passed. The following
nested management profile assertion failed. All ten original source Jobs were
resumed, stopped, drained and released, with original HANDLE absence confirmed;
both scenario and outer cleanup were true. This is a failed source journey,
not a complete Windows qualification.

The ARM64 journey published A but failed the original 15-second Team readiness
poll before reaching B management. Its receipt contains six original Jobs,
all resumed/stopped/drained/released with original HANDLE absence and both
cleanup results true. The observed thread/start exchange does not establish
native readiness: the product projection also requires the original binding,
ready record, provider readiness and current authority. The receipt lacks the
last runtime view, so the reason for the readiness failure is not established.
The seed-ID correction below does not claim to solve this different ARM failure.

## Preserve both identities at their actual boundaries

The original source model deliberately contains two distinct identities:

| Boundary | Required identity |
| --- | --- |
| Selected public management profile and returned metadata/probe | `runtime-source:<revision>` profile/config IDs naming one retained source revision |
| Outer physical process origin | Exact retained source ID and revision |
| Nested management origin and Main credential association | Original captured management seed profile/config IDs |

`RuntimeSourceIndex.managementProcessOrigin` verifies the public derived
profile against retained history. Its `managementOrigin` then emits the
original seed IDs inside the nested management origin. Main's
`matchesWindowsSourceAssociation` requires those exact seed IDs together with
the outer source revision, original association, account binding and private
credential namespace. The source scenario incorrectly compared the nested
seed IDs to the public alias.

Only the two expected IDs in that TEST assertion now come from `selected`,
the hash-bound original descriptor management entry. The outer source/revision
join, actual B peer entry, public metadata/probe identities, runtime recipe
scope, no-Team-connection checks and original physical cleanup remain mandatory.
Production source and permission/custody policy are unchanged.

The existing captured Windows source history/pending cases passed 7/7, including
the original seed association and foreign configuration refusal. Retained-host
TypeScript, focused fast lint and diff checks passed for this small identity
correction before the workspace outage. Root and pr_graph independently reviewed
the original producer, Main association and later scenario assertions.

## Observe the existing readiness poll without changing it

The same existing runtime.read loop now retains one bounded last-read snapshot:
original source/image/launch identity, successful read count, monotonic elapsed
time, and the public member ID, generation, phase, sealed/custody/nativeReady/
attached state and optional diagnostic enum. It retains no messages, inputs,
interactions, credential values or accumulated history.

A single `TEST_SOURCE_READINESS` line emits this same snapshot when the original
poll returns or throws. The outer controller already inherits stdout and accepts
the existing stage lines without a parser; the authoritative receipt is still
written separately. This provides remote-readable evidence when ZIP extraction
is unavailable. It is a diagnostic line, not a successful readiness receipt.

The RPC sequence, predicate, poll interval, 15-second budget, error propagation
and native qualification gates are unchanged. Both independent reviewers accepted
this passive observation. It was added after the local workspace became
unavailable, so no local execution/type/lint PASS is claimed for its new bytes.
The exact next-head native workflow, including its original type checks, must
validate the complete amended scenario.

## Other validation and preserved limits

The same 6a17 Darwin x64 process job 132617139260 passed: 150 Host tests with two
explicit skips, 53 broker tests, 65 Main tests and 23 POSIX tests. Artifact
14135947281 was verified against
`aa32e3a1b048a3dd6ccdbd25243ebb8c6e7e4ce191d40a6f1e2d29c2452acab3`.
Its native Darwin registration, Desktop and release qualification flags remain
false. Separate OpenCode business successes do not close P09's executable-image
and selected-script boundary.

A bounded attempt at the unchanged root `tsc --noEmit` command on clean 6a17
ended with SIGKILL after 20.58 seconds, before its 260-second observation bound.
The monitor sent no signal, recorded peak original-process RSS 1,432,336 KiB and
an empty compiler log, and observed no remaining owned process. The cause of the
kill is unknown; RSS alone is not proof of OOM. The resource-only Go GC controls
did not change the TypeScript configuration. Full application types therefore
remain an original Team CI gate, not a local PASS.

The workflow YAML and concurrency groups are unchanged. GitHub evaluates PR path
filters against the three-dot PR diff, so a small latest commit can still trigger
the existing Desktop matrix and supersede queued work. Each actual receipt stays
attributed to its original source SHA; cancelled or queued lanes are not execution
evidence. See [GitHub's documented diff comparison](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#git-diff-comparisons).

The PR remains Draft. Real Codex and Claude Code are excluded. No main merge,
release, default-path activation or Stage 2 advancement is part of this cut.

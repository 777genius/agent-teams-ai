# Plan82 — Keep Runtime and transport incarnation checks in their own domains

Status: prospective source correction against delivery/primary `cd6258fe557b16793fb28b6391d4601a059c8b53`, tree `797e11f34ff169a8f472959409295500ec7ad610`. Source has not been authored or qualified. This amends only the invalid cross-domain assertion in Plan73's existing finite Windows owner-loss helper.

## Original failure and cause

Original Windows x64 job `133870300375`, run `44033362637`, step19 failed before the crash marker in `owner-loss-before-resume`. The first assertion at helper375 compared retained Runtime incarnation `f3ab6052-9942-4fd3-ba3c-890cb3d8f04f` with HELLO incarnation `1e9df16c-1e4b-42cf-aed2-c29cbde0d6f7`. Full original raw: 332657 bytes, SHA256 `85c201e7294814c340938141d69866fd63d9499f665beae0074b50473f463249`; original lines1948–1989: 4331 bytes without trailing LF, SHA256 `92b27441c3d178557d36f8f5675a5d1c95906ab29f08e5a1a2acc9b6d1251a34`. Root read that complete bounded span; the full raw is retained by the sole observer, not claimed fully reviewed here. Actual Node24.21.0; controller rootExitCode1/activeProcesses0 and wrapper rejection do not qualify scenario cleanup.

The selected unpackaged profile loads the original CLI, whose profile branch constructs TeamHost. TeamHost constructs RuntimeTeamCoordinator and HostServer separately. Coordinator82 generates the Runtime UUID and supplies RuntimeOwner165; prepareSessionOpen41 persists it before allocation. HostServer index97 generates the HELLO UUID independently, and native transport binding uses that UUID. Public HostServerOptions supplies no shared identity. The assertion compares different identity domains. This is a TEST oracle error, not evidence that production must unify those identities.

## Exact selected source change

Only `tools/owned-process-broker/nativeEmulatedOwnerLossScenario.ts` is writable: current blob `d2d027f5aab70da3396c9b61fa6bf3c6f77a1f05`, 38289 bytes, 539 LF-terminated lines, SHA256 `caef7e9bc7fb22d8295f9a742b45682be1f6ded10339ec42caed8c565a965857`.

1. Retain `originalRecord = read()` at the same boundary. Remove only its adjacent comparison with `aHello.hostIncarnation`. Add the comment `Runtime ownership and transport HELLO use separate incarnation domains.` No forced inequality or substitute native-owner field.
2. Immediately after the existing TeamHost entry in ownSources, add the existing source paths for `packages/legacy-agent-host/src/composition/RuntimeTeamCoordinator.ts` and `packages/legacy-agent-host/src/index.ts`, in that order. These pin the two normative UUID producers; the existing pin capture and unchanged-source verification handle them.

Expected source delta is four added lines and one removed line; final helper542 lines. No other source, product owner/API, fixture peer, compiler, workflow, lane, selector, business input, process operation, timer, retry or budget changes.

## Preserved Plan73 obligations

Transport checks remain attachment==actual HELLO, same Main/profile, distinct A/B HELLO epochs, actual child exit and abort. Runtime checks remain exact binding/profile/open fingerprint, nonempty original Runtime incarnation, one original allocation/prepare, and unchanged original binding/config/profile/open fingerprint/incarnation through cold read, reconcile, replay lookup and cleanup. Existing prepareSessionOpen returns allocate:false for prior opening history, while this scenario requires one actual original allocation.

Both closed loss modes, all input/effect counts, original HANDLE observations, stale/successor resume/write refusals, numeric-PID refusal, no post-loss allocation/input, retained UNKNOWN, first-error capture and every cleanup obligation remain unchanged. Plan73 does not require Runtime UUID==HELLO UUID. A native ProcessOwner has teamIncarnation/runId/laneId/processGeneration; it is not a source for a nonexistent owner.hostIncarnation field.

## Review, publication and validation

Root and independent reviewer bind the current complete tree and exact source references. Publish this documentary selection and its scope/review evidence first using an ordinary delivery lease; read back full actual docs/tree and close independent documentary review before authoring the source child. Review its entire body and exact forward/inverse patch, publish with a normal lease, and verify the actual commit/tree/body and unchanged leaves independently.

Keep useful current CI jobs running. Primary advances only after a fresh sole-observer useful-job guard and all source gates close. Existing automatic resulting-head Windows x64/ARM64 build/contracts/native/controller/provider receipts and full cleanup, plus existing workspace type/lint gates, remain required. No manual Actions dispatch/rerun/cancel or transfer of prior-head PASS. Removing the first incorrect assertion does not prove later W05 stages or cleanup pass. Current workspace unavailability leaves new artifact ZIP bytes, CRC, receipts and visual inspection unqualified.

Plan40's unselected source-writer decision, P10 missing historical originals, genuine provider restrictions, W01/M16 and release/Stage2 holds are unchanged.

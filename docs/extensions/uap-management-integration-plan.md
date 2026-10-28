# UAP management integration in Agent Teams

Status: implementation plan v30; complete the existing user-scope management E2E against current main and matched UAP source 53a4332. The preceding App 42c/UAP 1d pair passed Electron, Full, bootstrap, packaging and the App findings gate. Fresh qualification belongs to the new pair. UAP security disposition and per-member Skill use remain separate; the proposed profile/worktree architecture is still unapproved.

Master contract/lifecycle/scenario plan:
https://github.com/777genius/universal-agent-plugins/blob/feat/management-sdk-20261024/docs/plans/management-sdk-and-agent-teams.md

UAP implementation PR: https://github.com/777genius/universal-agent-plugins/pull/500

Owner authorization on 2026-10-24 covers research, plan revisions, implementation,
real Electron end-to-end verification, early draft PRs, immediate push of every
commit, independent final review, and merge after required checks and resolved
findings. It does not authorize bypassing Full qualification or public release.

## Current checkpoint — v30 (2026-10-28)

The integration incorporates App main
`805003575a8bf3d0790ed15c9cae8998b29a9392` and pins UAP
`53a433298e626d9831adb55bd6fca422cedd5d89`, engine
`0.1.91+agentteams.53a433298e62`. UAP reconciles current main, preserves selected
Skill targets across Management review/Apply and corrects macOS zombie-process
cleanup without ignoring persistent permission failures or surviving descendants.
The SDK was rebuilt and packed from that committed source. Its 25,338 bytes are
unchanged: SHA-256 `570d947dd47766ea52613432dc4615b32df1ea390936f22e94b71bed6bcc79c5`.
SDK tests (43), typecheck and the clean packed consumer pass; new native and
desktop evidence remains required for this source.

The App merge preserves main's equivalent MCP output-directory handling and its
runtime 0.0.145 pin. It introduces no runtime loading, profile, admission or
project-scope design change. The E2E procedure now reflects the already implemented
multi-target selector, passive extra-target discovery and all three native plugin
lifecycles. Its [last completed receipt](uap-management-e2e.md#last-completed-qualification)
is explicitly tied to App 42c/UAP 1d and is not transferred to this revision.

Fresh Full, Electron, bootstrap, packaging and security checks must qualify the
new pair. Per-member managed Skill/plugin-MCP use and S25/S26 retain the recorded
architecture boundary; native `@skills-dir` support is not supplied by a pin change.

## Previous checkpoint — v29 (2026-10-26)

The published app merge `0bdbb0225292d93d16aeceea53b89cdf1e0d55a3`
incorporates main `dc66ae9e3dbe8ad50221c6f0857762c105660b1f`.
Only two overlapping test fixtures required reconciliation. The upstream
observation/no-observation matrix is retained alongside the real-ledger,
backoff/no-resend and native-recovery cases. All 47 focused tests and scoped
lint pass locally; the actual merge `817f7859df344f13b78be29023158829122d5a07`
also passes those 47 cases in
[Full shard 3](https://github.com/777genius/agent-teams-ai/actions/runs/40398095960/job/121839038176).
Its types/build/lint and separate no-new-alert CodeQL findings gate pass.
These are receipts for that pre-pin source.

This follow-up pins UAP `1d2769d99f5f2408c1801b1c6be9c7c1225aa09f`,
engine `0.1.91+agentteams.1d2769d99f5f`. The sole UAP change after source 86
canonicalizes the existing temporary executable parent in the archive lifecycle
test. The preceding Windows broad CLI test failed its strict executable
comparison; the same failure reproduces on an actual symlinked temporary root.
The unchanged two-target control passes. Both cases pass after the correction
on physical and aliased roots, preserving exact executable equality,
zero-unselected-probe, update identity and delivered-byte assertions.
Production and SDK source are unchanged; fresh Windows qualification is required.

The clean committed-source SDK archive remains 25,338 bytes with SHA-256
`570d947dd47766ea52613432dc4615b32df1ea390936f22e94b71bed6bcc79c5`.
Its packed consumer, frozen App install and all 2,522 supply-chain policy
entries pass. The ordinary native stager and existing packaged artifact guards
pass for source 1d, with Linux binary SHA-256
`7c72068fa6b62aecffc963c89e9c5273efd8bff189c59b25404e71a81afd3a78`.
[Fresh UAP Required](https://github.com/777genius/universal-agent-plugins/actions/runs/40398586980)
passes SDK 43/43, clean consumer and all four module lints at this checkpoint;
the complete test lane and platform qualification remain in progress.

The latest completed actual desktop receipt is
[Electron 40392234241](https://github.com/777genius/agent-teams-ai/actions/runs/40392234241)
for app `0f967c52822de8612e9dc1124bb756400ad0621d`, tested merge
`58507d045ff768b8d53161d885797c1cc3548b51`, with UAP 86.
[Artifact 12686472315](https://github.com/777genius/agent-teams-ai/actions/runs/40392234241/artifacts/12686472315)
contains 30 screenshots and the completed receipt: ZIP SHA-256
`5c4acb4f00ac04d2c2772219b7c00f1f2e664091928ca0cc2752b4375ca01b00`;
receipt SHA-256
`a83f2666d1233b8894cc486f8e2d84a5b42f51a5a9def341d858f2b2728f879e`.
Independent review passes 103 receipt checks and all 15 native CLI digests.
Installation, update and all three targeted removals preserve surviving native
identities/bytes; S27 proves active-run refusals and actual post-stop update.
Local recovery, HTTP authority and installed/removed plugin MCP also pass.
Exact S27 identities and owned desktop shutdown are verified; no global
post-cleanup process census is claimed. Per-member Skill-body use is not evaluated.

Current-source Full, Electron, bootstrap, packaging and security gates must
qualify this new App/UAP pair. Previous passing receipts are not transferred.
[Current UAP CodeQL](https://github.com/777genius/universal-agent-plugins/actions/runs/40398587317)
still awaits its language analyses and findings verdict. The historical 0311
aggregate of 12 alerts is not a source 1d result. Formal security disposition
remains outstanding. The reviewed
[launch-readiness proposal](./team-extension-launch-readiness-options.md)
now also explains the Gemini model-provider/native-profile distinction;
A/B implementation still requires the owner's joint decision.

## Previous checkpoint — v28 (2026-10-26)

[Electron run 40387443598](https://github.com/777genius/agent-teams-ai/actions/runs/40387443598)
completes successfully for app `9d2e3c29022ea8691d2bdbc65d6b0bd905045cab`
through synthetic merge `32131509bd97e441b97115b36260424dd9e5059a`.
The verified parents are main `9ff9f85acd94b2b466ac6c7889dcb042f130493a` and
that exact app head; both head and merge have tree
`8ac12c4c20f8a531185f98c202babf468923ba2d`. The matched UAP source is
`86d4d0d4bfc68ea454f9df8840f23461eb043177`, engine
`0.1.91+agentteams.86d4d0d4bfc6`, with app runtime 0.0.140.
[Artifact 12680649876](https://github.com/777genius/agent-teams-ai/actions/runs/40387443598/artifacts/12680649876)
contains the complete receipt and 30 screenshots. ZIP SHA-256 is
`b3646f3a6d192f30930d73b8c7bbf5791b684208150ab9c2b7d79b90561c1c74`;
evidence JSON SHA-256 is
`eb697fdeebdd85f20cd9f210d218b1973c2202626a32e57e094b6140b37498c6`.
The receipt verifies SDK SHA-256
`570d947dd47766ea52613432dc4615b32df1ea390936f22e94b71bed6bcc79c5`
and Linux engine SHA-256
`7088d9241fa8394627952ed84630873a4cdfcd41d1c1ef7839edb4103618908e`.

The full receipt and discovery/removal screenshots were independently reviewed.
`completed=true`, `trackedDirty=false`, and `rendererErrors=[]`. Claude, Codex and OpenCode complete
version-1 installation, version-2 update and all three targeted removals through
the actual Electron UI and Go/SDK/host path. Each review requires the exact
selected mutation plus every unchanged sibling. After each removal, remaining
native identities, marketplaces, source paths and file digests equal the
version-2 baseline; removed files are absent. The final installed set is empty.
Codex's explicit native plugin/marketplace uninstall prerequisite is verified.
Local edit/delete, host restart and visible Undo restore exact original bytes;
the existing HTTP authority and idempotent-mutation checks also pass.

S27 completes with an actual runtime lead and inherited worker. All five retained
Apply requests (install/update/repair/sync/remove), fresh Prepare and UI attempts
refuse before acceptance while the same owned PID/start identities remain alive
and protected state stays unchanged. The unrelated OpenCode lifecycle succeeds.
Ordinary Stop is followed by confirmation that both exact owned process identities
are gone, then Claude update succeeds. Initial discovery marks all three primary
clients available and selected, with Cursor available and unselected; the Cursor
executable stays byte-identical and its permanent execution witness remains
absent after UI inspection and owned desktop shutdown.

Native OpenCode 1.18.34 offers and calls the installed plugin MCP tool through the
scripted loopback provider; after removal, tool offers, calls and MCP requests
are absent. Cursor coverage proves passive discovery only. The three-client
matrix proves native visibility and delivered bytes; `modelSkillUse` remains
`not_evaluated`. It does not prove Skill-body or plugin-MCP use by every
app-launched team member. Profile/worktree proposals A and B remain unapproved
and unchanged.

### Exact-source CI and narrow follow-ups

[Full source run 40387443494](https://github.com/777genius/agent-teams-ai/actions/runs/40387443494)
uses the same app 9d2 / merge 3213. Canonical typecheck, build and all 24 MCP tests
pass, as do test shards 2, 3 and 4. Full is not qualified: features lint reports
one optional-promise `Promise.allSettled` error, and shard 1 has four
`nativeProfileAdmission` fixture failures (5,623 other tests pass) because mocked
environment replies omit the required `contextId`.

The bounded production correction changes shutdown's `map` to `flatMap` so
`allSettled` receives only existing replacement promises. Exact typed lint has
zero errors, all 15 lifecycle cases pass, and independent review passes. The
separate test-only correction supplies typed environment replies, `contextId`
and `hasExited`, and asserts the precise interrupted-operation fence. Its four
original failures reproduce; the corrected focused suite passes 9/9 and the
combined application suites pass 60/60, with independent review passing. The
corrected fixture also passes scoped native TypeScript with unchanged root
compiler options and the standard test-file fast lint. Captured-authority and
durable-pending production guards remain unchanged. The completed 9d2 receipts
belong to that exact source; this follow-up requires fresh hosted Full and
applicable platform/security gates.

[UAP Required 40384418585](https://github.com/777genius/universal-agent-plugins/actions/runs/40384418585)
passes all six jobs on exact 86d source, including 43 SDK tests; conformance
passes 133 cases with zero failures.
[UAP CodeQL 40384418509](https://github.com/777genius/universal-agent-plugins/actions/runs/40384418509)
has not completed at this checkpoint. The latest completed findings inspection
remains historical source 0311: 12 alerts, comprising 2 Critical and 10 High.
All nine reviewed security sink/guard files are unchanged from e84 to 86d;
that comparison is not a formal disposition or a current-source security pass.

## Previous checkpoint — v27 (2026-10-26)

[Electron run 40383086576](https://github.com/777genius/agent-teams-ai/actions/runs/40383086576)
tests app `75ec93b425a7bda84083bfeb883aa1fc548481e5` through synthetic merge
`371b02dea7d7c7c5599142c9cf3c8bdac81fb738`. The actual parents are main
`9ff9f85acd94b2b466ac6c7889dcb042f130493a` and that app head; merge and head
share tree `94297f5f01bb19e6808350d90b799393d1ce11ec` and runtime 0.0.140.
[Artifact 12679319631](https://github.com/777genius/agent-teams-ai/actions/runs/40383086576/artifacts/12679319631)
has ZIP SHA-256 `1d7062f60ca902fda1a6941028b3c9567fb528451d96f14b6cfad8ecd0a206a5`;
its evidence JSON has SHA-256
`a9e7526a995adb82df0376aaab1c8c2c93523f4e8f7fe987576369602761b155`.

The receipt completes S27: actual inherited worker and lead remain alive while
all five retained mutation requests refuse without acceptance; fresh preparation
and UI attempts also refuse, and native/state observations remain unchanged.
The unrelated OpenCode lifecycle succeeds. Both exact owned processes stop,
then Claude update succeeds as operation
`84900f7396c15e58228114c18c7defee43954ef2dc02b98002d6833c99c69af2`.
Passive discovery/initial selection and both nonexecution witness checks pass.
The installed native OpenCode plugin offers and calls its MCP tool through the
scripted provider; after removal, the tool and MCP requests are absent. Renderer
errors are empty. This does not establish Skill-body or plugin-MCP use by every
app-launched team member.

The three-client plugin matrix completes installation
`94141f09ace92236fd084582d1f9b323710f3248905c6f228a44bf47e120d106` and update
`6489425792af967577ae90a94c95b4dc8e52372418709175f875ce6e6aab7659`.
Actual Claude, Codex and OpenCode observations verify version-1 then version-2
bytes and stable native identities/source locations. The run then fails before
the first removal Apply: the harness expected one review row, but Go correctly
reviews one Claude removal and unchanged Codex/OpenCode sibling bindings.
The screenshot, saved receipt and exact Go plan/coordinator source agree.
There is no completed removal operation in this failed receipt.

The review assertion now requires the exact selected mutation and every expected
unchanged sibling, with total row cardinality still strict. Missing/duplicate
targets, extra mutations, changed siblings, an unrequested target or a different
plugin are rejected. After each removal, surviving native identities, marketplace,
source paths and all file digests must equal the version-2 baseline. Existing
selected-target absence and Codex explicit external-uninstall prerequisites stay
mandatory. The original assertion fails both intermediate removal controls; the
corrected fixed-CDP/DOM controls pass all 12 cases, and 24 combined UI-boundary
cases pass. Scoped native TypeScript, lint and independent reviews pass. The
entire actual matrix must still run on the new source.

### Confirmed owned-engine exit and reconnection

A current-head review exposed cached contexts surviving their owned engine's
exit, leaving refresh and launch admission attached to a dead HTTP client.
[UAP 86d4d0d](https://github.com/777genius/universal-agent-plugins/commit/86d4d0d4bfc68ea454f9df8840f23461eb043177)
exposes the read-only Node-host `hasExited` property from the actual child's exit
code or signal. Generic process errors and HTTP failures do not prove exit; the
SDK never restarts the engine automatically. Two actual-child controls fail
against the previous SDK and pass after correction. All 43 SDK tests,
build/typecheck and clean packed-consumer checks pass locally; the fresh hosted
SDK lane also passes 43 tests and the packed consumer.

The app replaces only a confirmed exited connection, coalesces concurrent
reconnection, and preserves its logical context plus shared admission identity.
The new session must match the original captured authority and pass fresh
durable inspection. Failed inspection retains the fence and retries on the same
live child. A shared recovering-context set prevents an unrelated empty read
from releasing that fence. Connection generations guard late old reads,
preparation, Apply and operation followers. Unaccepted old review handles expire;
accepted operation IDs and uncertain original plan/request pairs remain intact.
Exact uncertain replay uses Go's durable-request lookup and existing definitive
refusal handling; it never recreates an old prepared plan or selects a new request
identity. Shutdown waits for and closes any in-flight replacement.

Fifteen new deterministic lifecycle cases and 36 existing application cases pass.
Scoped native TypeScript, lint, formatting, the source-size guard and independent
review pass. A separate real-process application control reproduces
`ECONNREFUSED` on old app 75ec after killing only its exact owned UAP PID. The
corrected application creates a new owned PID, retains app/Go context and
environment identities, reads the durable environment, then admits launch.
Both controls verify that all owned processes exit. This does not change the
separate profile-selection/worktree policy under discussion.

The matched engine is `0.1.91+agentteams.86d4d0d4bfc6`. Its SDK archive is
25,338 bytes, SHA-256
`570d947dd47766ea52613432dc4615b32df1ea390936f22e94b71bed6bcc79c5`;
exact committed-source Linux staging has SHA-256
`7088d9241fa8394627952ed84630873a4cdfcd41d1c1ef7839edb4103618908e`.
Frozen dependency installation and all 2,522 supply-chain entries pass. Fresh
[UAP Required 40384418585](https://github.com/777genius/universal-agent-plugins/actions/runs/40384418585)
and [CodeQL 40384418509](https://github.com/777genius/universal-agent-plugins/actions/runs/40384418509)
must finish on this source. Earlier UAP 0311 passed Required and both analyses,
but its separate findings gate failed with 12 alerts: 2 Critical and 10 High.
No formal security disposition or merge is claimed by these implementation proofs.

### Current-main test contract alignment

The fresh Full shard found three inherited failures in two OpenCode suites whose
production source is identical to main `9ff9f85` / PR #1024. That PR deliberately
permits read-only reconciliation of an uncertain group handoff, while forbidding
another send. It also requires either a live tracked owner or committed session
evidence plus native confirmation before reusing a persisted active lane.
The older fixtures still prohibited observation and omitted mandatory recovery
ports through a cast. Production policy is preserved; only those two fixtures
are corrected to test the current contract.

The group tests now use the actual file ledger and handoff transition, verify
original message/group/run/session/prompt/attempt identities, and require no
ordinary or serialized resend, unchanged attempt count and observation backoff.
The bootstrap fixture retains actual `canDeliver=false` and
`canAttemptCommittedRecovery=true`; the real recovery factory calls a typed
native `reconcile`, while prepare/launch/stop and missing-host recovery remain
forbidden. Exact committed lane/run proof is required. Absent native evidence
and a Stop before the scheduled recovery both prevent relay. A mocked relay
does not establish guarantees about Stop during an already in-flight observation.
The original three failures reproduce; both corrected suites pass 43 cases in
two independent runs, with scoped native TypeScript, lint and review passing.

The full local canonical typecheck is killed with exit 137 without diagnostics,
including a retry that limits compiler memory/parallelism without changing any
compiler option. No complete local canonical pass is claimed. The new published
head still requires fresh hosted Full, complete Electron removals, packaged and
security qualification; preceding-source checks cannot substitute for them.

## Previous checkpoint — v26 (2026-10-26)

[Electron run 40376857048](https://github.com/777genius/agent-teams-ai/actions/runs/40376857048)
tests app `876b9890a7730631be12294a9922347bf6350b67` through merge
`34e9901b3e85ce244a59671d91b795a57ecd4497` with actual main
`9ff9f85acd94b2b466ac6c7889dcb042f130493a`. Its saved receipt verifies the exact
UAP `0311d9b` SDK and engine, initial primary selections with Cursor unchecked,
actual available/detected session targets, unchanged fixture executable bytes
and no execution witness both after the UI observation and after owned shutdown.
This completes the passive discovery/selection boundary. It also preserves the
earlier source Skill lifecycle, native OpenCode discovery, HTTP capability and
idempotency checks, binary copy, update/removal, and local edit/delete/restart/
exact-restore observations. Renderer errors are empty.

The overall run fails when S27 attempts actual team launch. Main's new MCP build
hook writes its deployment manifest to `mcp-server/dist/package.json` even when
the application passes a private generation directory through `--out-dir`.
On a clean runner, that shared `dist` directory does not exist, so the build
refuses with `ENOENT` before the members are alive. The current-main integration
now honors the actual tsup CLI output directory while preserving the normal
deployment manifest. No shared-directory creation or workflow prebuild masks the
wrong destination. A real tsup regression fails on the original custom-output
case and passes both default/custom cases after correction. The complete merged
MCP source builds in both modes with identical index SHA-256
`69d1d51bf61f1e18ea418605fce60e32aeddd46078963b4141c7333a07c5754b`;
custom-first execution leaves the shared default directory absent. Manifest,
Node syntax and package-resolution checks pass, followed by independent review.

[Artifact 12677310754](https://github.com/777genius/agent-teams-ai/actions/runs/40376857048/artifacts/12677310754)
has ZIP SHA-256 `584a0b8fa810645844ca3efb088f095ca479c5a320893822dbd1ad9b0afdeb0d`.
Its primary error and complete evidence file survive cleanup. An earlier
cancelled run exposed premature live-log closure on child `exit`; the harness
now waits for `close`, after stdout/stderr close. A real child-process control
loses late output with the original event and preserves it with the corrected
event. That cancellation chronology is not presented as a functional UI failure.

A new review finding exposes late unaccepted plans being dropped by the hook's
generation check before the plan cleanup effect can own them. The request helper
now accepts an optional stale-result release callback, supplied only by ordinary
Prepare and local restore preparation. Cleanup uses the original host context,
including a separately captured authoring context. Apply and operation results
do not acquire that callback. Five regressions fail against the previous hook;
seven final cases and the existing lifecycle controls pass (20 cases in seven
files). They cover context/tab/unmount transitions, separate restore authority,
cleanup rejection beside a newer uncertain Apply, and exact retry identity.
Scoped native TypeScript, lint, formatting, source-size guard and independent
review pass without production-policy or assertion weakening.

The preceding hosted canonical check also found an overly wide action type in
the new admission test fixture. An explicit `ManagementPlan` annotation corrects
the fixture without changing production behavior. Fresh canonical and Electron
qualification of the current-main integration remains required. This checkpoint
does not claim S27 completion or plugin-matrix completion for the failed 876 run,
nor does it approve the profile/worktree proposals below.

## Previous checkpoint — v25 (2026-10-26)

[Electron run 40368582518](https://github.com/777genius/agent-teams-ai/actions/runs/40368582518)
tests app `e740e39cc0a57c2d790d0e6118a957baafd73d08` through merge
`021cbc64849975335972afa88cd8901d5bf3763b`, whose parents are main
`d1a0832c89a7e250389755ae83bcb5424ebd12e9` and that exact app head.
S27 again records `completed: true`, including the actual post-stop Claude
update `c1070a2811d31dc405e725b8442bd18b6ddcd09527b7089362d912e70d925292`.
The downstream matrix completes three-target UI installation
`769b5bbd4d046b8b5f5651acf07a5640538654def327d6ba81c1582e36bfaede`.
After the versioned Codex cache correction, all three native identity and exact
version-1 file observations pass. Update preparation then refuses with the
bounded public `OPERATION_REFUSED` response; no update or removal completion is
claimed. [Artifact 12672271513](https://github.com/777genius/agent-teams-ai/actions/runs/40368582518/artifacts/12672271513)
has ZIP SHA-256 `ab3a273d72533e841bb29fee0712211db7828162e785c2261e4227aed7691f83`.

A real Management HTTPS-archive regression reproduces that refusal with all
three installed targets while the Claude/Codex control passes. Claude update
compatibility checks include the installed OpenCode sibling, but its immutable
host facts were not prepared. The corrected installer prepares only verified
installed siblings belonging to the selected installation, validates binding
identity before probing, and freezes a separate host snapshot. Root, executable
and version remain checked before Apply. Unrelated OpenCode installations do not
create a new prerequisite. Six sibling regressions, 27 existing host protection
cases and both real archive lifecycle variants pass; independent review finds
no remaining P1/P2 in this correction.

The matched source is [UAP 0311d9b](https://github.com/777genius/universal-agent-plugins/commit/0311d9b373725a80d6be529717b726a3e1910f97),
with engine version `0.1.91+agentteams.0311d9b37372`. The SDK archive has SHA-256
`3f7b3984149099d2e9beecf13a0f89aaba10c47a3059c387998de9345f4730f3`.
Its production SDK build/typecheck and 41 SDK tests pass. The first combined CI
also found two executable fixtures sharing one Go package; a separately reviewed,
byte-preserving move isolates the new fixture in its own directory. The fixture's
PID marker now uses a root-confined write with an explicit Go 1.25 file minimum;
the actual pinned Go 1.26.10 includes and checks that file. Focused Go vet,
golangci-lint 2.13.2 and all 14 discovery tests pass after those corrections.
The packed SDK bytes are identical across the two fixture-only follow-ups.
Fresh hosted gates must qualify this final source rather than the superseded
first commit.

The combined app changes pass 36 cases across the five profile/admission/target
and presentation suites, scoped lint, the source-size guard and the native
desktop-E2E TypeScript configuration. One complete local canonical typecheck is
killed with exit 137 without TypeScript diagnostics. No complete local pass is
claimed; fresh hosted canonical validation remains required.

The same pin completes the previously missing passive target-capture boundary.
Go's existing detector and explicit client registry own native paths, executable
facts and support policy. `manage discover` returns a bounded, versioned private
response; the Node SDK uses fixed arguments, filters the environment and owns
deadline/abort cleanup. It does not execute discovered native clients. A safely
inspectable profile remains captured when its client becomes undetected, so
existing bindings can still be inspected and removed; new installation is
refused before acquisition. Unsupported detected clients are display-only
observations and never acquire installation authority.

The desktop keeps its primary Claude Code/Codex/OpenCode profile capture and
adds only the qualified Go profiles. Available primary clients start checked;
other detected targets start unchecked. Unknown renderer selections are refused
against the captured inventory. Extra targets neither expand local authoring
roots nor become team runtimes. A bounded Electron fixture now observes the
actual session and initial controls, using an inert Cursor executable whose
persistent execution witness and exact bytes are checked before and after the
owned desktop stops. This qualifies detection and selection only, not Cursor
installation, runtime behavior or Skill-body use. Cleanup failures remain
separate from the original scenario failure and cannot turn the run green.

The previous app source completes canonical hosted workspace typechecks/build,
MCP E2E, all four test shards and three lint shards; its separate CodeQL findings
check reports no new alerts. Those results do not qualify these new app changes.
On the previous UAP `2647dcc` source, both analyses pass but the separate findings
gate still reports 12 alerts (2 Critical / 10 High). Fresh source checks and
formal disposition remain required; no alert suppression or protection bypass
has been performed.

The [launch readiness options](team-extension-launch-readiness-options.md)
retain A then B as proposals for owner discussion: align the final native
profile identity, then prepare the exact lock and CWD-dependent configuration in
the runtime's actual worktree before spawn. Neither is implemented or approved
by this installation-target work. Installed files, native discovery, Skill-body
use and per-member plugin MCP calls remain distinct evidence levels.

## Previous checkpoint — v24 (2026-10-26)

[Electron run 40365381127](https://github.com/777genius/agent-teams-ai/actions/runs/40365381127)
on app `bc8a3959c8ae74d1629017fb26bc810d05874172` reaches and completes S27.
The artifact records `completed: true`: the inherited Claude worker and lead
are alive, all five retained mutation Apply requests refuse without acceptance,
fresh Prepare and UI attempts refuse, desired/native state stays unchanged,
the unrelated OpenCode UI/MCP lifecycle succeeds, both exact owned processes
stop, and the subsequent Claude update succeeds. Its successful post-stop
operation is `e54c267f12334981beef530d57e2ffcf086cc3a05d11c2be000ea965f9a290e0`.
This establishes admission and stop/update behavior, not per-member managed
Skill-body or plugin MCP use.

The same run then completes the new plugin's three-target UI installation.
Claude native identity and exact delivered bytes pass. Codex's actual native
listing reports an installed/enabled plugin, its exact managed local source and
version `1.0.0`. The evidence collector incorrectly looked in the `local` cache
slot. In pinned Codex `rust-v0.153.4`, the cache slot is the plugin version;
`local` is a fallback for an absent manifest version, not a synonym for a local
source. The corrected collector requires the native listing's version to match
the reviewed revision and reads that exact versioned cache. It does not search
for an arbitrary matching file or weaken source/cache bytes, manifests, native
identity or pre/post-removal absence checks.

A separate disposable-profile control uses the exact CI Codex binary
(`0.153.4`, SHA-256 `56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da`).
The original observer reproduces the missing `local` path; the corrected
observer passes actual source/cache bytes and manifests at `1.0.0` and `2.0.0`,
refuses the stale expected revision and observes real plugin/marketplace removal.
Temporary source cleanup in that control is explicitly separate from UAP
removal. Scoped native desktop TypeScript, fast lint, formatting and independent
review pass. The control qualifies the corrected native observation contract;
it does not replace the complete Electron matrix.

The full workflow remains failed at that observation, before update/removal.
[Artifact 12670297846](https://github.com/777genius/agent-teams-ai/actions/runs/40365381127/artifacts/12670297846)
has ZIP SHA-256 `994e640b9e7ddc5934aaa46f2c83d33e897e71ac53ac71b6e034086a64234fd8`.
The current-commit full plugin matrix must run again after this correction.

Hosted validation on the same tested merge completes the canonical workspace
typechecks, workspace build and MCP E2E, all four test shards and all three lint
shards. App CodeQL's separate findings aggregate reports no new alerts. This
supplies actual hosted qualification where the local compiler was killed; the
remaining Windows/package/bootstrap aggregate gates are tracked separately.
The tested merge `a2b3222b43e453ce85cfcd1b97944fefc64e0593` has parents
`d1a0832c89a7e250389755ae83bcb5424ebd12e9` and `bc8a3959`. Its newer main base
pins orchestration runtime `0.0.140`; the PR head's `0.0.139` lock is not the
runtime used in this receipt. Exact commit parents and checkout evidence are
used instead of the stale normalized PR base field.

## Previous checkpoint — v23 (2026-10-26)

[App 4177cd41a](https://github.com/777genius/agent-teams-ai/commit/4177cd41a2b3126463b94e23d0d23c405000ae25)
publishes the multi-target controls, three-client plugin lifecycle exercise and
the independently reviewed Claude trust-file correction described below. Its
new Electron run is
[40364514381](https://github.com/777genius/agent-teams-ai/actions/runs/40364514381).
The exact combined snapshot passes 28 UI/workflow/helper/trust tests. Local
combined compiler processes were killed with exit 137 without TypeScript
diagnostics; no complete typecheck pass is claimed for those attempts. The
previous matrix-only canonical pass does not replace the fresh full gate.

A newly reported local Skill defect exhausted the engine's sixteen-review limit
after repeated preview/back or close. The existing local Skills facade now has
an owned-window discard operation. Editor/import lifecycle cleanup releases only
its own unattempted plan on back, close, replacement or unmount, including a
preview that returns late. Attempted or uncertain Apply retains the original
plan/request identity. The existing Electron-only local Skills API remains
Electron-only; no partial HTTP mutation facade was added.

Independent review also reproduced two managed-copy races: a late preview could
overwrite the newer review owner, and a failed discard could clear its owner
before retry. Captured owner/context/generation checks now prevent the first;
retaining one discard promise until success closes the second. Apply cannot
race an in-flight discard. Four concrete regressions fail before correction,
and the final seven focused suites pass 40 tests after correction. Scoped lint
and source-size checks pass; the legacy editor stays below its frozen size cap.
Independent review reports no remaining P1/P2 in this correction.

This checkpoint does not claim S27, the new three-client Electron exercise,
live-model/OAuth use or project/worktree preparation has passed. Current-source
hosted qualification, the separate UAP findings aggregate and the owner's
profile/worktree architecture discussion remain required.

## Previous checkpoint — v22 (2026-10-26)

Installation now has a separate multi-select control. Available captured Claude
Code, Codex and OpenCode targets start checked; any additional captured targets
start unchecked. The renderer sends their actual captured IDs in one Prepare,
retains the reviewed selection through acknowledgment, and refuses an empty or
catalog-incompatible selection. The existing runtime selector still chooses the
view and the target for removal/copy. The current desktop host captures the three
supported runtimes only; generic renderer support does not claim that additional
clients are already detected by the host.

The desktop exercise explicitly selects OpenCode for the original Skill and
plugin journeys, preserving their state history and assertions. After S27 stops
the real team, a new plugin exercise uses the UI to review/install one inert
HTTPS archive for all three clients, advance the publisher to different version
2 bytes, review/update all three, and remove each target separately. Each step
must have a new completed operation and exactly the reviewed target set.
Native CLI listings, receipt paths, manifests and exact Skill bytes establish
installation/discovery. Codex's documented external-removal prerequisite removes
its observed plugin and marketplace before the UI acknowledgment. Previously
recorded native files must be absent both before and after the next native
listing. This exercise explicitly records model Skill use as `not_evaluated`.

The UI target/admission regressions pass 28 cases in five files. Canonical
typecheck and scoped lint also pass for the independently reviewed matrix. These
are local checks, not a completed Electron receipt for the new exercise.

[Electron run 40361663014](https://github.com/777genius/agent-teams-ai/actions/runs/40361663014)
on app `2e21c38640168d2a0e81834d647d0dde4c6f5716` and UAP `2647dcc`
passed the original retained-state Claude Skill installation. Its artifact records
the delivered native files and then real team creation with an inherited Claude
worker. The worker fails with `Workspace trust required`, although the app's
preflight reports a persisted trusted project key. The observed orchestration
artifact is `0.0.140`; the earlier source review of `0.0.139` does not qualify it.
[Artifact 12669700691](https://github.com/777genius/agent-teams-ai/actions/runs/40361663014/artifacts/12669700691)
has ZIP SHA-256 `89e25c116e6820982113cac0bb07315965a66d79a2473886f4b22467a11daffb`.
The narrow trust correction makes the shared probe/persister honor an explicit
process `CLAUDE_CONFIG_DIR`, including a value equal to the default directory;
the app's custom profile keeps its existing priority. Previously the app wrote
`HOME/.claude.json` while that native launch read
`CLAUDE_CONFIG_DIR/.claude.json`. Four new regression cases fail before the fix;
all 35 focused composition/status/persister/probe cases pass afterward, followed
by independent review. No trust value, persistable-root guard, approval strategy
or launch environment changes. Shell-only environment overrides and broader
profile alignment are not qualified by this correction. S27 and the downstream
plugin matrix still require a new complete hosted receipt.

Two independent architecture reviews recommend effective native profile identity
before final-worktree preparation. The
[launch-readiness options](team-extension-launch-readiness-options.md) record the
Codex account refresh race, runtime-owned final CWD, CWD-dependent MCP/settings
resolution and additional-target detection boundary. These are proposals for
owner discussion; neither profile migration nor a worktree preparation protocol
is implemented here. The newly reported local Skill review-abandonment defect is
being handled separately. Current-head Full/Electron qualification and UAP's
formal CodeQL disposition remain merge requirements.

## Previous checkpoint — v21 (2026-10-26)

The original desktop sequence exposed a real retained-state defect in UAP:
OpenCode Skill install → update → last-target removal → Claude installation of
the same source. Last-target removal preserves the installation and `PLUGIN_DATA`
but removes its live environment receipt. A subsequent Management preparation
reserved a new installation ID, and the state validator correctly refused the
duplicate source-binding ID. The clean-profile CLI control did not contain that
retained state and therefore succeeded.

[UAP 2647dcc](https://github.com/777genius/universal-agent-plugins/commit/2647dccb510a69e8915e528e49feda51c34a3182)
reuses only the uniquely inspected empty installation for the exact source.
Ambiguous identity and a changed reviewed reservation still fail closed. Native,
scanner, source and state validation remain unchanged. An empty retained registry
identity does not borrow the eligibility exception for a live installed release.
The retained lifecycle regression fails with the original production code for
both same-client and cross-client reinstall, and passes with the fix. It also
checks retained data bytes/ownership, read-only preparation, matching reviewed
paths and negative identity cases. Independent source review found no P1/P2.
Local Git-source suites remain limited by this execution host's missing Linux
process-observation interface; they are not reported as passing native tests.

The app pairs its SDK and native engine to that exact UAP source, with engine
version `0.1.91+agentteams.2647dccb510a`. The SDK was rebuilt and typechecked from
a clean committed checkout; its unchanged contract produces the same 22,404-byte
archive and SHA-256 `02d921a6466a7eca86c8161e8d6de0a4ac9b7ee0ed1135de3f27d12bdfcbea0e`.
The source-qualified archive name, manifest, all lockfile references and native
stager now identify the corrected source.

[App 705bd0855](https://github.com/777genius/agent-teams-ai/commit/705bd0855ba8dd6438bfcd24d0babbb759b29923)
resolves inherited member providers before marking native clients active. An
entirely Claude team no longer blocks unrelated Codex/OpenCode mutations merely
because a member omits its provider. Unknown provider information remains
conservative. The three regression cases failed before the correction; all 15
focused composition/profile/context tests, canonical typecheck and scoped lint
passed afterward, followed by independent review. S27 now uses a naturally
inherited worker provider and verifies its effective saved selection.

The original S27 Apply assertion and its preceding stateful desktop journey are
preserved. No fresh diagnostic success can replace them. A new hosted run must
prove the original Claude install, active-team refusals, unaffected OpenCode
lifecycle and actual post-stop update before S27 is qualified. The earlier
7f09d0d Full, CodeQL, bootstrap and package results remain historical receipts;
they do not qualify this new SDK/native source. The twelve UAP CodeQL findings
also retain their separate formal-disposition gate.

## Previous checkpoint — v20 (2026-10-26)

App `26e2169768e9e7dd540bbfd35653f34a8b318301` completed
[Full qualification 40339355196](https://github.com/777genius/agent-teams-ai/actions/runs/40339355196),
including all four test shards, three lint shards, validation and the Windows
task-ledger smoke. Its
[Electron retry 40339355009](https://github.com/777genius/agent-teams-ai/actions/runs/40339355009)
failed at the same initial Claude `install_skills` operation, before team creation.
The [artifact 12657809847](https://github.com/777genius/agent-teams-ai/actions/runs/40339355009/artifacts/12657809847)
records clean synthetic merge `184462971947501b4942f0d185849e18c314243f`, the
matched UAP e84 source, no renderer exceptions and ZIP SHA-256
`fb213566bdbe1f13f3fb449608b7fffd3d9e665e23e3383e1dc42e8639f4a1e4`.

The failure-only receipt observed an owned pinned Go process with PATH 1,014
bytes, 1,187 allowed environment bytes, no duplicate allowed names and matching
HOME/state roots. All thirteen observed task `children` interfaces were readable.
This snapshot does not reproduce the earlier local missing-interface condition
or an oversized environment. It is not the Go command's own exact preflight
receipt. Ordinary environment inspection retains the declared Skill and partial
operation with no recorded binding. The independently supplied native Claude
listing succeeds with `[]`. These observations do not identify the underlying
installer error or prove native materialization.

The accepted Management record retains the bounded public outcome, not the raw
installer reason. Existing installer journals do not preserve that missing error
either. A failure-only control therefore invokes the unchanged pinned Go CLI's
ordinary `skills add` path exactly once in a separately owned disposable profile,
against the same live fixture publisher and verified Claude binary. It records
bounded public CLI stderr, which preserves the underlying Apply error. Normal
scanner acquisition and policy remain active. The control never retries the
original Management request, mutates its profile or replaces its failing assertion;
a successful control would qualify only its own fresh-profile CLI path.

The original Electron run and several unrelated workflows were cancelled before
the test; one addressed Electron job rerun produced the failed receipt above.
The available API did not identify the cancellation cause. Bootstrap/packages
therefore have no completed current-head result. App CodeQL JavaScript/TypeScript
analysis passed, while Actions analysis failed after its last logged stage,
result upload, without a recorded cause; the findings aggregate is neutral with
the Actions category missing.
These checks remain open. No cancellation or upload failure is treated as a
source finding or a successful qualification. The new test-only control requires
its own completed hosted receipt; S27 remains unqualified.

## Previous checkpoint — v19 (2026-10-26)

App `81ef6678748e134150dd76fcd3cf3806ba858132` incorporates main
`5a111a4aca356469b8e86d0950c4033227b2951a`. Its
[Full qualification 40334877379](https://github.com/777genius/agent-teams-ai/actions/runs/40334877379),
[four-platform bootstrap 40334877323](https://github.com/777genius/agent-teams-ai/actions/runs/40334877323)
and [App CodeQL 40334877168](https://github.com/777genius/agent-teams-ai/actions/runs/40334877168)
passed; the findings aggregate reports no new alerts. The package matrix was
still running without a reported failure at this checkpoint.

The [Electron attempt 40334877180](https://github.com/777genius/agent-teams-ai/actions/runs/40334877180)
advanced beyond native-client availability but stopped at the initial managed
Claude Skill operation: `partial` / `incomplete`. It did not create a team.
The [failed artifact 12657117191](https://github.com/777genius/agent-teams-ai/actions/runs/40334877180/artifacts/12657117191)
records clean synthetic source `6c908644c6fd6a65b6611c66bbbe4a8cad6165a1` and the
matched UAP e84 pin; ZIP SHA-256 is
`c994b21e9e79596fed00487e78a1d8d58aff1c9d8ea8ead680b55809262cb28f`.

The result's `mutated: true` includes publication of desired manifest/lock state;
its destination is a retained planned path. Neither proves native materialization
or activation. That artifact retained only the bounded public operation error,
so it cannot identify the underlying native phase or cause.

The harness now retains ordinary environment/readiness inspection on a failed
terminal Apply, plus a bounded read-only `plugin list --json` from the supplied
verified Claude artifact in the isolated fixture profile. This probe is explicitly
not evidence of Management's selected executable. Secondary inspection failures
are retained without replacing the strict `succeeded` assertion; no operation is
retried and no production policy is changed.

Failure-only process metadata additionally requires a live descendant of this
harness's launcher with the exact pinned Go executable. Stable process/ancestor
identities are checked before and after bounded reads. The receipt contains only
allowlisted environment byte lengths/counts, profile-equality booleans and task
`children` interface availability; it contains no environment values. These facts
can test actual hosted prerequisites without bypassing the native-command guard.
The helper was exercised with the real pinned Go server under a disposable owned
launcher: an oversized synthetic PATH was measured, private marker names/values
were absent, and wrong-executable/non-owned-launcher controls refused inspection.
The desktop E2E compiler project, scoped lint/format and independent source/security
review passed for these test-only diagnostics.

An independent local native-layout control passed with the pinned Claude binary.
The exact Go binary's ordinary native-command path encountered this local host's
known missing `/proc/.../children` prerequisite. That separate host limitation is
not assigned as the hosted CI cause, and its containment guard is unchanged.
The next hosted receipt must establish the actual failure boundary before any
product correction is chosen. S27 and complete current-source desktop qualification
remain pending.

## Previous checkpoint — v18 (2026-10-26)

This continuation reconciles current main
`5a111a4aca356469b8e86d0950c4033227b2951a`. Upstream independently included the
snapshot-worker extraction and four test-contract corrections; the merge keeps
the added positive controls, real filesystem-error fixtures and both desktop
E2E entrypoints. It does not import the deferred project/Host architecture.

App `9e39edc476682e0ddcb62950daac338e6d045fec` completed
[Full qualification 40331654999](https://github.com/777genius/agent-teams-ai/actions/runs/40331654999),
including canonical validation and all test/lint shards. Its
[Electron attempt 40331654911](https://github.com/777genius/agent-teams-ai/actions/runs/40331654911)
stopped before team creation: the dev launcher intentionally removes
`CLAUDE_CLI_PATH`, while the isolated fixture PATH included only OpenCode.
The verified native Claude binary therefore remained unavailable to the ordinary
Management discovery boundary. The fixture now prepends both verified native
binary directories to PATH; production launch behavior and assertions are unchanged.
The [failed artifact 12655570705](https://github.com/777genius/agent-teams-ai/actions/runs/40331654911/artifacts/12655570705)
records clean synthetic merge `acbc6dad3a0f5e85d233f4392390aa1818bca313`, no renderer
exceptions and no active-team receipt. Its ZIP SHA-256 is
`ee8041d65ce852c497185bc057fedc074bfa9d427b3474ada82c4c793b029048`.

Inspecting the real Claude projection exposed a separate managed-copy defect:
the installed source selector skipped `.agentplugins-runtime/skills` because
its package container is hidden. A real-filesystem regression failed before the
fix. Traversal now enters the checked `.agentplugins-runtime` child of an
inventoried root only to inspect its checked `skills` directory, preserving
containment, no-symlink checks and traversal bounds. Independent review caught
the need to exclude container-root and example `SKILL.md` decoys from that native
surface. Other hidden directories, private source containers and nested lookalikes
remain excluded. Focused tests cover exact text/binary copy preparation and
symlink refusals. The desktop scenario also checks the ordinary preload
source selector against its actual Go-installed Claude package before team launch.

The final copy regression suite passes all eight tests. After reconciliation,
108 impacted tests across twelve files pass, including inbox/provisioning,
runtime installation, worker snapshots, close/shutdown coordination, the upstream
group-reply policy and existing UAP UI/workflow checks. The desktop E2E compiler
project, scoped lint/format and unchanged source-size guards also pass.
Independent review found no remaining P1/P2 in the copy correction or six merge
resolutions. These focused checks do not substitute for fresh hosted Full CI.

These changes require a fresh completed Electron receipt and applicable CI for
their own source. They do not qualify per-member Skill-body use or change the
owner's discussion checkpoint for launch/profile/worktree architecture.

## Previous checkpoint — v17 (2026-10-26)

App `af9807b263d86b8d0728c967ab7a0566f24a2a99`, UAP
`e84b4da218f4445986daa9ed15f40acd828ae06f`, completed the existing
[Electron journey 40328623401](https://github.com/777genius/agent-teams-ai/actions/runs/40328623401).
Its [artifact 12655235205](https://github.com/777genius/agent-teams-ai/actions/runs/40328623401/artifacts/12655235205)
records clean synthetic merge `b68a626eafc37656ed01833af2a5be6d67ba9a54`, twenty
screenshots, no renderer exceptions, actual OpenCode 1.18.34 plugin MCP invocation
and post-removal absence, native Skill discovery, HTTP authority and exact
restart-visible restoration. ZIP SHA-256:
`a764713060a94c8671717f5fd84a28376063fc48ec2c760d41056ca679885e4e`.
This receipt does not include the active-team scenario added below.

The explicit S27 desktop requirement remained unqualified by that journey.
The added test uses the ordinary app `teams.createTeam` entrypoint, the real
pinned orchestrator, an idle Anthropic lead and worker, and the existing scripted
loopback model server. Native Claude 2.1.263 is separately provisioned and verified
through UAP's pinned download helper for Management's Claude target; the
orchestrator is never substituted for that CLI.

The test retains five valid reviews before launch, then proves active-profile
refusal for install, update, repair, locked sync and removal at Apply. It also
checks fresh Prepare and a visible UI refusal, unchanged manifest/lock/installer
state/native inventory and absence from the accepted-request ledger. Healthy
locked sync is explicitly an `unchanged` request-admission control, not a claim
that files were restored. While both owned native member processes remain alive,
the existing OpenCode plugin UI/MCP lifecycle supplies the unaffected-client
control. A normal team Stop must end both observed OS process identities before
a fresh Claude update changes actual installed bytes. No native readiness,
process or installer receipt is synthesized. The new scenario requires its own
fresh completed CI receipt; this checkpoint does not claim it passed.

Review of that boundary found an existing capacity bug: a newly prepared Go
review was abandoned when the post-prepare activity check refused it. Ordinary,
local-Skill and copy preparation now best-effort discard only that unaccepted,
unreturned review, preserving the original refusal. Already-issued reviews and
accepted-operation recovery are unaffected. Four regressions failed before the
fix; 57 focused tests pass afterward, including repeated refusals beyond the
16-review limit and later successful acceptance. Independent source review found
no P1/P2 in this correction.

The af9807b Full run also exposed five stale assertions in four inherited tests.
The current inbox reader treats a not-yet-created directory as empty history;
real `ENOTDIR` fixtures retain unavailable-history checks, and direct filesystem
assertions preserve fresh-only inbox initialization. The runtime installation
test now preserves existing supported OpenCode V1/V2 instead of expecting an
unoffered major migration. Production policies remain unchanged. The four fixes
and existing reader controls pass 69 focused tests and independent review.

UAP e84 completed all sixteen workflows. Its separate CodeQL findings aggregate
still reports twelve findings (two Critical, ten High); the PR records individual
review proposals and the available connector's formal-disposition limitation.
Fresh App Full, Electron, bootstrap/package and security checks remain required
for the new source. Per-member Skill-body use, other native desktop lanes and
S25/S26 retain their explicitly separate scope/evidence boundaries; risky launch
architecture work remains at the owner's discussion checkpoint.

## Previous checkpoint — v16 (2026-10-26)

The published `c39c7201d11448028c2844b9a6ef486a3607e8e3` candidate has now
completed all of the qualification runs that v15 left pending:

- [Full qualification 40207898589](https://github.com/777genius/agent-teams-ai/actions/runs/40207898589):
  canonical validation, four test shards, three lint shards and Windows smoke passed.
- [Actual Electron 40207898641](https://github.com/777genius/agent-teams-ai/actions/runs/40207898641):
  the complete existing desktop/HTTP journey passed; its
  [artifact 12604612872](https://github.com/777genius/agent-teams-ai/actions/runs/40207898641/artifacts/12604612872)
  retains screenshots and operation evidence.
- [CodeQL 40207898674](https://github.com/777genius/agent-teams-ai/actions/runs/40207898674):
  both analyses passed and findings aggregate `121213689149` reported no new
  alerts in changed code.
- [Bootstrap 40207898575](https://github.com/777genius/agent-teams-ai/actions/runs/40207898575)
  passed all four targets; [packaged matrix 40207898722](https://github.com/777genius/agent-teams-ai/actions/runs/40207898722)
  passed Linux x64, macOS x64/arm64 and Windows x64/arm64, including its full gate.

The Electron receipt qualifies synthetic merge `2918a0d81e93bee167fd8f5873fafdf4b00dec6a`
against main `c3d300419a7957152be77e72dce569d302cbe045`, with UAP `1bdc7bb4`.
The other runs remain tied to that candidate and their recorded checkout.
The continuation incorporates main `363417fba21c026515c9a8058e60513e18ec5769`;
the resulting candidate still needs fresh qualification. Prior passes are not
reassigned to the new source tree or a new engine pin.

The matched SDK/runtime pin now identifies committed UAP source
`e84b4da218f4445986daa9ed15f40acd828ae06f` after its current-main merge and bounded
local-Skill receipt hardening. The reviewed compatibility baseline remains
`agentplugins-v0.1.91`; the build version is `0.1.91+agentteams.e84b4da218f4`.
The SDK was rebuilt and packed from that clean source. Its archive is
byte-identical to the prior SDK because the TypeScript package did not change;
manifest, lockfile, archive name and provenance all identify the new source.
This pin update does not claim a public release or new native launch coverage.
Normal frozen installation passed the existing supply-chain and security-patch
checks. Canonical typecheck passed all eight projects; the impacted extension,
runtime-integrity and workflow suites passed 128 tests, with the existing
macOS-only signature test skipped on Linux. Exact committed-source staging built
the Linux x64 helper and measured version `0.1.91+agentteams.e84b4da218f4`, with
SHA-256 `92956d1a510ad5c0433314ca2a666e8c0436e2df25cc17dc5c6874d025ece586`.
These local checks do not replace fresh Full, Electron or platform packaging CI.

The main sync exposed two source-size violations: the upstream work-sync worker
had reached 849 lines and the combined main entrypoint exceeded its frozen cap by
four lines. Snapshot reads now live in a focused worker helper, preserving the
same indexed alias lookup, SQL payload scope and ordering. The existing shutdown
runner body moved to a utility receiving the same logger, with unchanged timeout,
error and drain behavior. The worker is 773 lines; the main entrypoint is 3,679
lines and its cap is lowered accordingly. Both source/architecture guards and
the seven existing snapshot/shutdown tests pass. No exception was added.

Upstream CLI project support has since landed through UAP #472/#499; the earlier
#475/#480 drafts were consolidated and closed. That removes the old CLI-source
dependency, but does not implement Management project scope or actual-worktree
preparation. The captured desktop adapter still refuses native project scope,
and Host #982 remains a separate draft. S25/S26 therefore remain incomplete.
No draft Host code is imported. The proposed multi-target installation selection
and additional detected-agent UI remain proposals, not completed acceptance.

[Actual-team launch research and options](team-extension-launch-readiness-options.md)
record the conditional Codex profile discrepancy, native discovery boundaries
and remaining per-member Skill/MCP evidence. Launch architecture changes remain
at the owner's research-and-discussion checkpoint.

## Previous checkpoint — v15 (2026-10-25)

Published security head `601464170db4de441c6544f026e6e94b5bb36d71` pins the
rebuilt SDK and engine to UAP `1bdc7bb4c111da19c93d2839b7403e4a7d57df57`.
The new exact-source Go/Python/native Skill qualification passed in one attempt;
the [receipt](https://github.com/777genius/universal-agent-plugins/pull/500#issuecomment-6399607073)
records engine SHA-256
`7084ef196eaceb555acda97414d40cee02ed2dfe7a31ef20aa86275506857d83`, exact fixture
bytes, retained-plan/replay behavior and actual OpenCode 1.18.34 discovery.

Its first [desktop attempt 40207474794](https://github.com/777genius/agent-teams-ai/actions/runs/40207474794)
stopped at the initial cache guard before checkout. Job `121211397210` reports
**Cache mode: none**, but the shell did not receive `ACTIONS_CACHE_MODE`. The
exact runner 2.338.0 implementation injects this variable into
[NodeScriptActionHandler](https://github.com/actions/runner/blob/v2.338.0/src/Runner.Worker/Handlers/NodeScriptActionHandler.cs)
and container actions, not ordinary ScriptHandler shell steps. Changing runner
providers would not correct that observation boundary.

The minimal follow-up moves the literal fail-closed guard into the official
`actions/github-script` action, pinned to reviewed v8 commit
`ed597411d8f924073f98dfc5c65a23a2325f34cd`. It remains the first step and must
complete before either project checkout or any checked-out code executes.
It reads the action's real environment; no workflow, job or step fabricates the
mode. PR-only execution, scoped cache denial, read-only contents and the current
runner choice are preserved. The regression executes this exact checked-in
guard in an isolated JS context for missing, empty, read, write, write-only and
none modes, replacing the inappropriate shell child test.

The first desktop attempt remains failed and does not establish any new GUI
result. The CDP data-boundary correction, source pin and application behavior
are unchanged. The follow-up also incorporates reviewed main
`c3d300419a7957152be77e72dce569d302cbe045`, whose two-file message-relay change
has no management or workflow overlap. New current-head Full, Electron,
packaging and complete CodeQL results remain required; earlier qualification
is not reassigned to this combined tree.

## Previous checkpoint — v14 (2026-10-25)

This checkpoint addresses the owner's exact list of seventeen CodeQL findings,
including App alerts 580 and 581. The complete input/guard/sink ledger and the
correction to the earlier blanket false-positive review are recorded in
[UAP's remediation record](https://github.com/777genius/universal-agent-plugins/blob/feat/management-sdk-20261024/docs/plans/management-codeql-remediation-20261025.md).

App alert 580 follows tracked UAP source provenance into cross-repository code
execution in the desktop workflow. The privileged `workflow_dispatch` trigger
has been removed; ordinary pull-request qualification remains. The job declares
`cache-mode: none` and its first step verifies `ACTIONS_CACHE_MODE` before any
checkout or action. This denies actual cache restore/save authority, rather than
assuming read-only repository permission or disabled configured caches is enough.
Existing workflow reruns remain available. No query or protection is disabled.

App alert 581 groups fourteen dynamic-code flows. The desktop helper now has one
fixed checked-in renderer dispatcher and passes selectors, labels, operation IDs
and timestamps through CDP `CallArgument.value`. The only `Runtime.evaluate`
expression is the literal `globalThis`. No runtime value becomes JavaScript
source. Node-side observation callbacks preserve fresh operation IDs, exact
restore-point metadata, bounded menu/tab acknowledgement and single Apply.
Real pointer/key input, native MCP invocation and post-removal absence, HTTP
authority, actual restart, exact file bytes and all twenty screenshots remain
part of the actual Electron journey. Remote objects are released without
masking a primary failure.

Twelve focused helper tests pass, including hostile data, DOM selection,
hidden warning matches, stale completion and cleanup errors. Desktop TypeScript,
scoped lint and formatting pass. Two workflow metadata tests pass. The actual
Bash guard test cannot spawn Bash in the local sandbox (`EPERM`); it remains
enabled for CI and is not recorded as locally passing. Independent source
review found no P1/P2 in the five-file security slice. The new candidate must
still pass a real Electron run and both CodeQL analyses and findings aggregate.

The matched UAP source is `1bdc7bb4c111da19c93d2839b7403e4a7d57df57`, with engine version
`0.1.91+agentteams.1bdc7bb4c111`. It corrects component-order package-link
validation, confines journal reads with `os.OpenInRoot` and removes an
unnecessary local archive metadata probe from Management admission. Regression
tests reproduced the defects before the fix. The Windows native-link test
explicitly preserves the existing rejection of backslash targets; production
package policy and digest framing are unchanged. The SDK is rebuilt and packed
from the final committed source. Its archive is byte-identical because the
TypeScript contract did not change; its SHA-256 remains
`02d921a6466a7eca86c8161e8d6de0a4ac9b7ee0ed1135de3f27d12bdfcbea0e`.
Manifest, lockfile, archive name and provenance identify the same source. A local
offline lockfile refresh lacked cached `@babel/core` supply-chain metadata; the
exact identical-archive filename substitution was parsed and verified without
disabling that policy. A normal frozen dependency installation remains required
in CI.

The candidate also incorporates reviewed main
`3cf1397d8375d33f7e2005752b4f8feed3c2a2dc`. Its earlier macOS signing budget,
Mach-O scan and narrow Apple-network retry changes merge cleanly with the
existing UAP packaging hooks. The subsequent renderer diagnostic update keeps
telemetry opt-out, collects only closed types and bounded counts, and does not
change management authority or UI actions. No direct-main push, gate bypass or
public release is part of this checkpoint.

For historical evidence, published App head
`7667b158c368b07655fb1d0c288b8e88efd21587` passed
[Full 40193962521](https://github.com/777genius/agent-teams-ai/actions/runs/40193962521),
[desktop 40193962417](https://github.com/777genius/agent-teams-ai/actions/runs/40193962417),
all four bootstrap targets and the original seven-job package qualification.
The desktop [receipt with twenty screenshots](https://github.com/777genius/agent-teams-ai/pull/989#issuecomment-6397851225)
and [package receipt](https://github.com/777genius/agent-teams-ai/pull/989#issuecomment-6398717407)
belong to that head and its named merge checkout, with UAP 8645. They do not
qualify the new engine, changed CDP helper or updated base. CodeQL was still
failing there with App's two findings; UAP's first ae51 correction scan reduces
its count from fifteen to thirteen, still failing. Source review and a successful
analyzer run do not replace formal alert disposition.

## Previous checkpoint — v13 (2026-10-25)

App head `c91077de653ff1f52c84f14689e13c34366ef3cf` passed substantive
[Full qualification 40191123430](https://github.com/777genius/agent-teams-ai/actions/runs/40191123430),
including all four test shards, three lint shards, canonical validation and the
Windows task smoke. Its actual checked-out synthetic merge was
`a38a7153b83cb25c05c161d5c3306e82cfbaa294`; this receipt is not reassigned to a
subsequent merge ref or candidate.

Its [desktop run 40191123485](https://github.com/777genius/agent-teams-ai/actions/runs/40191123485)
passed installation, capability refusals and deduplication, native discovery,
copy/update/removal and the actual restart with grant revocation. It then timed
out waiting for the OpenCode menu option. The failure screenshot shows the
enabled, closed Claude selector and no renderer exceptions. The run did not
reach the new restore-choice or specific-warning assertions, nor its later native
MCP stage. Those assertions still need a successful complete current run.

The minimal reviewed follow-up has three parts:

- A confirmed external review finding showed that two provider contexts sharing
  one environment could overlap while activity validation awaited. An unpublished
  first lease could be overwritten, leaving an orphan launch fence. The gate now
  returns its lease synchronously; its owner publishes or extends that same lease
  before awaiting activity validation. Existing acceptance, uncertainty and fresh
  inspection rules still decide release. Closed-state checks after awaited
  authority/activity validation and inspection prevent late Apply or a recreated
  fence after shutdown. No mutex, queue, extra admission state or framework is
  introduced. Five new regressions failed before correction: overlapping applies,
  reconciliation during validation, shutdown during each of the two validations,
  and inspection returning after shutdown. All 37 application/gate tests pass
  after correction, including the refused-initial-reservation cleanup invariant.
- The desktop helper now acknowledges the runtime menu opening before looking
  for an option. It permits at most three opening attempts inside the original
  60-second deadline, retrying only the opening acknowledgement. Options are
  scoped to the trigger's controlled listbox and selection requires its exact
  displayed value. After an observed opening, a missing option, lost menu or
  failed selection is a failure. Apply and other mutations are never repeated.
  This strengthens the driver's observation contract without claiming a proven
  product root cause for the earlier closed-menu screenshot.
- Six existing strings across all 29 locales now identify the global badges as
  runtime-managed capabilities. They explain that Universal plugins and Managed
  skills expose availability in their own sections. The Plugins description
  includes both UAP and the runtime catalog. Existing capability logic, layout
  and roles remain unchanged; the confusing Anthropic-only/global-unsupported
  implication is removed.

Independent admission, navigation and localization reviews found no remaining
P1/P2 in these slices. The complete focused application/gate suites, scoped fast
lint, formatting and desktop TypeScript check passed. The source-size command
could not complete locally because Node's child-process invocation was denied;
it is not claimed as a pass. The local full-project typecheck reports the known
missing `fastmcp` dependency and its consequences, while canonical validation on
c910 passed in CI. New-head canonical qualification remains required.

Before publication, merge current main
`d79aa4159ecea311187c126dbceea153a0c7de26` into this candidate. Its seven-file
Windows OpenCode preflight/pin update has no runtime, SDK, admission or UI
overlap. The clean merge preserves both independently added desktop TypeScript
entries. The next candidate must qualify this combined tree, not the older base.

The UAP and SDK pins remain `8645eb5e71321f9321b8e742b8eda74408b55f13`.
[UAP Required 40190510820](https://github.com/777genius/universal-agent-plugins/actions/runs/40190510820)
passed all six jobs, including the main test lane, generated drift and the actual
packed SDK consumer. An independently built native binary has SHA-256
`6ad7f4732f6cd38e1ec90cb8292522c49b00dd3dae390a2044c85562cbf0fdb8`,
matching the desktop receipt. The unchanged standalone Python client installed
and verified exact Skill bytes and actual OpenCode discovery in 30.05 seconds;
the [exact-source receipt](https://github.com/777genius/universal-agent-plugins/pull/500#issuecomment-6397373865)
records source, executable, client and fixture identities. These app-only fixes
do not rebuild or repin that SDK or engine.

The c910 bootstrap matrix passed three targets, but Windows x64 exceeded its
480-second guard during work-directory cleanup after publication and receipt
validation had passed. The same runtime had passed the earlier matrix; no digest
or validation failure was reported. Keep this run failed and require the new
candidate's normal platform matrix. Do not increase its deadline or add retries
to turn this observation into a pass. Current desktop, Full qualification and
applicable packaging results are still required after publication. Formal
CodeQL disposition and the separately documented live-model/OAuth and S25/S26
project/Host prerequisites retain their existing boundaries.

## Previous checkpoint — v12 (2026-10-25)

The completed [desktop run 40189232897](https://github.com/777genius/agent-teams-ai/actions/runs/40189232897)
passed on head `42c412648cd513f4ca2d9656aaf5ceff71e2e323`, synthetic merge
`7349c4ded9d9662ae87015efbe72fedf6a63c241`, with UAP source 5224. The
[full receipt](https://github.com/777genius/agent-teams-ai/pull/989#issuecomment-6397195988)
contains 19 screenshots, zero renderer errors and actual OpenCode MCP
initialize/list/call with the exact nonce returned to the scripted provider.
After UI removal a fresh native process made zero MCP requests and offered no
tool. The previously failing stdin-EOF scenario is therefore now qualified for
those bytes. The same head passed all four test shards, all three lint shards,
canonical validate and the complete bootstrap platform matrix. Its Windows task
smoke and remaining package jobs were still pending at this checkpoint; it is
not presented as a completed Full qualification.

The independent screenshot review identified two P2 usability issues. The
following minimal changes resolve them using the existing panel and review flow:

- Same-name restore points now show the original action and a localized recorded
  time. Both the list and confirmation use a small shared renderer. Confirmation
  takes the selected point from Go's prepared plan, so refreshing the list cannot
  substitute another point. Existing old records show honest missing-data labels;
  full IDs and paths stay in Details. All 29 locale namespaces and generated types
include the labels. No new history subsystem or selection workflow is added.
- The updated Go engine projects specific, bounded security warning reasons into
  the existing warning area. Arbitrary scanner messages/paths are not exposed;
  unknown or unpublished details are identified explicitly. The actual source
  fixture must display `SEC302: configuration contains an insecure http:// endpoint`
  before Apply. Blocking security policy is unchanged.

The new matched source is
`8645eb5e71321f9321b8e742b8eda74408b55f13`, version
`0.1.91+agentteams.8645eb5e7132`. The SDK was rebuilt and packed from that clean
committed checkout; SHA-256
`02d921a6466a7eca86c8161e8d6de0a4ac9b7ee0ed1135de3f27d12bdfcbea0e`.
The package reference, lockfile and provenance name the same archive. The existing
staging path builds the native executable from the identical reviewed source.

Independent backend and frontend critics found no remaining P1/P2 in these
changes. Seventeen focused presentation tests, scoped production lint, formatting
and the changed extensions namespace checks passed. The newly packed SDK passes
the desktop E2E TypeScript check and all 26 existing facade tests. The local full
typecheck stopped at the already observed missing `fastmcp` dependency in the MCP
package; that incomplete local installation is not a passing canonical check.
Current UAP Required has already passed generated
contract drift, SDK protocol/lifecycle, actual packed-consumer and all four lint
jobs; its main test lane remains in progress. Final current-app canonical CI,
desktop and package receipts remain required after publication.

The strengthened real desktop journey now checks that both same-name save/delete
rows are visibly distinguishable after restart, selects by exact operation ID,
checks the same point/time in confirmation and restores exact bytes. It retains
both points and the selected point in its receipt. Prior 5224 receipts are not
reassigned to the new engine. Formal CodeQL disposition, live-model/OAuth
qualification and the separate S25/S26 project/Host prerequisites remain explicit
boundaries; no protection or scanner rule is bypassed.

## Previous checkpoint — v11 (2026-10-25)

The clean desktop run on app `501916f1532d0c2bd48eb4867a09228116009c5f`,
synthetic merge `3cbfb0b8237770a62ad40ac68d571f2da1c25584`, completed the existing
UI journey with no renderer errors: installation, binary copy, update/removal,
local edit/delete, actual restart, capability revocation, exact restore and signed
registry install/removal. Artifact `12597537321` retains those assertions and
screenshots. The new source plugin also installed through the ordinary UI and
security review, with the expected UAP-owned native MCP configuration.

The new native invocation then timed out before any MCP/provider request. The
pinned OpenCode 1.18.34 [run command](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/cli/cmd/run.ts)
reads non-TTY stdin to EOF before creating the session, even when a prompt is
supplied as an argument. Node's promisified execFile left that pipe open. The
helper now closes only its owned noninteractive child's stdin before awaiting
completion, matching the existing successful Go fixture's EOF behavior. The
90-second deadline and all native protocol assertions remain unchanged. Failure
logs now retain the error even when native stdout/stderr are empty. This is a
test-driver correction, with no production/runtime or provider configuration
change. The previous overall failed receipt remains failed; a new clean complete
run is required.

All four test shards, all three lint shards and canonical validation passed on
501916f. Its Windows task smoke and platform package matrix were still unfinished
at this checkpoint. The next head must satisfy its current gates; the live PR
records subsequent exact-revision results. UAP executable/SDK source remains
5224, independently requalified through the unchanged Python client and real
OpenCode native discovery in 27.03 seconds. Formal CodeQL disposition and the
separate project/Host prerequisites remain explicit outstanding boundaries.

## Previous checkpoint — v10 (2026-10-25)

This continuation builds on published app
`ed4d3e3f4c1c5a62bca1184b28b75b06433ba43b` and the same matched UAP source
`5224ebd5f66bbdfab0bef906dba0b089062f6073`. The engine and SDK pins are unchanged.

Independent review identified a source-entry mismatch: plugin revisions belong
inside the engine's source reference, but the form displayed a separate revision
field which Go did not consume. Plugins now show one source input, an optional
alias, and the supported `owner/repository@revision` syntax. Skills keep their
existing discovery revision field. The input boundary accepts bounded remote
references without duplicating Go's source parser; it still rejects obvious local
paths. Go remains authoritative for acquisition, supported syntax and refusal.
All 29 locale namespaces and generated types include the helper text. Thirty-five
focused tests passed, including regression cases that failed before correction;
two independent reviewers found no remaining substantial issue in this slice.

The desktop lane now adds an actual native MCP dispatch after the existing signed
registry journey. A disposable HTTPS archive contains a standard plugin manifest
and MCP definition. The ordinary UI review/apply flow installs it; UAP alone writes
the native MCP configuration. Real pinned OpenCode then runs against a scripted
loopback model transport. Assertions require initialize, tools/list, tools/call,
the exact nonce-bearing arguments and the returned tool result in the subsequent
provider request. UI removal is followed by a fresh native session that must
advertise no tool and make no MCP connection. This proves the actual native tool
transport, not model intelligence, provider authentication or OAuth. The small
fixture follows the already exercised UAP native protocol test and introduces no
production framework. Independent review and canonical desktop TypeScript passed;
the clean current-commit runtime receipt remains required.

The previous clean desktop run
[40187287946](https://github.com/777genius/agent-teams-ai/actions/runs/40187287946)
passed install, HTTP capability/refusal/deduplication, copy, update and removal,
then failed before local edit. Its screenshot shows the enabled editor, and the
stack identifies a harness race: the successful readiness observation was
discarded, then a second observation failed during the dialog transition. The
click helper now uses the successful point directly and waits for finite target
and ancestor animations. Pointer events, hit testing, exact-value assertions,
timeouts and single Apply submission remain intact. This correction was
independently reviewed; the failed receipt is not relabeled as a pass.

The same prior CI passed canonical validation and the test shard containing the
packaged MCP cleanup regression. Two export-order errors and a boundary-test
fixture which supplied an undefined HTTP header are corrected here. The missing
credential case now omits the header, allowing the actual server refusal to run.
Final Full qualification, actual Electron/native-tool evidence, applicable
packaging and formal CodeQL disposition remain required before merge.

## Previous checkpoint — v9 (2026-10-25)

Continuation starts from published app `52fcacc3cc69c6df8882ecbb7310abfb9c4b2c19`.
The new matched UAP source is `5224ebd5f66bbdfab0bef906dba0b089062f6073`, version
`0.1.91+agentteams.5224ebd5f66b`. The TypeScript SDK was rebuilt and packed from
that committed checkout. Its archive is byte-identical to the prior pack:
SHA-256 `31eb798b31be66d1c4d80d1cfa094934fa786cf2b46313360b4c6a8f6bfdd96c`.
The changed Go engine allows applying a retained plan when all 16 review slots
are occupied; both preparation paths retain their limit and all mutation gates.
Its red-before real-HTTP regression and complete transport package passed, and
independent review found no remaining substantial issue in that correction.

### HTTP authority correction

Every managed HTTP operation now requires a random sidecar capability in addition
to the existing peer, Host, Origin, JSON and body-size checks. Unauthenticated
`hostStatus` returns only a helpful unavailable response without invoking the
facade. The sidecar capability is distinct from the private Go credential.

Only the owned Electron main frame can request an authorized browser link through
a separate IPC operation; there is no HTTP grant endpoint. The existing Settings
Copy URL action supplies that link. The browser immediately removes its fragment,
keeps authority per tab and exact origin, and never sends it to another port or
host. Sidecar stop, restart and startup failure revoke the old capability.

Independent review found and corrected two additional cases: a fresh grant pasted
into an existing tab must refresh its cached client and unavailable panel; bug
reports must omit URL fragments even before API initialization. Six focused test
files passed 16 assertions, focused fast lint passed, and independent final review
reported no remaining P1/P2. Real HTTP and the extended Electron journey remain
current-commit CI gates. Local socket binding was sandbox-denied; the full local
typecheck also encountered missing `fastmcp` dependency types. Neither is counted
as a successful full qualification.

### Packaged process cleanup and inherited evidence

The packaged MCP smoke now keeps stdin open until ownership-verified shutdown has
settled, avoiding an EOF-triggered exit racing the process census. Its existing
actual-child regression now includes stdout/stderr on an exit-code mismatch.
The historic CI failure did not print that diagnostic, so its exact cause remains
unproved until the corrected current-commit test completes. Local syntax/diff
checks passed; the spawned test was blocked by the execution environment.

The clean [desktop CI run 40183926081](https://github.com/777genius/agent-teams-ai/actions/runs/40183926081)
completed the full journey with no renderer errors on synthetic merge
`1b00532a5db7be78a38824373d984c2ee23d7ded` (head `52fcacc3`, base `eb67de95`) and
BBC7. Artifact `12595184310` contains its receipt and 16 screenshots. Actual macOS
signing succeeded on both architectures in [package run 40183926123](https://github.com/777genius/agent-teams-ai/actions/runs/40183926123),
including jobs `121141121953` and `121141121920`. These named results preserve the
previous evidence; they do not qualify the new source pin or HTTP correction.

Current substantive Full qualification, clean Electron E2E, applicable packaging
and formal CodeQL disposition remain merge gates. Native project/worktree and
Host prerequisites remain separate. No public release is included.

## Previous checkpoint — v8 (2026-10-25)

The implementation is published in [PR #989](https://github.com/777genius/agent-teams-ai/pull/989),
with the Go contract and TypeScript SDK in [UAP PR #500](https://github.com/777genius/universal-agent-plugins/pull/500).
Historical v4–v7 sections retain their original evidence. Named test results are
tied to the revisions below; project/worktree prerequisites remain separate.
The preservation correction and this v8 plan are published together. Qualification
of that published revision is recorded in its current PR check runs and final
handoff; earlier results below do not replace those gates.

| Artifact | Reviewed identity |
| --- | --- |
| UAP runtime source | `bbc7e98da96dd7d77db42f65da7afae84a86f799` |
| Native version | `0.1.91+agentteams.bbc7e98da96d`, based on verified `agentplugins-v0.1.91` |
| Linux x64 native SHA-256 | `fcddfe935e8bfbdbe45b2131aa934240c0e2e2e236fb8c3c84c624a95b9c1b76` |
| Vendored SDK SHA-256 | `31eb798b31be66d1c4d80d1cfa094934fa786cf2b46313360b4c6a8f6bfdd96c`; rebuilt and packed from the same source |
| Actual native consumer | OpenCode `1.18.34`, executable SHA-256 `9ca0b9953d49997601655e54f846a3efa464f237e47c6f1b04716d0f2e64c4c2` |
| Orchestration runtime | `0.0.138`, provisioned by the ordinary locked bootstrap |
| App production checkpoint before the local-file correction | `e1798241e114fe6b530541e398491a8d14d1323d` |
| Correlated-operation desktop harness | `b1c5d7a8a8993c460395354d5ddcd7d253acc5df` |

### Reviewed behavior and integration corrections

- The browser HTTP client has a deliberately browser-safe public feature entrypoint.
  It cannot transitively import the managed panel, reused Skill dialogs or app store.
  Desktop composition loads after profile migration/bootstrap. The main/preload/
  renderer split and existing Team Provisioning authority are retained.
- Target capture obtains roots from the existing passive provider environment.
  Canonical-root errors still refuse capture. An unavailable native executable is
  recorded for that target without preventing an unrelated Claude/Codex launch.
  A failed explicit OpenCode probe does not silently select a different executable.
  Missing/corrupt UAP or durable pending work still prevents a conflicting launch.
- Terminal cancellation refreshes authoritative inventory. Old asynchronous polls
  and context A responses cannot overwrite a later capture B; observation retries
  observe the same operation without another Apply.
- Managed cards/reviews show alias, action, relevant version changes and labels from
  the captured session. Shared-graph actions identify every affected captured
  target. Raw identifiers, paths and ordinary readiness details are collapsible;
  warnings, unknown/abnormal states, conflicts and required confirmations stay visible.
  Installation success preserves exact public native follow-up instructions and
  never claims authentication or a restart that has not occurred.
- Local copy reuses the existing import/file-review dialog. Its explicitly supplied
  destination name survives initialization instead of being erased by the default
  name-suggestion effect. A regression reproduced the actual empty-destination
  failure before the two-line correction; all nine import-dialog cases then passed.
  The actual e179 desktop run copied text/binary bytes through Go successfully.
- The desktop HTTP route explicitly overrides the earlier broad CORS handler.
  Foreign origins receive the feature's refusal instead of an unrelated 500.
  The hostile-Host proof uses Node's real HTTP transport: Node 24 fetch rewrites
  that header and cannot establish a forged-Host request.
- Native SDK/protocol changes remain in Go: reserved future registry IDs do not
  borrow installed-release authority; physical aliases/mode drift are checked;
  Skills-only OpenCode actions do not fence unrelated MCP config selection; edited
  native content stays preserved; unaccepted expiry does not consume request IDs.

### Local editor preservation correction

Actual Electron verification exposed a pre-existing mismatch between the limited
editor draft and the planner's complete managed-directory replacement semantics.
An ordinary metadata edit submitted deletion of unrepresented reference files
and binary assets. The Go patch executor correctly carried out those explicit
deletions; the correction belongs in the app planner.

The planner now preserves supporting files outside the editor's represented
controls, including nested text and binary assets. The three generated starter
README drafts use validated `createOnly` intent: an existing custom text or binary
README stays unchanged, while a missing starter file can still be created.
Those skipped paths remain in the desired set and cannot accidentally become
omission deletions. Explicit text replacements/removals and import replacement
semantics are retained. This is an app draft field, not a new Go SDK/wire option.
Go still receives exact reviewed patches, observes the complete existing tree,
and owns mutation, expected-hash checks, backups and recovery.

Binary import deletions retain their expected SHA, are labeled binary, and are
not decoded as UTF-8 or described as a copy. The existing review UI and controls
are reused.

Red-before regressions reproduced omitted-file loss, scaffold overwrite and the
misleading binary-delete card. The final focused batch passed **38 tests in seven
files**, including the actual draft builder, request-marker validation/identity,
explicit replacement and rendered review distinctions. Focused production and
E2E TypeScript 7 checks passed using their canonical configurations. The size guard
and diff check passed. Fast lint reported zero errors and one unchanged
`DialogFooter` warning. A local typed-lint process exhausted its bounded 1.5 GiB
heap; it is not counted as a pass, and the current CI lint lanes remain required.

The harness now supplies the actual virtual key codes for Ctrl+A/Tab/Escape and
asserts the field's exact value after text input. Its Skills/Plugins navigation
checks `aria-selected` and the visible controlled panel, with at most three real
pointer attempts inside the existing 60-second navigation budget. Once selection
is observed it never re-clicks to hide a later state regression. This retry is
limited to idempotent tab navigation; Apply and native mutations are not retried.
Failure diagnostics retain requested/selected tab state, bounds and hit testing.

### Evidence and outstanding gates

[UAP Required 40176921783](https://github.com/777genius/universal-agent-plugins/actions/runs/40176921783)
and [Terminal UI 40176921781](https://github.com/777genius/universal-agent-plugins/actions/runs/40176921781)
passed on BBC7. All three local exact-artifact groups passed: signed official
registry install/remove; the unchanged packed SDK lifecycle; and the independent
unchanged Python protocol client. The SDK run actually observed `interrupted`
after a lost accepted reply and owned-process SIGKILL, then fresh recovery restored
exact native bytes without a duplicate dependency. Local create/edit/delete and
restart-visible undo passed. Python retained a prepared Skill through two catalog
discards before Apply and verified actual OpenCode discovery/bytes.

The verified signed feed contained 30 entries, 28 eligible. The reviewed
`cloudflare-docs 0.4.13-uap.1` lifecycle checked the exact native JSONC MCP object
and its removal. It did not invoke a hosted MCP tool or authenticate a model.
These receipts qualify BBC7, not unexecuted frontend paths.

[App CI 40180747963](https://github.com/777genius/agent-teams-ai/actions/runs/40180747963)
passed on source `e1798241e114fe6b530541e398491a8d14d1323d`:
[Full qualification](https://github.com/777genius/agent-teams-ai/actions/runs/40180747963/job/121132486698),
[canonical TS7/workspace validation](https://github.com/777genius/agent-teams-ai/actions/runs/40180747963/job/121131296750),
all four test shards, all three source lint lanes and the Windows ledger smoke.
The earlier 299 focused assertions belong to ede65; nine import-dialog cases
qualify e179's seeded-copy correction. An intentionally stopped local full
compiler is not counted as a pass. Subsequent changes require their applicable
current-head CI and separate Electron package qualification.

The clean b1c5 actual Electron run verified source preview/install, native Skill
visibility and exact files, keyboard preview navigation, 760px managed-panel
layout, same-state HTTP observation, foreign-Origin/rebound-Host refusals, real
HTTP create/delete/deduplication, exact binary local-copy preservation, targeted
update, and managed removal while the local copy remained. It then found a real
edit-plan defect: saving metadata removed existing files absent from the editor's
limited draft. The retained review screenshot showed the unintended deletions;
the binary was additionally mislabeled as text. This failed receipt remains
preserved as `app-b1c5d7a8-desktop/evidence.json`, not a completed S29 result.

The separate b1c5 [remote run 40182000578](https://github.com/777genius/agent-teams-ai/actions/runs/40182000578)
failed earlier, before the Skills panel mounted, with Plugins still selected.
Its retained artifact and screenshot do not reproduce the later local edit loss.
Layout movement between pointer sampling and dispatch remains a hypothesis; the
bounded tab postconditions above strengthen input verification without changing
production state or native assertions.

Pre-publication exploratory runs against a dirty checkout remain labeled as such.
They cannot qualify the subsequent published commit. Current-head Full
qualification, a clean completed desktop receipt, applicable package/signing
checks and formal security disposition remain required.

The harness correction at b1c5 captures the displayed operation ID before an
actual click and requires a different ID with a Completed status, so a previous
install cannot qualify a later copy/update/remove. It also waits for enabled,
visible, stable hit targets and finite dialog animations. It changes no native
assertion, result state, timeout, or production UI.

All 18 annotations at the named BBC7/ede65 checkpoints received independent
source/dataflow review (15 UAP, three App), with no demonstrated exploitable vulnerability under the
documented local-desktop authority model. The
[security disposition](https://github.com/777genius/universal-agent-plugins/blob/feat/management-sdk-20261024/docs/plans/management-sdk-security-review.md)
records each guard and limitation. Analysis jobs succeeded, but the aggregate
checks still report failure; source review does not itself clear that status.
No scanner rule, cache authority, security setting or branch protection was
weakened. At b1c5, the aggregate App check reports two annotations (the controlled wait
expression and the unchanged workflow pin). The historical three-finding audit
is retained; a new result is not silently treated as the old count. Formal
repository disposition remains a separate gate.

### Scope and measured maintenance cost

At v8, native project/worktree S25/S26 were blocked by draft UAP #472/#475/#480
and Agent Teams Host #982. CLI project support has since landed; v16 records
the still-missing Management/provisioning boundary. No draft adapter code is imported.
Project local Skill authoring does not prove native project activation.
The standalone HTTP viewer remains unavailable for managed mutations; desktop
sidecar parity is the qualified host boundary. Captures are bounded to 16 per host
lifetime with explicit restart guidance; no safe context eviction is claimed.

At the named published checkpoints, BBC7 against UAP main `a6beceba` adds 6,027
handwritten runtime/build lines and removes 331; app e179 against main
`eb67de95877d96567c79ea90b93b6db780b849b2` adds 4,072 and removes 182, for 10,099
combined added lines. The frozen correction reviewed for v8 adds 37 and removes
11 relative to e179. Its app diff against the same main is 57 handwritten
runtime/build files, 4,109 added lines and 193 removed. Combined with unchanged
BBC7, the frozen v8 review therefore measures 10,136 added, 524 removed and 9,612
net added lines.

These measurements exclude generated transport types, tests/E2E, localization,
schemas/config and documentation. The original 3,500–6,500 estimate was low:
durable acceptance/recovery authority, Go-only reversible local authoring and
shared runtime admission account for the expansion. The handwritten TypeScript
client/Node helper/export surface is 339 lines. No daemon, second installer,
database, custom RPC framework, new frontend framework or unused language SDK
was added.

Hot mutable qualification state belongs outside synchronized working folders.
Unchanged BBC7 runs in synced scratch encountered externally reappearing files;
filesystem tracing preserved that failure evidence. The same SDK and Python
scenarios passed with isolated temporary state, without changing native ownership,
publication or recovery assertions. Follow the desktop procedure for isolated
HOME/profile/state paths and retain completed receipts separately.

## Product outcome

Manage universal plugins and standalone Skills from the existing Extensions UI:
discover, install, inspect, update one/selected/all, restore locked dependencies,
repair, remove, and recover interrupted work. The Go UAP engine remains the sole
owner of resolution, installation policy, native effects, receipts, and recovery.
The reusable TypeScript SDK talks to its versioned HTTP/OpenAPI contract.

Keep the familiar Plugins / MCP / Skills / API Keys tabs and the pinned project
context. Preserve native Claude marketplace installations and local Skills
authoring. UAP identity is not name@marketplace and must not be forced into
EnrichedPlugin. Distinct native and managed items never merge by display name.

The previous docs/extensions/plugin-kit-ai-integration-plan.md is a historical
draft: retain its useful product context while this plan supersedes its old
engine/CLI assumptions. Accepted native identity and separate Skills-domain ADRs
remain valid. Add a narrow ADR for managed remote Skills, now explicitly requested
by the owner, without rewriting the local authoring model.

## Implementation boundaries

Use src/features/extension-management with only necessary layers:

- contracts: browser-safe requests/results and IPC/HTTP names.
- core/application: captured environment context and narrow UAP management port.
- main/adapters/output: TypeScript SDK adapter; no second solver or installer.
- main/infrastructure: resolve exact staged UAP executable; process ownership is
  delegated to the SDK Node helper.
- main/adapters/input: IPC and HTTP route adapters calling the same facade.
- main/composition: resolve canonical project/profile/runtime/root identity.
- preload: typed bridge.
- renderer/hooks: context-keyed query, preparation, accepted operation observation.
- renderer/ui and view-models: presentational managed cards, detail/action/result
  views using shared Radix controls and existing Markdown/diff presentation.

Do not create empty layers, grow frozen oversized extensionsSlice/SkillsPanel,
or put mutation policy in React/Zustand. Keep app-shell integration through public
feature entrypoints. Native MCP/API-key flows are outside the rewrite scope.

HTTP parity is required by the feature architecture standard. Browser code uses
the app backend, which owns UAP. Neither browser nor Electron renderer receives
the loopback capability token or arbitrary filesystem/process authority.

## Captured context

The trusted host captures project identity/root, actual agent runtime, profile and
configuration revision, supported target/scope, native executable/profile roots,
and UAP environment identity. UI supplies selection identifiers and intent.

An operation accepted in context A remains bound to A when the user opens B.
Late responses cannot overwrite B's state. Changed profile/root/config invalidates
an unapplied plan. An LLM vendor/model is not an agent installation adapter.

Agent Teams Host migration #982 was open draft at baseline
70546fe36766e632940300f51b2a8ba764db6fe9. Build against main through a focused context
port. Recheck before merge; if that migration lands, bind UAP below its captured
management ownership instead of adding a bypassing writer. Do not cherry-pick the
entire draft or create a parallel general management journal.

## UX rules

Reuse ExtensionStoreView, SearchInput, shared Button/Badge/Dialog/Select/Tooltip,
Markdown and diff components. Add a UAP-specific view model and behavior rather
than copying Claude-specific card assumptions.

Normal path: search/select -> see scope/runtime/compatibility -> Install -> actual
phase/result. Prepare while showing details. Review meaningful dependency,
permission or target changes; avoid a mandatory multi-step wizard for every install.
Unsupported actions explain the engine's actual reason.

Installed and ready are distinct. Show manual activation/authentication,
partial/incomplete targets, and recovery actions truthfully. Refresh from
authoritative UAP state after operation completion. Store no success solely because
HTTP returned 202. Retry a lost response using the original accepted request ID.

Updates and restore live with installed items. Update selected/all delegates one
candidate environment to Go; it is not a UI loop. Exact pins and unavailable checks
remain explicit. Put paths/digests/receipts in optional diagnostics.

## Managed Skills ownership

SkillsMutationService routes local edit, import-overwrite and delete requests
through authoritative backend ownership checks and retained Go mutations.
Hiding UI controls alone is not protection.

Managed update/remove/repair goes through UAP. Offer explicit editable copy into a
new unowned local destination. Preserve local Skills editing/import/delete for
unowned files. Test both successful local edits and rejected backend bypasses.

## Project/worktree boundary

CLI project installation has landed through UAP #472/#499. The Management API and
desktop provisioning integration still require their own project qualification.
Advertise only capabilities actually implemented by the pinned qualified engine.
Never silently map local/project to user.

A source-project dependency manifest is not automatically materialized in an agent
worktree. A focused environment preparation port must restore exact locked
dependencies into the actual execution cwd before a new run. Do not copy .uap state
directories. Shared native profile files can be re-read by active agents. V1 refuses/defer
mutations affecting an active captured profile/project before effects, using a
focused runtime-activity port. Unaffected profiles remain usable. A next-launch
label alone is not isolation; no new per-run snapshot framework is introduced.

Project/worktree success cannot be claimed until prerequisite project support and
registry policy are qualified. Unsupported capability is a first-class tested UI
state, not a hidden fallback.

## Acceptance and evidence

| Area | Acceptance |
| --- | --- |
| Catalog/install | Real SDK -> real Go binary -> actual manifest/lock/native config/files -> UI state |
| Standalone Skills | Real source acquisition/pin, native projection and managed ownership |
| Local Skills | Existing editor remains functional for unowned files |
| Ownership | Backend refuses managed edit/import/delete; editable copy is separate |
| Update one/selected/all | Shared Go candidate graph, saved dependencies included, per-item outcomes |
| Locked restore/repair/remove | Exact pins and owned bindings; sibling profiles preserved |
| Context changes | A remains A; stale authority rejected; no arbitrary renderer paths |
| Interrupted/retried operation | Same accepted request, no duplicate effects, truthful recovery after restart |
| Cancellation | Waiting abort differs from mutation cancel; effects never called rolled back falsely |
| Missing runtime/auth/policy | Useful next action/reason; no false ready state |
| Native external items | Preserved identity and existing native behavior |
| HTTP and IPC | Same facade and equivalent validation/result semantics |
| Project/worktree | Qualified scope/root, exact execution-cwd materialization |
| Active run | Affected shared-profile mutation refused before effects; unrelated profile permitted |
| Package | Exact SDK/UAP artifact identity; no dev-only path or implicit latest |
| Electron UX | Actual clicks/screenshots, no renderer errors, compact normal install flow |

The UAP v6 master owns the complete S01–S30 acceptance and evidence matrix.
This app plan records host implementation and checkpoint evidence for that matrix;
it does not redefine scope or mark every scenario complete. Before completion,
record each as implemented/verified/dependency-blocked with concrete evidence.

## Original implementation sequence (historical)

This sequence records the order agreed at v1. The foundation implementation steps
have been completed through the checkpoints below. Step 6 remains dependency-blocked
for S25/S26. Current-artifact desktop verification, applicable current-head
qualification and final review remain delivery gates; do not restart the historical
v1/v2 publication steps.

1. Publish this v1 plan and draft PR. Independently review master plan and frontend
   decisions; fix findings and immediately publish v2.
2. Complete UAP/TS SDK vertical install/retry/restart lifecycle before app binding.
3. Add exact binary/package staging, captured-context facade, IPC/preload/HTTP.
4. Add backend Skill ownership guard and explicit editable-copy flow.
5. Reuse frontend shell and primitives for managed Plugins and Skills, including
   update/restore/repair/remove, partial outcomes and recovery.
6. Wire qualified project/worktree preparation through focused provisioning port.
7. Run actual Electron UI lifecycle and native discovery qualification.
8. Independent final review; fix issues; run relevant checks and current-commit
   Full qualification; merge only with all applicable gates clear.

Every commit is pushed immediately. Plans, critic findings and results are stored
in these PRs. Do not mark an unexecuted test as passed.

## Electron verification

Use pnpm dev:mcp and the existing scripts/e2e/comment-notification/cdp.mjs client.
Follow group-chats-desktop.ts for process-owned debug-port discovery, test-only
HOME/XDG/userData/project fixtures, mouse/keyboard interaction, screenshots and
console errors. Its synthetic runtime history is not installation proof.

The new harness must call the actual SDK and Go executable. Fixtures may provide
controlled package sources/releases, never fabricate install outcomes or prewrite
the state under assertion. Verify native files and small native-agent discovery/
tool handshake. Restart the actual UAP process/app for recovery scenarios.

Add a focused UAP desktop E2E workflow or lane; existing packaged path filters do
not automatically exercise ordinary Extensions changes. Reuse Xvfb/Linux support
and existing packaged matrix, capturing app SHA, UAP SHA/digest, SDK identity,
scenario results, sanitized logs, and screenshots.

Never test real user projects, open native folder pickers, or substitute browser
dev for desktop E2E. Stop only processes created by this harness.

## Resolved integration decisions from v1 critics

### Exact package and runtime delivery

Vendor the SDK .tgz built from an exact reviewed UAP source SHA, with package
identity and SHA-256, using the existing vendor/terminal-platform/sdk precedent.
Build native UAP during app build/CI from the same source pin using UAP's declared
Go toolchain and read-only module resolution. Stage it into packaged resources.
Include license/third-party notices and record both identities in test evidence.

No end-user Go compilation, implicit latest download, unpublished npm dependency,
sibling-workspace requirement or expiring artifact URL. Clean-checkout build and
packed SDK consumer are acceptance gates. A public release remains a separate
authorization; source build is the concrete delivery path for this change.

### HTTP authority

Current HttpServer CORS behavior is insufficient authority for native management.
New feature routes require exact trusted Host/Origin and loopback client, bounded
JSON mutation bodies, and the same captured context validation as IPC. Untrusted
Origin/Host, CORS='*', and non-loopback callers must be refused before invoking the
facade unless an existing authenticated trusted deployment adapter supplies
authority. Keep this feature-local; do not start a global authentication rewrite.

HTTP parity covers new management endpoints only. Existing legacy native store web
limitations are not silently added to this task.

The desktop sidecar additionally requires its own ephemeral bearer capability.
It is issued through owned-window IPC and the existing Copy URL action, never an
HTTP endpoint or public status response. The browser consumes and removes the
grant fragment, retains it per tab and exact origin, and sends it only to managed
routes. Restart revokes earlier grants. A bare browser URL remains a viewer with
an explicit management-access explanation. Forged local headers alone grant no
authority. This does not isolate a compromised owned renderer or stolen bearer;
remote/multiuser deployment still requires its own authenticated deployment model.
The Go child's separate private credential stays in trusted main composition and
is never returned to the renderer or browser.

### Context, lifecycle and readiness

A UAP session binds an immutable capture of native profile roots and executables.
Production omits state/dependency root overrides so Go selects the canonical UAP
CLI home and shared ownership locks. Capture one current profile for each supported
client in one engine session; runtime selection narrows installation/removal
targets. A profile change requires a fresh capture. Bindings outside that capture
are not silently reassigned or presented as active in the replacement profile.

Accepted request lookup precedes expired plan lookup, including combined lost
response and process restart. SDK waiting cancellation never kills the engine.
Only the host's explicit close controls its own child; graceful shutdown is bounded
and interruption remains recoverable. Navigation does not dispose accepted work.

Active shared-profile mutation refusal is required for install, update, repair,
restore and remove. Check again immediately before applying; frontend disabling
alone is insufficient. Test an affected running context and an unaffected profile.

Do not flatten materialization/activation/authentication/verification to one
installed boolean. A completed HTTP operation may still require a manual action.
Unknown future outcomes are conservative, never success.

### Prerequisites and completion

Independent foundation/API work can merge when its own supported capabilities
qualify. Full project/worktree integration cannot be called complete until the
separate qualified project engine passes S25/S26. Disabled project actions are
correct fallback evidence, not successful project-installation evidence.

## Required checks and constraints

Follow AGENTS.md, CLAUDE.md, AGENT_CRITICAL_GUARDRAILS.md,
docs/FEATURE_ARCHITECTURE_STANDARD.md, src/features/CLAUDE.md, and
docs/GIT_DELIVERY_POLICY.md.

Use pnpm and pinned TypeScript 7 through pnpm typecheck. New scripts are .ts.
New production files stay <=800 physical lines; frozen legacy caps do not grow.
No broad lint:fix, no facade inheritance, no generic whole-service host casts.

Required final evidence: focused feature and transport tests, typecheck, full lint
for this cross-process change, build, source-size/architecture guards, actual
Electron E2E, independent technical review, required CI including Full qualification
for the current commit. Do not modify protections, bypass checks, or force push.

## Review log

v1: incorporates repository/source research and initial critic discoveries:
HTTP parity, distinct native identity, backend Skill ownership, frozen file caps,
project/worktree prerequisites, Host migration context, and real desktop evidence.
Independent review of this written plan is pending.

### v2 critic dispositions

- Replaced unenforceable active-run freeze wording with backend affected-profile
  mutation refusal/defer and explicit unaffected-profile behavior.
- Added strict feature-local HTTP admission; broad CORS is not authorization.
- Chose same-source vendored SDK/native build before host implementation.
- Limited HTTP parity to this feature; preserved existing native/local domains.
- Incorporated immutable profile context, durable retry ordering, host lifetime,
  readiness axes, and honest project/worktree completion gates from UAP review.

Implementation and final UX reviews remain separate gates.

### v3 final UX review dispositions

F1/F2/F4/F5 were incorporated in v2. The remaining required findings are resolved
as explicit implementation and qualification requirements:

- F3 ownership is managed/proven-unmanaged/unknown. Engine unavailability never
  means unowned. Resolve canonical physical destination identity, reject symlink/
  alias bypass, revalidate at apply, and coordinate app-managed mutations. Inspect
  current UAP projection/lock invariants before claiming protection from concurrent
  external CLI install; add only the narrow necessary shared reservation seam.
  A general remote filesystem-lock service is not the default. Copies use a distinct
  proven-unmanaged destination and normal import/review validation.
- F6 add Install from source in Plugins for advertised source forms. In Skills,
  source URL -> candidate list/preview -> scope/runtime -> install. Preserve local
  authoring/import. Reuse a small source dialog; explicit unsupported/private-auth
  limitations come from capability data. No arbitrary process/path/CLI forms.
- F7 test keyboard-only selection, detail, install/action and dismissal, plus a
  narrow Electron window with usable actions/scope/errors/recovery. Assert focus
  and accessible labels and inspect screenshots with existing CDP.
- F1 effect-boundary guard coordinates launch/mutation ownership so a new run cannot
  start between two activity checks; no unsupported active-run freezing promise.

Required ownership tests include engine unavailable, canonical alias/symlink,
same-destination install during edit, import overwrite, direct backend delete, and
successful explicit copy. Required desktop tests include supported direct-source
candidate selection, affected active run refusal and unrelated profile success.

Plan direction is ready for implementation. These gates remain mandatory in code
review and cannot be represented by UI-only disabling or synthetic install results.

### v4 implementation review and authority corrections

This revision follows UAP plan v4 at
`b16f5396e72ad91e1cdc5e628ba3e364dae77b75`.

- **Shared CLI ownership:** normal startup omits state and dependency roots. Go
  resolves `AGENTPLUGINS_HOME` or the platform configuration directory. An
  app-private store cannot authorize writes over projections owned by the default
  CLI. Explicit isolated roots remain available for tests and registered embedder
  environments; they do not prove custody across arbitrary foreign stores.
- **Environment versus capture:** durable work belongs to stable engine-derived
  `environmentId`. Each plan and operation also retains its immutable `contextId`
  and dependency root. Changing executable or display labels must not hide pending
  work; recovery cannot settle an old environment by inspecting a replacement.
- **One captured native environment:** capture Claude, Codex and OpenCode profiles
  once and reuse the owned connection as the selected runtime changes. Installs
  and removals name their target IDs. An update of an existing alias may affect
  all its bindings; Update environment and Restore locked cover the shared
  manifest. The reviewed plan, not the currently visible tab, identifies effects.
- **Admission:** retained plan targets select the affected native roots and active
  clients. Unknown/recovery scope stays conservative. Existing runtime metadata
  lacks complete original profile roots, so a different already-running profile
  of the same client may remain blocked until stronger runtime authority exists;
  this limitation must not be described as verified unaffected-profile support.
  Launch and mutation share one admission gate at the existing runtime boundary.
- **Local Skills:** create/edit/import/delete/copy/restore use Go retained local
  plans, exact old-file digests and whole-directory snapshot checks under the
  canonical installer locks. Reuse `dirswap.Manager` and its recovery authority;
  do not add a generic lease or a Node check-then-write path. Project local Skills
  authoring does not imply native project plugin activation.
- **Reversible deletion UX:** engine-owned backups stay outside native discovery.
  A successful deletion must remain discoverable and restorable after the panel
  and app restart. Use bounded restore-point metadata from the existing durable
  ledger, or an already supported history surface. Do not introduce a parallel
  app receipt database merely to remember completed deletes. Generic native
  recovery cannot settle a local file operation; restoration names its exact
  original operation/root/name and receives a fresh review.
- **Acceptance uncertainty:** main retains request ID and plan across lost replies
  and exposes that retry handle when the panel remounts. Empty observation is not
  proof of no acceptance. Only the exact observed operation, or a definitive
  pre-effect refusal after durable replay lookup (for example `PLAN_STALE`), can
  resolve uncertainty. Review dismissal discards only unaccepted plans; it never
  cancels accepted work. Mutated cancellation and unresolved outcomes remain held.
- **Update wording:** preserve the engine's existing minimum-compatible range
  policy. Explain ranges and pins briefly; never claim that Update selects the
  greatest published version. Always display actual proposed version changes.
- **Packaging:** exact vendored SDK and native executable derive from the same
  reviewed source commit. Build uses UAP's declared Go toolchain and read-only
  module resolution. Include notices and record digests. macOS/Windows signing
  changes executable bytes, so verify the final signed-artifact integrity design
  rather than assuming a pre-sign checksum remains valid.
- **HTTP authority:** the desktop sidecar uses the same facade and actual socket
  peer, exact Host/Origin, JSON and request limits. A standalone host requires a
  concrete runtime-activity authority; an invented empty activity list is not
  parity. Resolve or explicitly capability-gate that host before qualification.

Independent v4 review found no reason to add a daemon, second transport, generic
file lease, parallel installer or new frontend framework. The mandatory remaining
UX items are restore-point discoverability and truthful range-update wording.

Local evidence recorded at the historical v4 checkpoint was limited to the focused app contracts/application/
IPC/HTTP/preload typecheck, 20 focused behavioral tests and the source-size guard.
The complete repository TypeScript check exceeded the workspace's memory limit;
it is not recorded as passed. Renderer/integration typechecks, full lint/build,
actual Electron clicking, native discovery, signed packaging, full CI and final
independent review remain open. The managed/local Skill adapter is still being
integrated. Project/worktree S25/S26 remain blocked on the separately qualified
engine workstream; a disabled control is only fallback evidence.

### v5 host scope and recovery review

- The standalone HTTP process is an existing read-only session viewer without a
  team runtime owner. It will advertise that managed mutations are unavailable
  and direct the user to the desktop app. Building a second runtime ownership
  subsystem solely for this integration would exceed this feature's scope. HTTP
  parity is required and tested on the desktop sidecar, which owns the same
  admission gate as Electron IPC. Standalone refusal is a separate acceptance
  test; it is not reported as successful standalone mutation support.
- A staged, pinned UAP executable is a required desktop dependency in development
  and packaged builds. Missing or corrupt engine resources produce an actionable
  error. An empty, valid environment must preserve existing team launch behavior;
  engine failure cannot be treated as proof that no pending mutation exists.
- Admission lives once per stable environment, across immutable captures. An
  observed pending operation can widen the held resource set atomically, and a
  new capture of the same environment can review recovery without conflicting
  with its own earlier fence. Tests cover both transitions.
- Every unresolved partial result, and failed or cancelled work with recorded
  mutations, has a visible recovery action even when the engine's next-action
  list is empty. Local work selects the exact local restoration request; native
  plugin recovery is never substituted for it.
- Target availability and action support are separate checks. Source and catalog
  install controls require both, with the native target's reason shown nearby.
  Transitive dependencies remain visible but cannot be updated or removed as
  independently declared roots. No dependency graph editor is introduced.
- Local restore points survive restart in the engine ledger. The UI explains
  retention of at least 30 days and shows up to the latest 100 restore points.
  Restoration always revalidates ownership and current files in a fresh plan.

The v5 working-tree admission/application suite reported 22 passing tests, after
the 20-test v4 checkpoint above. This is historical local evidence, not a result
for the current head; later checkpoints supersede these counts. Full CI,
actual Electron UX, local authoring integration, and signed package qualification
remain required; this revision does not change the project/worktree dependency.

### v6 independent code review and desktop qualification

The implementation review requires these corrections in the existing feature:

- Prevent stale empty environment responses from releasing a newer mutation
  admission fence. Carry one shared admission generation across captured contexts,
  including recovery admission. Deferred-response regressions passed 23/23 in the
  focused application suite; final current-commit qualification remains required.
- Carry `skills.discard` through the SDK adapter, shared facade, IPC and HTTP.
  Release catalogs on replacement and dialog close/unmount. A reviewed prepared
  plan owns its snapshot independently; no additional cache service is needed.
- Release cached local deletion reviews after definitive pre-effect refusal or a
  conclusively settled no-effect terminal result. Preserve exact request identity
  for uncertain acceptance, running work and unresolved effects. A later explicit
  Delete must be able to obtain a fresh plan without restarting the application.
- Present the Go review's `EXTERNAL_UNINSTALL_REQUIRED` conflicts with their exact
  bindings. Offer explicit confirmation only after the user has completed the
  native uninstall, or confirms the plugin was never activated, then request a new
  review with `externalUninstalled: true`. Never infer confirmation from a client
  name or save it as a preference. Applicability follows actual prepared removals,
  including transitive removals during update/sync and full native convergence.
  Receipt-only recovery and unrelated graphs refuse this flag. Review warnings
  identify the exact attested bindings. No pending-operation gate is bypassed.

Desktop inspection also identified practical UX corrections:

- Loading an unavailable remote catalog must not keep installed-state actions
  globally busy. Inspect the environment independently and report catalog freshness
  separately; real Electron already verified the source flow remains usable.
- Escape/close from a Skill preview must return to the source selection without
  also dismissing that selection. Render one active dialog surface and wait for
  its actual focus transition in the keyboard/click harness.
- Reuse existing frontmatter-aware Skill presentation so YAML metadata does not
  appear as a large Markdown heading. Keep optional update-policy detail close to
  its applicable action/review; an empty list should not show several paragraphs
  of update instructions. Keep the visible scope and capability reason.

Packaging uses the exact vendored SDK/native pin. Preserve the existing afterPack
hook by delegation. On macOS use the existing osx-sign traversal and options:
refresh runtime.json after nested binary signing and before the outer app seal.
Reuse the builder's bounded retry helper. afterSign only verifies. On Windows,
refresh after the existing signed extra-resource copy, before installer sealing.
The independent transport reviewer found no production lifecycle issue in this
wiring. Focused tests cover changed bytes, path confinement, partial-sign retry
and post-seal tampering. A macOS CI test performs real ad-hoc signing of an unsigned
native fixture, verifies the sealed bundle and executes the helper; release
certificate/notarization qualification is a separate existing release concern.

Evidence at this checkpoint:

- a213b80e8a4a97b613ffbe35df9f42f4ed7b090e passed remote Fast feedback, including
  the full pinned TypeScript check. This supersedes the earlier local memory-limit
  observation; it does not substitute for Full qualification on the final commit.
- The earlier integration slice passed 148 focused tests in 27 files, feature
  typechecks and unchanged source-size guards before publication.
- Actual matching 08a SDK/native local authoring tests verified create, binary/text
  editing, stale-byte rejection, delete, process restart, visible undo and restore.
- Real dev:mcp Electron reached Extensions, selected OpenCode, acquired the HTTPS
  Skill and displayed its content. The complete install/remove/reopen and final UX
  flow is still in progress; screenshots of early steps are not a completed E2E.
- Add the reproducible focused desktop CI lane using existing CDP, Xvfb and pinned
  runtime provisioning. Final evidence must name app SHA, UAP source/digest, SDK
  identity and exact verified scenarios.
- #472/#475/#480 and Host migration #982 remain open drafts at their previously
  recorded heads. Native project/worktree S25/S26 remain dependency-blocked.

Resolve and independently rereview the corrections, publish the refreshed matched
SDK/native pin, complete Electron clicking and native artifact checks, then run
current-commit Full qualification and applicable package checks before merge.

### v7 candidate artifact and additional review dispositions (historical)

This is the recorded v7 checkpoint, including its then-current artifact and failed
qualification attempts. The v8 checkpoint above supersedes those pins and current
status; historical evidence is not silently relabeled as a later pass.

The independently reviewed Go follow-up is published at
`aff370c0de25598ad8a1eee9436419cb7e35c348`. It applies each already supported
adapter's own removal predicate with the actual command runner. Grok, Qoder,
Copilot, Cline, Kiro and Windsurf now participate in the same review policy as
Codex. This does not expand the management capability set. Shared Copilot runtime
behavior and the frozen VS Code implementation remain unchanged.

Actual macOS/Windows CI exposed a raw-versus-physical state-root comparison. The
engine now normalizes both sides with the same helper; a different physical root
is still refused. All management integration cases and saved Git/portable restore
passed locally with TMPDIR deliberately reached through a symlink (37.648s).
Adapter predicate equivalence and Codex profile tests also passed. Corrected
macOS/Windows CI remains a separate gate.

Signed registry inspection found that an embedded `0.1.0-development` version
made all 30 entries in verified snapshot 42 ineligible. The native build now uses
`0.1.91+agentteams.aff370c0de25`, based on the independently verified immutable
`agentplugins-v0.1.91` tag at
`4555aa53844ee0078e9036cd82638afd67f77c16`. Build metadata identifies the exact
source while compatibility uses the verified release baseline. The stager,
runtime cache, packaged checks and startup all compare this version. No latest
release lookup or compatibility-policy bypass is introduced.

The current candidate Linux x64 stage uses the published source above and has SHA-256
`3e65916af4955f3061489a236a3907e178a658e6d5881ce1ab46b7526adef803`.
The SDK archive has SHA-256
`31eb798b31be66d1c4d80d1cfa094934fa786cf2b46313360b4c6a8f6bfdd96c`;
its bytes are unchanged from the preceding SDK because the follow-up changed Go
behavior only. Provenance still names the common exact source commit. Actual
SDK/native, second-language and Electron qualification must all use these matched
inputs; a successful stage alone is not a completed lifecycle test. A subsequent
behavioral correction must refresh the source pin before final qualification.

Additional GitHub review findings are resolved in the existing implementation:

- Extend an existing mutation lease to all resources of the newly reviewed
  recovery plan before awaiting the activity check. A launch already preparing on
  any of those resources rejects the extension atomically; no partial fence is
  added on refusal.
- Admission uses the effective launch request's provider and working directory,
  with per-field fallback to saved metadata. Explicit member providers and project
  directories remain included. Unknown rosters retain conservative admission.
- A transient operation-observation failure schedules another observation of the
  same operation. It never repeats Apply. Successful observation clears only the
  still-displayed error from that polling failure.
- Canonicalize the temporary copy-source test root for macOS path aliases without
  weakening production confinement.
- Preserve definitive-refusal deletion cleanup. Do not adopt blanket expiry or
  terminal-error eviction that would discard uncertain accepted request identity.
- Keep the required staged-engine contract. Engine absence cannot prove that the
  durable environment has no pending mutation, so it cannot authorize launch.

The independent follow-up reviewer found no P0/P1/P2 in these source changes and
agreed with the explicit trusted-local HTTP boundary above. The five focused
regression files passed 31 tests; focused core and harness TypeScript, narrow lint,
diff validation and the unchanged source-size guard passed before publication.
Final current-commit CI remains distinct from these local checks and static review.

Actual macOS ad-hoc signing passed on app checkpoint
`d7ebfb0ebe026d7bf115bdda8323b5b28b7eb629`, in
[job 121009065668](https://github.com/777genius/agent-teams-ai/actions/runs/40139661115/job/121009065668).
That checkpoint also passed packaged macOS ARM64, Linux x64 and Windows x64 smoke.
These are historical package results; the final app head must qualify again.
No release certificate, notarization or public release is claimed from this test.

The first focused Electron CI run on `1c0857f` built the matched native runtime and
provisioned real OpenCode and orchestration runtimes, but exited before opening
Electron: pnpm attempted a second install after the harness changed HOME. The
harness now uses dependencies already verified by the frozen installation step,
preserves that setting for child commands and includes a bounded startup-log tail
on failure. An actual nested pnpm command under a fresh isolated HOME verified
that no implicit install occurs. Dependency integrity is unchanged. The complete
actual UI receipt remains required.

Main was merged through a normal three-way merge at
`b0a700e927a4b85540c7aa4f3e8c8f85ef141326`, incorporating upstream
`bb6430b78df3698a53f6c97a33dce0e203fc674d`. The final app run must therefore use the
reviewed runtime 0.0.137 and current OpenCode override/provider-status behavior.
The two overlapping files merged without conflict; feature edits and upstream
changes are both retained.

Actual candidate testing has already identified two further qualification issues:

- Real OpenCode discovery, exact Skill/portable-command bytes, pinned update and
  ordinary repair passed. Repair of an edited owned Skill preserved those bytes
  and reported partial, but omitted the required typed changed-content diagnostic.
  The full recovery smoke stopped at that assertion; it is not a passing receipt.
- The signed official registry now reports 30 entries, 28 eligible, and the reviewed
  cloudflare-docs version is available for OpenCode. Management preparation still
  returned a refusal while an actual CLI dry-run on the same candidate succeeded.
  Catalog compatibility is verified, but registry installation S02 is not yet
  qualified.

Resolve both concrete findings in Go, independently review the corrections, then
refresh the matched source pin and repeat the affected actual-artifact scenarios.
Do not weaken assertions or count successful discovery as successful installation.

Published checkpoint measurements before the final small app follow-up are 5,932
added handwritten runtime/build-tool lines in UAP and 3,919 in Agent Teams, with
330 and 180 removed respectively. Generated transport types, tests, localization,
schemas and documentation are counted separately. The original 3,500–6,500-line
planning range was low: retained operation/recovery authority and the requirement
to route reversible local authoring through Go account for the expansion. The
handwritten TS SDK runtime remains 339 lines. Independent maintainability review
found no need for a daemon, second installer, framework or unused language SDKs;
the final evidence report will record final measured counts and scenario status.


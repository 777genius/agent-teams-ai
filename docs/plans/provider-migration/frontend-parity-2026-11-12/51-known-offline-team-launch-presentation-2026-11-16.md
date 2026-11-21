# Plan 51 — Hide ready launch presentation for a known offline Team

## Selection and base

This bounded continuation selects four existing source/test/closure paths on `6b1d34a8219e7909d0ad834f72d6bfb8f08e8031`. It resolves the visible ready/offline contradiction recorded by the original Codex Desktop journey. The implementation candidate is inert: no repository changes, project execution, compiler, lint, tests, native providers or new CI actions have been performed for this cut. Publish this document alone through the ordinary reviewed branch path, complete its full readback R2, and then publish the separately reviewed source child. Root owns those Git/ref actions; measured qualification remains with the original gates.

This documentary rebind preserves incoming Plan50 `50-v2-management-view-stages`; the unchanged source manifest records the original aa01 preparation and provisional Plan50 path, with all four source preimages unchanged at 6b1.

## Observed behavior and causal limits

The original a07 Codex job [133387314504](https://github.com/777genius/agent-teams-ai/actions/runs/43892535269/job/133387314504) retained an offline Team and offline Alice while the banner still displayed “Team launched - lead online”. Its original Stop and original process-absence checks completed before the stopped screenshot. The full original artifact is `14245098759` (2,984,265 bytes, SHA-256 `c2083ef34624881aae1d41445495386ced0c2b01cfaf99c4227569ba900904d6`); receipt `desktop-backend-receipt.json` SHA-256 `bef2be1c5c0b94f4f9a08e08cd69861c887190254ef75ede8650ee9cc351c3df`; stopped PNG SHA-256 `c65ff335f006a5b7470d6ec22c4a2fde4473e495b81f3ee1733e8b278d423903`.

The screenshot establishes that visible contradiction at the recorded moment. It does not establish how long it persisted or a permanent failure of the Host progress mapping. The current Host mapping can project released/stopped members to disconnected progress through its original two-second shared poll. The original UI journey did not wait for that later progress observation before taking the screenshot.

At base aa01, the presentation hook, Banner and presentation utility are byte-identical to frozen frontend `4a0e06277fe216d9f82dbbede362668fe46622ee`. The ready/solo branch renders the lead-online message without consulting Team liveness. The frozen ordinary owned-run Stop path published disconnected progress after cleanup; the migrated presentation can receive liveness and progress on different existing update paths. This cut fixes the resulting known-offline presentation gap, without claiming a new permanent backend Stop defect or identical behavior for every historical adapter.

The closed source audit is `p09-read-only-audit.json`, Git blob `88d1dd3ffbabc3f96ce408fd66e0f43b45f8f99b`, SHA-256 `6cb051ce102934690fbf3474b4c96e06be830fbe04e2ac1d4114f4bce8860f7d`.

## Exact behavior

Use the existing `selectTeamIsAliveForName` in the existing hook's `useStore(useShallow(...))` selection and include that primitive in the presentation memo dependencies. Return a null presentation only when current progress is `ready` and this Team's existing liveness value is explicitly `false`.

The actual selector keeps its selected-Team snapshot precedence over the named cache; another selected Team cannot supply this Team's liveness. `undefined` remains unknown and preserves the original presentation. Active and failed states preserve their existing content and diagnostics. No stored progress, historical result, run identity, member diagnostic, admission, authority, Stop owner or polling behavior changes. The existing Panel still displays its independent launch/cancellation error when presentation is null.

Production store `src/renderer/store/index.ts` (`99619bb7c8645c62f8c59b4d04d428f35ae2ba93`) exports the existing Zustand `create<AppState>()` bound hook. Adding `isTeamAlive` to its shallow-selected snapshot makes a change to that primitive observable to this consumer; `React.memo` does not replace the hook's own subscription. This is a source review of the existing subscription, not a claim that the mock tests execute Zustand notification scheduling.

## Four exact source postimages

All paths retain mode `100644`. The complete 13-hunk patch is 144 added / 6 removed lines.

| Path | Before Git blob | After Git blob | Physical lines |
| --- | --- | --- | --- |
| `src/renderer/components/team/useTeamProvisioningPresentation.ts` | `9d8f3cc46379ff0306b7ffc23d9daf43c379dc8f` | `0f7bed5837ca9017155dbc39c8b865fdfb53ef09` | 112 → 118 |
| `test/renderer/components/team/TeamProvisioningBanner.test.ts` | `f9a13b65d1b558415f55e41251859629917080b2` | `97e741dd65915e78f2b79a99ff4e8eeb3f768dc7` | 742 → 867 |
| `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` | `3ec75b1384e05f5e5f1d8368de946c2685afe608` | `a3d7047a1d081852263726b59f3fa39ab0428a29` | 334 → 339 |
| `.github/workflows/host-emulated-acceptance.yml` | `7ca54389de5f2e8909c458d60c70ab630c35645c` | `2c57fc6733ddc0e0b7f61f8ef56550b1f4ad553a` | 1366 → 1368 |

The common `desktopProofSupplementarySources` gains these five explicit leaves: the changed hook, `teamDataSelectors.ts`, `TeamProvisioningPanel.tsx`, `TeamProvisioningBanner.tsx` and the changed Banner test. These exact paths appear in the diff and manifest. The existing capture maps supplied paths directly, so this records the selected liveness/display/test dependencies without claiming recursive closure. Its Windows-specific successor array is unchanged. The existing Team lane `pnpm lint:fast:files --` gains exactly the hook and Banner test operands: 123 → 125, with every original operand in the same order. All other workflow commands, inputs, selectors, steps, timeouts and original acceptance assertions remain byte-for-byte unchanged.

Patch `candidate.patch`: Git blob `1d1125813240ee019cc32db381c406b81e8fac23`, SHA-256 `600604ee6b58817a66f60be843b8b018c98fdd117529a9ebc099ae64aa2d7586`, 10,979 bytes. Full before/after SHA-256, byte counts and exact replay record: `source-manifest.json`, Git blob `7b24d0b848d93b6c610a3c4abad42424d13a01e2`, SHA-256 `a98d738d8d1b6c0ac1bae11bf53093b79660bec7b2f072d0363068b01a891feb`, 9,531 bytes. Both are retained in the inert review packet `reviews/stale-ready-banner-inert`.

## Existing tests and their limits

Preserve all 15 original Banner cases and their assertions. Add seven cases in that same suite:

1. Solo ready with liveness true still renders the original lead-online message, despite a contrary cached value.
2. Solo ready with selected liveness undefined still renders it, despite cached false.
3. Solo ready with selected liveness false hides that presentation, despite cached true.
4. Another selected offline Team does not hide this named cached-online Team.
5. Assembling progress remains visible while offline.
6. Failed progress and its diagnostic remain visible while offline.
7. The same mounted Panel hides and restores the ready presentation across explicit true/false/true snapshots, retaining the identical progress object and contents.

The suite imports the actual existing liveness selector through its existing mocked teamSlice. Its existing store mock remains snapshot-only. The recovery case changes the existing `className` prop to drive a same-mounted Panel rerender; it verifies presentation recomputation and retained state without claiming to test subscription delivery. This limitation is explicit in the test comment. Original member warnings, failed-member display and disconnected cleanup-error cases remain unchanged.

The original safe frontend shards already include this existing test path; they remain the execution venue. Existing full workspace/renderer type checks, the existing fast-lint command, original source-freeze capture and Desktop acceptance retain their meanings. No new test suite, module, runner or prerequisite CI round is introduced.

## Size and qualification boundaries

The changed production hook is 118 lines and the common roster 339, both within the existing 800-line production bound. The 867-line existing test is excluded by the unchanged test-file and test-directory rules in `scripts/ci/check-source-file-size.mjs` (`65775f7889470056ef7cd91ad6c56d9351e6cdfc`). YAML is outside that guard's source-extension set. No baseline or exception changes are selected. The guard itself has been read, not executed for this candidate.

Only inert data hashing, unique replacement/inverse checks and complete unified-hunk replay have completed. Prospective 22 Banner cases, lint, type checks and resulting-head UI behavior are unexecuted at preparation time. The original Codex Stop runner is unchanged: adding a new CDP read or wait is outside this cut. Historical screenshots establish the problem; they do not qualify the new postimages. P09, genuine mixed/native Resume and all other still-open original acceptance boundaries retain their existing status.

# Existing Draft Promotion and Partial Staging

The ordinary full release uses `release.yml` and the compatible
`scripts/ci/promote-existing-draft.mjs` entrypoint. Full remains the default:
Mac, Windows and Linux must use the target version, and existing platform,
signing, runtime and tag/workflow-SHA gates remain mandatory.

For an existing old application tag, use `stage-existing-partial-draft.yml`
from a reviewed tooling commit. Its operations are **prepare** and
**stage-draft**. Neither builds applications nor publishes releases.
Publication still requires separate owner authorization and a supported
publication operation. Do not use GitHub's Publish button or direct
`gh release edit --draft=false` as a substitute.

## Explicit carry policy

`carry-mac` requires a pinned older public stable source tag in
`777genius/agent-teams-ai`. For the Windows/Linux 2.17.2 draft, the source is
`v2.17.1`. No moving `latest` source or Mac skip override is supported.

- Windows feeds contain x64 and ARM64 EXEs. Original blockmaps stay attached.
- Linux feeds contain AppImage, deb, rpm and pacman, with their real hashes/sizes.
- Mac feed bytes, historical date and absence of a minimum field are preserved.
- Four canonical source ZIP/DMG files and eight existing Mac stable/legacy
  aliases keep their original 2.17.1 names and bytes on both release tags.
- Source product minimum 12.0 is recorded as artifact metadata; the feed is
  never rewritten to insert a floor or the new target version.

## Prepare an immutable plan

Use the project's pinned Node runtime and frozen dependencies. `tsx` executes
these typed scripts; the canonical TypeScript 7 typecheck checks their graph.
Prepare requires the successful Windows/Linux build run, attempt and job IDs.
The tag SHA, application SHA and draft target must match; tooling SHA is a
separate reviewed commit.

```bash
pnpm exec tsx scripts/ci/prepare-existing-draft.ts \
  --repository 777genius/agent-teams-ai --release-tag v2.17.2 \
  --application-sha 359417f642abb97429aa6eb1a92f3ce52254e5f4 \
  --tooling-sha REVIEWED_TOOLING_SHA --mode carry-mac --mac-source-tag v2.17.1 \
  --build-run-id 36926049922 --build-attempt BUILD_ATTEMPT \
  --build-job-ids WINDOWS_X64_JOB_ID,WINDOWS_ARM64_JOB_ID,LINUX_JOB_ID --output EMPTY_TEST_DIRECTORY
```

Prepare audits actual downloaded bytes and writes `stage-plan.json` plus
`stage-plan.sha256`. New feed dates use the target's captured `created_at`.
Canonical plan serialization excludes retrieval times and destination upload
IDs. Persist the plan artifact and its SHA-256; do not reconstruct a different
plan to resume partial staging.

The staging workflow publishes only this metadata artifact. Dispatch it at the
reviewed tooling SHA with `operation=prepare`. For `operation=stage-draft`,
provide the original prepare run ID, artifact ID and `plan_digest`. A fresh
runner verifies the artifact bytes, application/mode/source inputs and external
plan digest, then downloads the pinned originals again.

```bash
pnpm exec tsx scripts/ci/stage-existing-draft.ts \
  --plan TEST_DIRECTORY/stage-plan.json --plan-digest PREPARED_SHA256
pnpm exec tsx scripts/ci/verify-updater-release.ts --state draft \
  --plan TEST_DIRECTORY/stage-plan.json --plan-digest PREPARED_SHA256
```

Before every upload, stage rechecks release visibility, metadata, tag SHA,
source identities and unchanged public latest. Missing outputs are appended;
identical bytes are verified and skipped. Conflicting bytes stop the operation.
There is no delete, clobber, replacement or automatic rollback. A lost upload
response is reconciled before retry. Interrupted drafts remain unpublished and
resume using the same immutable plan. The manifest is appended last.

## Assembly is not publication readiness

`release-platform-manifest.json` has schema 1 and immutable `phase: assembled`.
It records original asset IDs/hashes, alias relationships, platform versions,
application/tooling SHAs and build provenance. It contains no destination
upload receipts, native outcomes or self hash. Completing stage does not claim
that native updater installation has passed.

Before carry publication, append `release-source-mac-evidence.json` separately
without replacing the platform manifest. Its typed contract is
`NativeEvidence` in `scripts/ci/release/contract.ts`. Bind `reference.inputDigest`
to the manifest input digest and record producer repository/run/attempt/job,
artifact ID/name/SHA-256 and reviewed tooling SHA. The producing artifact must
contain `mac-source-signature-evidence.json` with the typed `NativeProbeArtifact`
content: input digest, tooling SHA, source tag/application SHA and identical
asset probes. The artifact content excludes its eventual receipt/digest,
avoiding a self-hash cycle.
All four source ZIP/DMG probes must bind source asset ID/SHA-256, bundle version,
architecture, product minimum 12.0, TeamIdentifier `6C84CW694S` and successful
codesign, spctl, stapler, lipo and bundle metadata command output hashes. The
trusted producer is `.github/workflows/updater-mac-source.yml`.
Signature evidence and the ten-scenario native OTA matrix remain
separate evidence requirements; assembly tests replace neither.

The default-branch publication guard checks the producing job and artifact
bytes independently, audits actual canonical payload/feed bytes and current
GitHub metadata, and requires anonymous source/target paths plus GitHub latest.
A manifestless release is accepted only by the strict equal-version full
contract. Unknown or malformed manifests fail closed. Missing signature
sidecars make carried releases fail closed. Only transient transport failures
retry; failed published verification returns the release to draft.

## Compatible environment entrypoint

Existing full-mode environment variables and publication behavior are retained.
`RELEASE_MODE=carry-mac` explicitly opts into typed assembly, with
`PROMOTION_OPERATION=prepare` as the default. Prepare additionally requires
`RELEASE_APPLICATION_SHA`, `RELEASE_TOOLING_SHA`, `MAC_SOURCE_TAG`,
`RELEASE_BUILD_RUN_ID`, `RELEASE_BUILD_ATTEMPT`, `RELEASE_BUILD_JOB_IDS` and an
empty disposable `PROMOTION_OUTPUT_DIR`. Stage uses `RELEASE_STAGE_PLAN` and
`RELEASE_STAGE_PLAN_DIGEST`. Carry mode rejects `PUBLISH_RELEASE=true` in this
assembly checkpoint. `PROMOTE_DRY_RUN=true` remains read-only.

## Focused verification

```bash
pnpm typecheck
pnpm lint:ci:files -- scripts/ci/release/*.ts scripts/ci/*existing-draft.ts \
  scripts/ci/verify-updater-release.ts test/scripts/partialReleaseStaging.test.ts
pnpm exec vitest run --maxWorkers=1 test/scripts/partialReleaseStaging.test.ts \
  test/scripts/promoteExistingDraft.test.ts
```

Use only disposable TEST state for runtime/native checks. Never test updater
or agent actions on real user projects. Source replacement, changed metadata,
missing architectures or digest conflicts require investigation; they are not
permission to bypass validation or replace draft assets.

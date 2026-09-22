# Existing Draft Promotion

Use `scripts/ci/promote-existing-draft.mjs` to publish a reviewed release draft
without rebuilding installers that are already attached to that draft.

The normal entry point is `release.yml`. Do not publish the release directly
with GitHub's **Publish release** button or `gh release edit --draft=false`.

## When to use it

Use the fast path when all platform jobs for the draft have already succeeded,
the release notes are final, and the versioned installer assets must not change.

Use the full build path instead when any installer needs to be rebuilt, a signing
or notarization result is uncertain, the runtime pin changed, or the draft does
not target the exact release tag commit.

The release tag must already contain the fast-path workflow and script. A tag
created before these files existed cannot use this mode; publish that release
with the full workflow from its tag.

## Supported workflow

```bash
VERSION=2.10.0

gh workflow run release.yml \
  --repo 777genius/agent-teams-ai \
  --ref "v${VERSION}" \
  -f "release_tag=v${VERSION}" \
  -f publish_release=true \
  -f reuse_existing_draft_assets=true
```

Then identify and watch the new run:

```bash
gh run list \
  --repo 777genius/agent-teams-ai \
  --workflow release.yml \
  --limit 3

gh run watch <RUN_ID> --repo 777genius/agent-teams-ai
```

The workflow keeps the existing release ID, body, screenshots, target commit,
and versioned assets. It only adds the stable aliases, compatibility aliases,
and canonical updater feeds before making the same release public.

## Safety checks

Before any upload or publication, the script verifies:

- `RELEASE_TAG` is a semantic version tag.
- The release exists and is a draft, is not a prerelease, and has no updater
  skip marker.
- The draft's `targetCommitish` exactly matches the commit resolved by the tag.
- All nine source artifacts exist: macOS ARM and Intel DMG/ZIP files, Windows
  EXE, Linux AppImage, deb, rpm, and pacman packages.
- Every source asset exposes a GitHub SHA-256 digest.
- Every downloaded file matches that digest before it is reused.

After validation, the script prepares:

- 7 stable download aliases.
- 7 legacy stable aliases.
- 6 legacy updater aliases.
- `latest.yml`, `latest-linux.yml`, and `latest-mac.yml` with SHA-512 hashes,
  sizes, versioned filenames, and the publication timestamp.

It uploads those files, publishes the release as GitHub latest, and runs
`scripts/ci/verify-published-updater-release.sh`. If the updater guard fails,
the release is returned to draft.

## Read-only dry run

Run this before publication to validate the real draft assets without uploading
aliases, updater feeds, or changing the release state:

```bash
RELEASE_REPOSITORY=777genius/agent-teams-ai \
RELEASE_TAG=v2.10.0 \
PROMOTE_DRY_RUN=true \
  node scripts/ci/promote-existing-draft.mjs
```

The dry run downloads all nine source artifacts, verifies their SHA-256 values,
and builds the 20 aliases and three feeds in a temporary directory. The
directory is deleted automatically.

To inspect generated files, provide an empty disposable directory:

```bash
PROMOTION_DIR="$(mktemp -d)"

RELEASE_REPOSITORY=777genius/agent-teams-ai \
RELEASE_TAG=v2.10.0 \
PROMOTE_DRY_RUN=true \
PROMOTION_OUTPUT_DIR="$PROMOTION_DIR" \
  node scripts/ci/promote-existing-draft.mjs
```

Remove `PROMOTION_DIR` after inspection. Never point it at a repository or a
directory containing user files.

## Environment variables

| Variable                           | Required | Purpose                                                        |
| ---------------------------------- | -------- | -------------------------------------------------------------- |
| `RELEASE_REPOSITORY`               | Yes      | GitHub repository in `owner/repository` form.                  |
| `RELEASE_TAG`                      | Yes      | Exact semantic release tag, for example `v2.10.0`.             |
| `GH_TOKEN`                         | Workflow | GitHub token used by `gh` for downloads, uploads, and publish. |
| `PUBLISH_RELEASE`                  | No       | Must be `true` for publication; defaults to `false`.           |
| `PROMOTE_DRY_RUN`                  | No       | Builds and verifies locally without mutations when `true`.     |
| `PROMOTION_OUTPUT_DIR`             | No       | Keeps dry-run outputs in an explicit disposable directory.     |
| `ALLOW_PUBLISHED_RELEASE_RECOVERY` | Internal | Allows the full workflow to repair an already-public release.  |
| `REDRAFT_INCOMPLETE_RELEASE`       | Workflow | Returns an incomplete published release to draft.              |

`PROMOTE_DRY_RUN=true` and `PUBLISH_RELEASE=true` are mutually exclusive.

## Verification

Focused local verification:

```bash
pnpm typecheck
pnpm lint:fast:files -- \
  scripts/ci/promote-existing-draft.mjs \
  scripts/ci/promote-existing-draft.d.mts \
  test/scripts/promoteExistingDraft.test.ts
pnpm exec vitest run --maxWorkers=1 \
  test/scripts/promoteExistingDraft.test.ts
```

The test suite includes an isolated end-to-end dry run with a fake GitHub
release. Before enabling the fast path for a release, also run the read-only dry
run against that real draft.

## Recovery

If source artifacts are missing, their digests do not match, or the target
commit differs from the release tag, stop. Do not bypass the validation or
publish directly. Resolve or replace the draft using the main release procedure
in [RELEASE.md](RELEASE.md).

If an incomplete release is already public, follow the recovery section in
`RELEASE.md`. The full publish workflow supports repair mode; the normal fast
path intentionally requires a draft.

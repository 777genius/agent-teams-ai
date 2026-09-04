# Publishing announcements

Edit `landing/content/announcements`, never `landing/public/announcements` (generated and ignored). The initial production source contains only `feed.config.json` with `autoShowEnabled: false`. Example posts belong in disposable test fixtures.

Create a lowercase slug directory (1-80 characters, letters/digits/hyphens), with `meta.json`, UTF-8 `body.md`, and optional `assets/`. The ID must match its directory. Minimal metadata:

```json
{
  "id": "release-note",
  "title": "Release note",
  "publishedAt": "2026-09-15T12:00:00Z",
  "status": "draft"
}
```

Defaults: `validUntil` is 14 days after publication, `showToNewUsers` is true, `minUsageMinutes` is 30. Explicit false and zero are preserved. `validUntil` must be later than publication; null is invalid. Dates need timezone information. Title is plain text, max 200 characters. Unknown metadata fields do not affect output.

Set the optional title banner in `meta.json` with `"heroImage": "assets/hero.png"`. The file must be a local PNG, JPEG, GIF, WebP or AVIF inside that announcement's `assets/` directory. The generator publishes it as an immutable `heroImagePath`; the desktop renders it edge to edge directly below the header at a 55:12 aspect ratio. Use a 1100 x 240 image to avoid cropping.

Reference images using `![Description](assets/banner.webp)`. Inline and reference-style images must resolve to local assets. Supported extensions: png, jpg, jpeg, gif, webp, avif. Filenames use portable ASCII letters/digits/dot/underscore/hyphen; reserved Windows filenames, case collisions, symlinks, traversal and unlisted files are rejected. Limits: 5 MiB per image, 256 KiB per body, 512 KiB/1000 items per feed. Raw bytes, including CRLF, are preserved. HTML is not a supported content format; the desktop reader sanitizes Markdown.

Change status to `published` to publish, `archived` to retain manual history without automatic display, or `withdrawn` to remove it from the feed. Drafts are excluded. Future publications are included in static output but hidden by clients until their date. None of these statuses make committed content private.

Once published, keep the directory/ID, publication time and cohort flag (`showToNewUsers`) unchanged. The Git-base check normalizes dates/defaults before comparison. Do not delete old metadata or return it to draft; use withdrawn. Edit body/title/expiry/usage threshold in place for corrections. Reusing the ID does not request another automatic display. A different event needs a new ID.

```sh
pnpm announcements:test
pnpm announcements:check --base <available-base-sha>
pnpm announcements:generate
```

The check fails if the Git base is absent/unavailable. CI checks PR source at the actual head SHA against the PR base, and `main` pushes against the previous pushed SHA. It runs without path skips, including generator/workflow changes, so Render cannot mistake a skipped content job for a passing validation. Require `announcements-content-check` in branch protection. Do not bypass it with a force push or manual deploy. Workflow dispatch without a base intentionally fails; use a normal PR/push for publication.

`generateAnnouncements({ sourceDir, outputDir, repoDir, baseRef, checkOnly })` is also exported by `generate.mjs` for isolated fixtures. CLI overrides: `--source`, `--output`, `--repo`, `--base`, `--check`. `--check` validates without writing and always requires a base. The generator only replaces its dedicated output directory after all sources pass validation.

Output uses `/announcements/feed.v1.json` and `/announcements/content/<id>/<bundle-sha256>/body.md`. The bundle digest includes names and hashes of all local assets and body bytes. Image-only changes change the bundle URL; bodySha256 hashes exactly the served body bytes. Revision hashes canonical normalized feed contents, with deterministic ordering. No build timestamp enters either hash. Old bundles can disappear at the next static deploy; the client must refresh a stale feed after 404, never substitute a different body under an old URL.

## Render configuration and verification

The documented Render command in `landing/README.md` invokes `pnpm --filter agent-teams-landing generate`; that script now generates announcements before Nuxt. `build` and `generate:all` do likewise. Publish `landing/.output/public`. Do not call `nuxt generate` directly to bypass validation. GitHub Pages is a separate deployment and does not prove production Render behavior.

Before first publication, configure the actual Render landing service (a separate operator action, not performed by this implementation):

- Auto-Deploy: **After CI Checks Pass**. Confirm `announcements-content-check` succeeds on the exact deploy SHA; Render also accepts skipped/neutral checks, which is why this job has no path/step skips.
- Ensure build filters include `landing/**`, `scripts/announcements/**` and `.github/workflows/announcements-content.yml`.
- Remove any catch-all rewrite to `/index.html` covering announcements. Missing announcement paths must return 404, including after content withdrawal. Existing files take precedence over Render rewrites, but missing files do not.
- Set the following response headers using Render Static Site Headers. A committed `_headers` file is not Render configuration.

| Path                             | Header                   | Value                                             |
| -------------------------------- | ------------------------ | ------------------------------------------------- |
| `/announcements/feed.v1.json`    | `Content-Type`           | `application/json; charset=utf-8`                 |
| `/announcements/feed.v1.json`    | `Cache-Control`          | `public, max-age=0, s-maxage=60, must-revalidate` |
| `/announcements/content/*`       | `Cache-Control`          | `public, max-age=31536000, immutable`             |
| `/announcements/content/**/*.md` | `Content-Type`           | `text/markdown; charset=utf-8`                    |
| `/announcements/*`               | `X-Content-Type-Options` | `nosniff`                                         |

After a separately authorized deployment, use GET/HEAD to verify the real feed URL returns JSON, a body URL returns Markdown whose SHA matches, asset paths load, headers match, and a nonexistent announcement returns 404 rather than HTML 200. Keep `autoShowEnabled: false` until production paths are proven. Then enabling auto display is a separate content change. Roll back by setting it false or withdrawing a post, publishing normally, and checking the served feed. Neither action erases local handled IDs.

Official references checked 2026-09-04: [Render headers](https://render.com/docs/static-site-headers), [rewrites](https://render.com/docs/redirects-rewrites), [CI gated deploys](https://render.com/docs/deploys#integrating-with-ci).

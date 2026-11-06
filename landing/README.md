# Agent Teams Landing

## Quick start

```bash
pnpm install
pnpm dev
```

## Build (SSG)

```bash
pnpm generate
pnpm preview
```

## GitHub Pages deployment

The [landing workflow](../.github/workflows/landing.yml) builds and deploys the landing and product docs together to GitHub Pages on relevant `main` pushes (or manual dispatch).

- Landing: https://777genius.github.io/agent-teams-ai/
- Bundled docs: https://777genius.github.io/agent-teams-ai/docs/
- Build: `npm ci` in `landing/`, then `npm run generate:all`.
- Published directory: `landing/.output/public`.
- Build URLs: `NUXT_APP_BASE_URL=/agent-teams-ai/` and `NUXT_PUBLIC_SITE_URL=https://777genius.github.io/agent-teams-ai`.

The workflow validates generated docs and canonical URLs before uploading the Pages artifact.

## Hetzner production domains

The public **production** landing at `https://agentteams.live` and separate docs at `https://docs.agentteams.live` run on Hetzner (`prod-hel1-01`, Caddy), not on GitHub Pages. This was recorded in the 2026-09-23 cutover receipt in `777genius/platform-infra`.

The [production static build workflow](../.github/workflows/landing-hetzner-release.yml) generates two separate root-path sites with the correct canonical URLs and an exact Git SHA marker. It **only prepares immutable artifacts**; it does not change the live Hetzner server. Publishing requires the reviewed operator command and authenticated SSH described in the private `platform-infra/docs/runbooks/agent-teams-static-deploy.md` runbook.

Do **not** deploy the GitHub Pages `/agent-teams-ai/` build to either production domain.

## Notes

- Static-first (SSG) by design.
- Locale auto-detection: cookie -> browser settings -> fallback `en`.
- Theme auto-detection: localStorage -> system preference -> fallback `light`.
- Hero video uses the Mux Player embed. Set `NUXT_PUBLIC_MUX_PLAYBACK_ID` to override the default playback id without changing the code.
- Hero background uses its own default Mux asset. Set `NUXT_PUBLIC_MUX_BACKGROUND_PLAYBACK_ID` to override it independently of the demo video.
- Set `NUXT_PUBLIC_DOCS_SITE_URL` when the docs are deployed as a separate static site.

## Announcements

Static builds generate the announcement feed before Nuxt. Authoring, validation, immutable IDs and hosting requirements are documented in [the publishing runbook](../scripts/announcements/README.md). The production feed starts empty with automatic display disabled.

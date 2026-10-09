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

## Render static sites

Landing and docs are deployed as separate Render Static Sites from the `main` branch.

Landing:

```bash
corepack enable && pnpm install --frozen-lockfile --ignore-scripts && NUXT_PUBLIC_LANDING_SITE_URL=https://agentteams.live NUXT_PUBLIC_DOCS_SITE_URL=https://docs.agentteams.live NUXT_PUBLIC_ROBOTS="index, follow" pnpm --filter agent-teams-landing generate
```

Publish path: `landing/.output/public`

Docs:

```bash
corepack enable && pnpm install --frozen-lockfile --ignore-scripts && VITEPRESS_BASE=/ VITEPRESS_SITE_URL=https://docs.agentteams.live VITEPRESS_LANDING_SITE_URL=https://agentteams.live pnpm --filter agent-teams-landing docs:build
```

Publish path: `landing/product-docs/.vitepress/dist`

Both sites set `NODE_VERSION=24.16.0` and `SKIP_INSTALL_DEPS=true`; the build command runs the pnpm install step explicitly with `--ignore-scripts`.

Production canonical domains are `https://agentteams.live` and `https://docs.agentteams.live`. Set the explicit landing URL shown above so the Render service URL does not override production canonical, Open Graph, Twitter, and sitemap URLs. For isolated preview deployments, override these URLs with the preview origins.

The GitHub Pages workflow publishes a separate mirror under `/agent-teams-ai/` and intentionally keeps its own matching site URL and base path; production is served from Render on the custom domain.

## Notes

- Static-first (SSG) by design.
- Locale auto-detection: cookie -> browser settings -> fallback `en`.
- Theme auto-detection: localStorage -> system preference -> fallback `light`.
- Hero video uses the Mux Player embed. Set `NUXT_PUBLIC_MUX_PLAYBACK_ID` to override the default playback id without changing the code.
- Hero background uses its own default Mux asset. Set `NUXT_PUBLIC_MUX_BACKGROUND_PLAYBACK_ID` to override it independently of the demo video.
- Set `NUXT_PUBLIC_DOCS_SITE_URL` when the docs are deployed as a separate static site.

## Announcements

Static builds generate the announcement feed before Nuxt. Authoring, validation, immutable IDs and required Render headers are documented in [the publishing runbook](../scripts/announcements/README.md). The production feed starts empty with automatic display disabled.

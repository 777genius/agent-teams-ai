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
corepack enable && pnpm install --frozen-lockfile --ignore-scripts && NUXT_PUBLIC_SITE_URL=$RENDER_EXTERNAL_URL NUXT_PUBLIC_DOCS_SITE_URL=https://agent-teams-ai-docs.onrender.com NUXT_PUBLIC_ROBOTS="index, follow" pnpm --filter agent-teams-landing generate
```

Publish path: `landing/.output/public`

Docs:

```bash
corepack enable && pnpm install --frozen-lockfile --ignore-scripts && VITEPRESS_BASE=/ VITEPRESS_SITE_URL=$RENDER_EXTERNAL_URL VITEPRESS_LANDING_SITE_URL=https://agent-teams-ai-landing.onrender.com pnpm --filter agent-teams-landing docs:build
```

Publish path: `landing/product-docs/.vitepress/dist`

Both sites set `NODE_VERSION=24.16.0` and `SKIP_INSTALL_DEPS=true`; the build command runs the pnpm install step explicitly with `--ignore-scripts`.

When a custom landing domain is attached, update `VITEPRESS_LANDING_SITE_URL` on the docs site. When a custom docs domain is attached, `VITEPRESS_SITE_URL=$RENDER_EXTERNAL_URL` can stay unchanged for the Render preview URL or be replaced with the custom domain for canonical SEO.

## Notes

- Static-first (SSG) by design.
- Locale auto-detection: cookie -> browser settings -> fallback `en`.
- Theme auto-detection: localStorage -> system preference -> fallback `light`.
- Hero video uses the Mux Player embed. Set `NUXT_PUBLIC_MUX_PLAYBACK_ID` to override the default playback id without changing the code.
- Hero background can use a separate Mux asset via `NUXT_PUBLIC_MUX_BACKGROUND_PLAYBACK_ID`; otherwise it reuses `NUXT_PUBLIC_MUX_PLAYBACK_ID`.
- Set `NUXT_PUBLIC_DOCS_SITE_URL` when the docs are deployed as a separate static site.

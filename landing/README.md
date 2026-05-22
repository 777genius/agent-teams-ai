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

## Notes
- Static-first (SSG) by design.
- Locale auto-detection: cookie -> browser settings -> fallback `en`.
- Theme auto-detection: localStorage -> system preference -> fallback `light`.
- Hero video uses the Mux Player embed. Set `NUXT_PUBLIC_MUX_PLAYBACK_ID` to override the default playback id without changing the code.
- Hero background can use a separate Mux asset via `NUXT_PUBLIC_MUX_BACKGROUND_PLAYBACK_ID`; otherwise it reuses `NUXT_PUBLIC_MUX_PLAYBACK_ID`.

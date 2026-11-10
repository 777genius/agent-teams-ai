# Landing Visual QA

- For cyberpunk landing work, verify layout with browser/runtime measurements, not by eye only.
- Use Chrome DevTools MCP for landing visual QA. Do not use Brave real browser as a fallback for this landing unless the user explicitly asks for Brave.
- First try the direct `mcp__chrome_devtools__*` namespace for viewport screenshots, DOM rectangles, computed styles, console errors, network state, and performance checks.
- If the direct `mcp__chrome_devtools__*` namespace is exposed but the transport is closed, diagnose/fix that first. The stable global config should point to a fixed local install, not `npx @latest`: `/usr/local/bin/node /Users/belief/.codex/mcp/chrome-devtools/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js --isolated --viewport=1440x900 --logFile /Users/belief/.codex/log/chrome-devtools-mcp.log --no-usage-statistics --no-performance-crux`.
- If the current Codex thread cannot recover the direct transport after the config is fixed, use only the official Chrome DevTools MCP isolated stdio client as the temporary fallback. The current server uses newline-delimited JSON-RPC over stdio. Kill the spawned MCP process after screenshots/metrics finish.
- If `chrome-devtools` is enabled in `~/.codex/config.toml` but no `mcp__chrome_devtools__*` tools are exposed in the current thread, treat it as a Codex Desktop tool-schema/session exposure issue. Start a fresh thread/session when possible; otherwise use the official isolated Chrome DevTools MCP stdio client above, not Brave.
- Required visual viewports for this landing: `2048x1152`, `1680x941`, `1366x768`, and `390x844`.
- For the HUD header, measure the brand panel, nav rail, action panel, nav item centers, and action button centers with `getBoundingClientRect()`. Check that hover/focus glow is clipped to the angular panel shape.
- For the hero video scene, measure robot foot baselines against the video frame top/bottom/side edges. Top-row robots should stand on the top edge; bottom-row robots should stand on the bottom edge; side robots should not cover the video content randomly.
- Keep the header as live DOM plus SVG. Do not ship a PNG header asset except for reference images stored under `assets/images/references/`.
- Do not run `pnpm generate` while the landing dev server is running. Stop dev first, generate, then run cleanup before starting dev again.

# Appearance v1: portable custom palettes and whole-app scale

Status: implementation plan for this Draft PR. Scope is **custom visual themes + UI scale**, not a redesign of existing Dark/Light/System.

## Baseline audit (2026-11-08)

- `src/renderer/index.css` already provides theme-aware `--color-*` semantic tokens, dedicated dark defaults, light overrides, and Tailwind bridges. Preserve both palettes byte-for-byte.
- `useThemeController` owns `dark`/`light` classes from backend `general.theme`; the config JSON editor currently edits *backend-wide* settings. Never put per-client appearance palettes there.
- The Electron window already reports zoom to the renderer and aligns macOS traffic lights to `webContents.getZoomFactor()`. A CSS transform on the desktop root would break native geometry. Browser mode has no native zoom API.
- Code viewers and status colors use other specialized tokens; these keep their original semantic meaning unless we explicitly derive neutral backgrounds/text from the new palette.

## Minimal data contract

- Existing built-in `dark`, `light`, `system` remain untouched in `AppConfig.general.theme`.
- A new renderer-local `agent-teams-appearance-v1` record owns only `zoomPercent`, `activeCustomThemeId`, and up to 8 named user themes. No new backend service, Electron-only data model, remote sync, or migrations.
- Each user theme has an ID, display name, base `dark|light` and an allowlisted 11-color **hex** palette:
  `surface`, `surfaceRaised`, `surfaceOverlay`, `surfaceSidebar`, `border`, `borderSubtle`, `borderEmphasis`, `text`, `textSecondary`, `textMuted`, `accent`.
- Base `dark|light` continues to drive `dark:` Tailwind branches. Applying a custom theme overrides the 11 core CSS tokens and derives *neutral* secondary tokens in a scoped `:root.custom-theme` rule; status, warning, diff, syntax semantics retain their purpose.
- Validation rejects CSS expressions/URLs, unknown fields, duplicates, missing required colors, unreasonable record sizes, invalid IDs and unsafe JSON. Invalid persisted values fall back to the original theme.
- Only explicitly applying a valid JSON palette persists; editing/invalid drafts never change live UI. Removing an active theme restores the previous built-in theme and original palette. LocalStorage blocked/quota errors are visible to the user.

## Zoom

- Presets: 80%, 90%, 100%, 110%, 125%, 150%, 175%, 200%; default 100%. This is *application zoom*, separate from browser zoom.
- Electron: a narrow preload/API zoom setter uses `webContents.setZoomFactor()` and the existing `syncTrafficLightPosition` path. Do not use CSS zoom there.
- Browser: change `document.documentElement.style.zoom`; do not intercept system/browser zoom shortcuts. Restore on load; no app restart.
- Persist a chosen preset in the local appearance record. Electron's existing Cmd/Ctrl +/- keeps working; native updates are reflected in the selection if they match a preset, with no loops.

## Settings UX

- Appearance: existing Dark/Light/System controls, a local custom-theme selector for user-created themes, **Edit themes (JSON)** using CodeMirror (same editor technology as application config), and a UI scale selector + reset.
- JSON example shows named themes and required palette fields; clear errors for malformed JSON/invalid colors/duplicates. Readonly system themes cannot be overwritten/deleted. No arbitrary CSS or user-provided CSS selectors.
- Apply/remove theme immediately; never alter projects, server settings, or provider config. Show local-profile scope in UI.
- Translate the short new labels across all 29 locales; preserve existing labels and translations.

## Critical review cycles, applied before implementation

1. **Architecture / DRY critique:** Avoid a backend-wide visual config, a new Zustand store, a generic theme-plugin engine, or changing hundreds of components. Reuse the existing 11 primary CSS variables and a single storage/validation module.
2. **Security / correctness critique:** Free-form CSS was discarded: unsafe `url()`/functions and arbitrary token names could affect security and layout. Reject malformed/oversized input before writing; preserve active theme on validation/save failure.
3. **UX / platform critique:** CSS zoom in Electron would desynchronize macOS controls; use native zoom instead. A single theme JSON auto-save is dangerous when a user is halfway through typing: require explicit Save and allow Cancel. Browser zoom stays independent.

## Acceptance / E2E gate

- Built-ins unchanged (including System/OS changes); custom dark and light palettes apply to Settings, sidebar, tabs, messages and the primary code surface; switching back removes *all* overrides.
- Multiple named themes add/select/edit/delete. Invalid JSON/unsafe colors/duplicate IDs neither apply nor persist. Reload, independent browser profiles, storage failures and missing theme fallback.
- 80..200% zoom applies to whole UI, persists and resets; keyboard/browser/Electron shortcuts remain functional; native macOS title buttons stay aligned.
- Run native TypeScript, lint, focused Vitest, existing desktop E2E, browser E2E at 100/125/200%, light/dark/theme screenshots, contrast and focus checks. Review findings fixed in follow-up commits; no merge until checks prove ready.

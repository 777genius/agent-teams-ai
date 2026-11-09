# Appearance typography: font family and text size (2026-11-09)

Status: scoped implementation plan for the draft PR. Builds on merged Appearance #1142.

## Goal

Add two independent per-device Appearance controls: **UI font family** and **text size**. Preserve the existing Dark/Light/System themes, JSON palettes, interface zoom and existing browser/Electron behavior. No remote font downloads, account synchronization, OS font installers or new dependencies.

## Baseline and design

- Reuse `AppearancePreferences`, `appearanceStore`, `useSyncExternalStore`, and the root Appearance controller; persist alongside custom themes and zoom in the existing `agent-teams-appearance-v1` record.
- Backward-compatible defaults for records written before this feature: `fontFamily: null` (existing OS/browser sans-serif chain) and `fontSizePercent: 100`.
- Family: default System; short familiar named fonts as fallback choices; a manual font-family name entry for any locally installed font. Render a safely quoted and strictly validated *single family name* with the existing sans-serif fallback. Do not parse/accept CSS expressions, font URLs, `@font-face` or arbitrary style properties.
- Optional **Show installed fonts** button: `queryLocalFonts()` only on a direct user click, where supported and allowed; request explicit browser permission, deduplicate/filter names, and keep selected names local. Unsupported, denied or opaque-origin contexts do **not** break manual choice. The API is experimental, non-universal and unavailable on some packaged Electron `file:` origins. Never auto-enumerate fonts or transmit names to the backend.
- Size: percentages 80/90/100/110/125/150%, applied to normal UI typography rather than browser/Electron zoom. Scale Tailwind's standard font-size **and line-height** together so labels do not clip; apply size to inheriting body text. CodeMirror and xterm font metrics retain their independent intentional monospace settings. Typography changes must not alter zoom or change fixed rem-based layout spacing.
- Apply CSS font on the document root/body via one renderer adapter/hook; preserve legacy default and clean up on unmount. The selected family will fall back to installed/browser sans-serif if missing, without broken UI.
- Add compact Appearance controls with labels, descriptive copy, reset actions, and usable focus order. Update all 29 settings locale dictionaries; translation quality for English and Russian is prioritized, others have localized compact descriptions.

## Hard scope boundaries

Do not change backend `general.theme` or server config, do not enumerate or read OS font files with Electron IPC or third-party native binaries, do not alter editor or terminal fonts, do not introduce CSS stylesheet injection, font downloads, new persistence services, a generic typography/theme system, or feature flags. The font-size setting is separate from whole-app zoom.

## Review / critique before coding

1. **Privacy / platforms:** A silent OS font scan would be a fingerprinting vector; the browser API must be user-initiated and optional. A platform-specific native font enumerator would add dependency and Electron security surface for a cosmetic feature. Prefer explicit opt-in + manual name fallback.
2. **Layout / UX:** Changing `html` root font size also changes Tailwind rem spacing (double-scales layout with UI zoom), and changing `body` alone misses Tailwind explicit font-size classes. Scale standard Tailwind type utilities with their line-height and keep rem spacing unchanged.
3. **State / migrations:** Introduce optional fields into the v1 record without changing version/key, parse legacy records with defaults, and preserve read-modify-write of latest values on edits. Reject malformed family names and out-of-range size before persisting. Keep theme editor conflict checks scoped to palettes.

## Verification

- Domain and storage tests: defaults, old record compatibility, invalid/malicious CSS, bounds, persistence, storage rejection, cross-tab merging with theme/zoom.
- Browser React controller: actual CSS family and text-size tokens after changes, switch System, unmount cleanup, no impact on zoom.
- Real Electron/CDP Appearance E2E: change font, change size, inspect computed typography, persistence, reload/navigate, reset, screenshots at 100% and 200% UI zoom, no settings control clipping.
- Workspace typecheck, focused Vitest, lint, native desktop CI + CodeQL and cross-platform build checks as available. Review actual diff and checks; fix findings before squash merge and verify post-merge workflows.

## Acceptance

Users can select a familiar or installed font name (or type another installed family), separately change UI text size, see changes immediately, persist them on this device in both desktop and Web, and reset to the existing OS font/100% without changing zoom, themes or terminal/editor rendering.

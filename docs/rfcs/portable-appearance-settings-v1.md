# RFC: Portable Appearance settings (v1)

Status: **proposal only**. No runtime behavior changes in this RFC. This document is intentionally separate from [PR #1130](https://github.com/777genius/agent-teams-ai/pull/1130), which creates the dedicated Appearance page.

## 1. Current state and problems

**Historical baseline (#1130):** Appearance offered Dark / Light / System, expanding AI responses by default, and the native title bar on eligible Electron platforms. Theme remains in `AppConfig.general.theme` via `useThemeController`.

**Current `main` (2026-11-18):** Appearance additionally ships browser-local custom themes, whole-app zoom, font family, and app text scaling. `src/features/appearance/core/domain/appearancePreferences.ts` defines the existing `AppearancePreferences` record; `renderer/adapters/appearanceStore.ts` persists it under `agent-teams-appearance-v1`; `renderer/hooks/useAppearance.ts` applies typography and zoom. This proposal concerns **additional, scoped controls** (not reimplementing or removing the ones already released).

`display.showTimestamps`, `display.compactMode` and `display.syntaxHighlighting` are defined in types, defaults and validation. A repository usage search did **not** find their integration into the actual message/task/code rendering components. Do not surface these keys as functioning toggles until they demonstrably change what users see.

The app provides **30 UI locales**. New user-facing settings need localized labels, explanations and options; this is included in LOC estimates below.

**Data ownership matters:** `ConfigManager` is a backend-wide configuration source. For new *per-client* visual preferences, storing values there would unexpectedly change multiple browser clients or a local desktop view. Preserve the existing stored `general.theme` contract in v1 for backwards compatibility; do not silently migrate it.

## 2. Product decisions

- Keep the page small: **Color**, **Readability**, **Motion**; add **Layout** only when its first real control ships. Desktop-only window settings remain below portable settings and are hidden outside supported environments.
- Prefer a short segmented control (2–3 explicit presets) over sliders, free-form CSS, user-defined pixel values or nested subpages. Every control has one-sentence help text and a predictable default.
- Apply visual changes immediately. Revert the setting on persistence failure and show one clear error. Do not restart for portable settings.
- Extend the **existing** validated, versioned renderer-local `agent-teams-appearance-v1` preference flow where compatible rather than creating a second store. Keep the current defaults, per-profile isolation, denied-storage handling and cross-tab `storage` synchronization. Use a schema-version migration only if a new field requires it; preserve older themes, fonts and zoom. No account sync or backend migration in this proposal.
- Validate **all** local-storage reads, writes and values before CSS projection. Reuse `parseAppearance`, `MAX_JSON_LENGTH` (16,384 characters), the strict theme ID / six-digit hex color checks, `normalizeFontFamily`, and safe `try/catch` fallback from `src/features/appearance/core/domain/appearancePreferences.ts` and `src/features/appearance/renderer/adapters/appearanceStore.ts`. Bound any new presets/strings; do not pass arbitrary persisted CSS values into styles.
- Apply **new** scoped presentation through existing React components/CSS variables or `data-*` attributes; do not create a second zoom controller or duplicate HTTP/IPC implementations. Preserve the **shipped** `useAppearanceZoomController`: Electron calls `api.setZoomFactor`, while the browser sets root `style.zoom` with an inverse-zoom token. Its platform branching is established behavior, not a recommendation for new controls.
- Do not change team/task data, runtime settings, provider connection behavior or persisted backend config as a side effect of a purely visual option.

## 3. Options and estimated implementation size

**LOC = rough net new/changed production + tests + all 30 locale additions**, not a commitment. Range assumes reuse of existing settings components and no new framework. Estimates are per setting; if implemented together, common preference plumbing is written once, not repeatedly.

| Priority | Setting / proposed values | Estimated LOC | User value (1–10) | Regression risk | Decision |
| --- | --- | ---: | ---: | --- | --- |
| P0 | **Theme control accessibility:** expose selected Dark/Light/System state to assistive tech; keep current behavior | **25–65** | 8 | Low | Do first; no new persisted key or translations |
| P0 | **Chat text size:** Small / Default / Large; scope typography to messages, not entire app or editors | **190–340** | 9 | Low–medium | Additional *chat-only* control; do not duplicate existing app-wide `fontSizePercent` |
| P0 | **Motion:** Follow system / Reduce animations; never force motion when OS requests reduced motion | **220–390** | 9 | Medium | Audit existing animation hotspots and loaders; do not disable progress indication |
| P1 | **Task/list density:** Comfortable / Compact on task table and team/sidebar rows first, not the entire product | **300–540** | 8 | Medium | Only after visual snapshots for narrow windows |
| P1 | **Message timestamps:** Always / On hover or focus (accessible by keyboard); wire existing unused `display.showTimestamps` semantics deliberately | **240–420** | 7 | Medium | Requires consistent behavior across message surfaces |
| P1 | **Sidebar width:** narrow/default/wide or a bounded drag handle with reset | **220–400** | 7 | Medium | Must handle split panes and narrow viewport |
| P2 | **Code wrapping:** Wrap / Horizontal scroll across relevant read-only code blocks | **260–460** | 6 | Medium–high | Requires auditing code viewers and selection behavior |
| P2 | **Syntax highlighting:** On / Off; existing config key is currently not wired to renderers | **380–650** | 5 | High | Avoid until CodeMirror and markdown surfaces are coherently supported |
| P2 | **Accent color presets:** curated accessible shortcuts, with contrast tests in light/dark | **450–850** | 5 | High | Defer; reuse shipped custom-theme palette validation, not a new theme engine |
| Shipped | **Whole-app UI scale/zoom:** existing 70–200% setting | **0 (no new work)** | 6 | Existing behavior | Preserve current Electron/browser zoom and E2E; scope new chat text size separately |

**Estimate conventions:** The first *additional* setting may need ~70–120 LOC of shared preference plumbing only where existing helpers cannot be reused; do not count or rebuild the shipped store, theme editor, typography or zoom controllers. Localizations (~2–5 new strings across 30 locale JSON files) and React/component/E2E tests materially contribute to each range.

## 4. Minimal implementation architecture

```text
AppearanceSection (render only)
  -> existing useAppearancePreferences / appearanceStore (selection + feedback)
    -> existing validated AppearancePreferences type/defaults + bounded new fields
    -> existing renderer-local adapter / agent-teams-appearance-v1
  -> scoped CSS tokens/data attributes for *new* controls

Existing theme: useThemeController -> AppConfig.general.theme (unchanged)
Existing zoom and typography: useAppearanceZoomController / useAppearanceTypographyController (unchanged)
Existing native window title bar: windowControls adapter (Electron only, unchanged)
```

- **SRP:** Each renderer component consumes only the preference relevant to its layout; Appearance presents values and invokes callbacks. No Electron APIs inside common preference domain.
- **DRY:** Reuse the shipped normalizer, appearance store and shared settings controls. Only add bounded fields, localization keys and scoped renderers when an option genuinely needs them; avoid a parallel preference namespace.
- **Dependency direction:** domain type/defaults have no React/DOM/Electron imports; storage implementation depends on browser APIs; UI depends on a small hook. No event bus, new state manager, generic plugin architecture or remote preferences API.
- **Failure behavior:** invalid/unknown values become defaults, and storage exceptions are nonfatal. Failed writes must not update saved preferences or their visible snapshot; the shipped native Electron zoom shortcut is the exception: when persistence fails after native zoom has already changed, `reflectNativeAppearanceZoom` may update the visible zoom as **unpersisted display state** without replacing saved zoom. Keep existing `parseAppearance`, size limits and CSS input sanitization; never reset users' saved themes, font or zoom when adding an option.
- **Server vs client:** personal appearance applies to *this browser/profile*. Label that in UI; don't promise cross-device synchronization. Future account-backed sync is explicitly out of scope.
- **Platform:** macOS, Windows, Linux, desktop and browser use the same portable code. Native title bar remains a separately conditional control supported on Windows/Linux Electron and restart-only; never show it in web UI.

## 5. Rollout and E2E requirements

1. **Small PR A — accessibility first:** selected state on theme choice; tests for mouse, keyboard, screen-reader attributes, and light/dark/system unchanged.
2. **Small PR B — message text:** client-local storage, bounded presets, CSS scoped to chat text; test reload, a second browser client/profile, long messages/code blocks, reduced window sizes and RTL.
3. **Small PR C — motion:** system default and user-reduced variant; test live OS preference updates and representative animated panels. Make loading progress still understandable with motion reduced.
4. **P1 after visual approval:** one display feature per PR. Show desktop + browser screenshots for narrow, typical and wide viewports; preserve selection, scrolling, keyboard focus and persisted choices.
5. Before merge: TypeScript, lint, focused tests, cross-platform build/desktop smoke as applicable, browser E2E (including **regression of shipped zoom, fonts and custom themes**), 30-locale completeness, dark/light contrast and changed UI screenshots. Compare with baseline and fix every actionable reviewer finding. Use the existing CI pipelines, not a new test infrastructure.

## 6. Critical review of the design

**Correctness review:** Putting all preferences in `ConfigManager` would overwrite another client's choice; choose per-client storage instead, keeping theme's existing contract unchanged.

**Accessibility review:** Global animation shutdown would hide spinners/progress feedback and forced normal motion would violate OS preferences. Use scoped motion tokens; reduced motion means visible static progress, not disabled feedback. Hover-only timestamps need focus access.

**Regression review:** Whole-app zoom is **already shipped** and covered by tests; preserve its platform-specific behavior rather than adding another zoom implementation. Any new chat-specific text size must not change native traffic-light geometry, CodeMirror or scroll positions. Untested existing `display` fields are not proof of functioning settings. Use narrow, component-specific implementations, no breaking migration.

## 7. Recommended v1 scope / acceptance criteria

**Recommend**: theme accessibility, *chat-scoped* text size, and motion preference first. Do **not** ship unused `display` toggles or a second global zoom control. Accept when all of these work in both desktop and browser, survive reload, do not change another independent client's local preferences, respect system accessibility settings, keep defaults unchanged, and pass relevant existing E2E checks.

The RFC does not authorize implementing every option. Follow-on feature PRs should remain separate and small; no feature implementation should be merged from this planning PR.

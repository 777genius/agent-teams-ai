# RFC: Portable Appearance settings (v1)

Status: **proposal only**. No runtime behavior changes in this RFC. This document is intentionally separate from [PR #1130](https://github.com/777genius/agent-teams-ai/pull/1130), which creates the dedicated Appearance page.

## 1. Current state and problems

At the PR #1130 code state, Appearance has: theme (Dark / Light / System), expanding AI responses by default, and native title bar on eligible Electron platforms. The renderer theme uses `useThemeController`, while configuration updates pass through the existing shared settings hooks to Electron IPC **or** browser HTTP.

`display.showTimestamps`, `display.compactMode` and `display.syntaxHighlighting` are defined in types, defaults and validation. A repository usage search did **not** find their integration into the actual message/task/code rendering components. Do not surface these keys as functioning toggles until they demonstrably change what users see.

The app provides **29 UI locales**. New user-facing settings need localized labels, explanations and options; this is included in LOC estimates below.

**Data ownership matters:** `ConfigManager` is a backend-wide configuration source. For new *per-client* visual preferences, storing values there would unexpectedly change multiple browser clients or a local desktop view. Preserve the existing stored `general.theme` contract in v1 for backwards compatibility; do not silently migrate it.

## 2. Product decisions

- Keep the page small: **Color**, **Readability**, **Motion**; add **Layout** only when its first real control ships. Desktop-only window settings remain below portable settings and are hidden outside supported environments.
- Prefer a short segmented control (2–3 explicit presets) over sliders, free-form CSS, user-defined pixel values or nested subpages. Every control has one-sentence help text and a predictable default.
- Apply visual changes immediately. Revert the setting on persistence failure and show one clear error. Do not restart for portable settings.
- For new personal visual preferences, use a small, validated, versioned, *renderer-local* preference record (e.g. `localStorage`), with existing default values as fallback. This works in web and desktop without importing Electron into shared logic. Safely handle denied storage and cross-tab `storage` events. No accounts, sync service or migration project in v1.
- Apply presentation through existing React components/CSS variables or `data-*` attributes. Avoid `webContents.setZoomFactor`, global CSS `zoom`, duplicated HTTP/IPC implementations, and OS-dependent branches.
- Do not change team/task data, runtime settings, provider connection behavior or persisted backend config as a side effect of a purely visual option.

## 3. Options and estimated implementation size

**LOC = rough net new/changed production + tests + all 29 locale additions**, not a commitment. Range assumes reuse of existing settings components and no new framework. Estimates are per setting; if implemented together, common preference plumbing is written once, not repeatedly.

| Priority | Setting / proposed values | Estimated LOC | User value (1–10) | Regression risk | Decision |
| --- | --- | ---: | ---: | --- | --- |
| P0 | **Theme control accessibility:** expose selected Dark/Light/System state to assistive tech; keep current behavior | **25–65** | 8 | Low | Do first; no new persisted key or translations |
| P0 | **Chat text size:** Small / Default / Large; scope typography to messages, not entire app or editors | **190–340** | 9 | Low–medium | First new Appearance preference |
| P0 | **Motion:** Follow system / Reduce animations; never force motion when OS requests reduced motion | **220–390** | 9 | Medium | Audit existing animation hotspots and loaders; do not disable progress indication |
| P1 | **Task/list density:** Comfortable / Compact on task table and team/sidebar rows first, not the entire product | **300–540** | 8 | Medium | Only after visual snapshots for narrow windows |
| P1 | **Message timestamps:** Always / On hover or focus (accessible by keyboard); wire existing unused `display.showTimestamps` semantics deliberately | **240–420** | 7 | Medium | Requires consistent behavior across message surfaces |
| P1 | **Sidebar width:** narrow/default/wide or a bounded drag handle with reset | **220–400** | 7 | Medium | Must handle split panes and narrow viewport |
| P2 | **Code wrapping:** Wrap / Horizontal scroll across relevant read-only code blocks | **260–460** | 6 | Medium–high | Requires auditing code viewers and selection behavior |
| P2 | **Syntax highlighting:** On / Off; existing config key is currently not wired to renderers | **380–650** | 5 | High | Avoid until CodeMirror and markdown surfaces are coherently supported |
| P2 | **Accent color:** curated accessible palette with contrast tests in light/dark | **450–850** | 5 | High | Defer; numerous hard-coded semantic colors exist |
| Defer | **Whole-app UI scale/zoom:** presets | **500–900+** | 6 | High | Conflicts with existing Electron traffic-light zoom layout and browser zoom; prefer scoped text size |

**Estimate conventions:** A first new setting includes ~70–120 LOC of shared renderer-local preference plumbing; do not add that cost again to every row. Localizations (~2–5 new strings across 29 locale JSON files) and React/component/E2E tests materially contribute to each range.

## 4. Minimal implementation architecture

```text
AppearanceSection (render only)
  -> useAppearancePreferences (selection + immediate feedback)
    -> validated AppearancePreferences type/defaults
    -> small renderer-local storage adapter
  -> scoped CSS tokens/data attributes in the renderer

Existing theme: useThemeController -> AppConfig.general.theme (unchanged)
Existing native window title bar: windowControls adapter (Electron only, unchanged)
```

- **SRP:** Each renderer component consumes only the preference relevant to its layout; Appearance presents values and invokes callbacks. No Electron APIs inside common preference domain.
- **DRY:** One normalizer, one storage adapter, and one localization namespace for shared controls; reuse existing `SettingRow` and settings input primitives.
- **Dependency direction:** domain type/defaults have no React/DOM/Electron imports; storage implementation depends on browser APIs; UI depends on a small hook. No event bus, new state manager, generic plugin architecture or remote preferences API.
- **Failure behavior:** invalid/unknown values become defaults, storage exceptions are nonfatal, existing theme is not reset, old users keep their layout until explicitly changing preferences.
- **Server vs client:** personal appearance applies to *this browser/profile*. Label that in UI; don't promise cross-device synchronization. Future account-backed sync is explicitly out of scope.
- **Platform:** macOS, Windows, Linux, desktop and browser use the same portable code. Native title bar remains a separately conditional control supported on Windows/Linux Electron and restart-only; never show it in web UI.

## 5. Rollout and E2E requirements

1. **Small PR A — accessibility first:** selected state on theme choice; tests for mouse, keyboard, screen-reader attributes, and light/dark/system unchanged.
2. **Small PR B — message text:** client-local storage, bounded presets, CSS scoped to chat text; test reload, a second browser client/profile, long messages/code blocks, reduced window sizes and RTL.
3. **Small PR C — motion:** system default and user-reduced variant; test live OS preference updates and representative animated panels. Make loading progress still understandable with motion reduced.
4. **P1 after visual approval:** one display feature per PR. Show desktop + browser screenshots for narrow, typical and wide viewports; preserve selection, scrolling, keyboard focus and persisted choices.
5. Before merge: TypeScript, lint, focused tests, cross-platform build/desktop smoke as applicable, browser E2E, 29-locale completeness, dark/light contrast and changed UI screenshots. Compare with baseline and fix every actionable reviewer finding. Use the existing CI pipelines, not a new test infrastructure.

## 6. Critical review of the design

**Correctness review:** Putting all preferences in `ConfigManager` would overwrite another client's choice; choose per-client storage instead, keeping theme's existing contract unchanged.

**Accessibility review:** Global animation shutdown would hide spinners/progress feedback and forced normal motion would violate OS preferences. Use scoped motion tokens; reduced motion means visible static progress, not disabled feedback. Hover-only timestamps need focus access.

**Regression review:** Global UI zoom risks native traffic-light geometry, CodeMirror layout and scroll positions; exclude it from v1. Untested existing `display` fields are not proof of functioning settings. Use narrow, component-specific implementations, no breaking migration.

## 7. Recommended v1 scope / acceptance criteria

**Recommend**: theme accessibility, chat text size, and motion preference first. Do **not** ship unused `display` toggles or global zoom. Accept when all of these work in both desktop and browser, survive reload, do not change another independent client's local preferences, respect system accessibility settings, keep defaults unchanged, and pass relevant existing E2E checks.

The RFC does not authorize implementing every option. Follow-on feature PRs should remain separate and small; no feature implementation should be merged from this planning PR.

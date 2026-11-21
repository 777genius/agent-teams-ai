# UI form conventions

Short rules for forms and dialogs in the renderer, so that every screen reads the same way in the dark and the light theme.

## Field headings

- A heading above an input, select, textarea, slider or similar control uses the primary text color: the `Label` component from `@renderer/components/ui/label`, which already sets `text-[var(--color-text)]`. Do not override its color.
- A plain `<label>` (when `Label` does not fit) gets `text-text`, never `text-text-secondary`, `text-text-muted` or an inline `style={{ color: ... }}`.
- Size may follow the density of the surface (`text-sm` by default, `text-xs` or smaller in compact rows and advanced panels), the color may not.
- Do not mute a heading to mark a field as optional. A field that is optional says so in its text: "Fast mode (optional)". There is no muted "optional" style any more. Fields that are optional by nature and show a default value do not need the marker.

## Secondary text

- Helper text under a field, hints and descriptions are muted and small: `text-xs` (or smaller in compact rows) with `text-[var(--color-text-muted)]` or `text-text-muted`.
- The text next to a checkbox or switch is the option itself, not a field heading. It may be secondary or primary, whatever reads best in its surface.
- Section captions in popovers and filters may be muted: they group options and are not field headings.

## Colors and themes

- Use the theme tokens for text hierarchy (`--color-text`, `--color-text-secondary`, `--color-text-muted`, or the Tailwind aliases `text-text`, `text-text-secondary`, `text-text-muted`). They are defined for both themes in `src/renderer/index.css`.
- Status colors for messages (error, warning, success) are allowed where they carry meaning. Do not use raw palette colors such as `text-slate-300` or `text-gray-500` for text hierarchy: they do not follow the theme.
- Check a new form in both themes before opening a pull request.

## Known exceptions

- The terminal workspace settings panel uses fixed light-on-dark colors because the terminal itself is always dark.
- A few older badges still use raw palette colors (for example the slate badge in `TeamModelSelector`); fix them when you touch that code.

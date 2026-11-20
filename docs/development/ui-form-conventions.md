# UI form conventions

Short rules for forms and dialogs in the renderer, so that every screen reads the same way in the dark and the light theme.

## Field headings

- A heading above an input, select, textarea, slider or similar control uses the primary text color: the `Label` component from `@renderer/components/ui/label`, which already sets `text-[var(--color-text)]`. Do not override its color.
- A plain `<label>` (when `Label` does not fit) gets `text-text`, never `text-text-secondary` or `text-text-muted`.
- Size may follow the density of the surface (`text-sm` by default, `text-xs` or smaller in compact rows), the color may not.
- Do not mute a heading to say that a field is optional. Say it in the text: "Fast mode (optional)". There is no muted "optional" style any more; a field is optional because its label says so.

## Secondary text

- Helper text under a field, hints and descriptions use `text-xs text-[var(--color-text-muted)]` (or `text-text-muted`).
- The text next to a checkbox or switch (the option itself) is not a heading and may use `text-text-secondary`.
- Section captions in popovers and filters may be muted: they group options and are not field headings.

## Colors and themes

- Always use the theme tokens (`--color-text`, `--color-text-secondary`, `--color-text-muted`, or the Tailwind aliases `text-text`, `text-text-secondary`, `text-text-muted`). They are defined for both themes in `src/renderer/index.css`.
- Do not hardcode colors such as `text-slate-300` or `text-gray-500` in forms: they do not follow the theme. Surfaces that are dark by design (for example the terminal workspace) are the only exception.
- Check a new form in both themes before opening a pull request.

## Known exceptions

- The terminal workspace settings panel uses fixed light-on-dark colors because the terminal itself is always dark.
- Option labels of checkboxes and switches stay secondary (see above).

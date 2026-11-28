# PR Monitor package cohort

These are the built, packed public packages from the source commit recorded in
`manifest.json`. The upstream producer checks declarations, independent browser,
Node and Get Modular consumption, and React SSR against this cohort before
packing. This is a local-artifact integration; it does not claim a registry release.

Use the three tarballs together. The workspace override for `@pr-monitor/core`
resolves the unpublished transitive dependency of the GitHub and React packages.
The lockfile records each archive integrity. `@pr-monitor/react` uses the same
exact React/React DOM 19.2.5 cohort as the host, with no embedded React runtime.

To refresh, check out the recorded producer revision (or a reviewed successor),
run its full qualification and `pnpm pack:check`, copy the three resulting
archives, update the source revision and SHA-256 values, and regenerate the
consumer lock with its pinned pnpm version. A frozen consumer installation and
the native PR Monitor scenarios must pass before accepting a replacement.

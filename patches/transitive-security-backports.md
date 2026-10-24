Temporary backports for unpublished security fixes. Package versions remain
`braces@3.0.3` and `http-cache-semantics@4.2.0`. Neither advisory has a published
fixed npm version as of 2026-10-03. Remove each patch, manifest entry and audit
exception together when adopting a fixed release.

- `braces` (MIT): cumulative runtime changes from
  [micromatch/braces#72](https://github.com/micromatch/braces/pull/72), exact head
  `28d440b5dd449dbf1fe6f3506cf94ecca4d02660`. Only the five depth-guard runtime
  files are backported; unrelated unreleased quote parsing changes are excluded.
- `http-cache-semantics` (BSD-2-Clause): cumulative runtime changes from
  [kornelski/http-cache-semantics#60](https://github.com/kornelski/http-cache-semantics/pull/60),
  exact head `11fb104275349bbd84bf21eafd40b18220c29c46`, including its merged Vary
  prerequisite `9fb520be70eff3ff502fe965d9c3265ca2c64e26`. This covers max-stale,
  stale extensions, retention and request/revalidation constraints. The narrower
  PR #58 leaves stale extension and request-matching bypasses.

Original and patched SHA-256 values cover every package runtime file in
`scripts/ci/transitive-security-manifest.json`. The audit gate grants exceptions
only for the exact advisory and package after checking every installed copy,
its real upstream version, these hashes, and fresh-process behavioral probes.
Other HIGH/CRITICAL findings and unrecognized code fail closed. Both pnpm native
patching and npm postinstall use the same shipped source diffs; package licenses
remain present in installed upstream packages.

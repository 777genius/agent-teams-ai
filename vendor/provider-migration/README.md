# Stage 1 provider artifacts

The current Host selects these immutable local inputs:

| Package | SHA-256 |
| --- | --- |
| [Provider implementations, `codex-runtime-mcp-v1`](codex-runtime-mcp-v1/README.md) | `e3a45cde75062840a74ac0b036b0ccc074654adfd5b46bf19e384eb62c34f3f3` |
| Session SPI, `finite-claude-custody-v1` | `2a6e0e2cc61d7513b6de352d5cc7e2dba6ade8749e76fb4558520b1ea99bbf2e` |

Source now lives in [old-provider-implementations](https://github.com/agent-teams-ai/old-provider-implementations),
[draft PR #1](https://github.com/agent-teams-ai/old-provider-implementations/pull/1),
commit `7573a50842c3eeacb473f9d97d40f3ddf6ac0cf9` for the selected provider
archive. It contains 209 regular files, including 206 emitted dist files; the
selected SPI contains 12 regular files, including 10 emitted dist files. Public
names/exports are unchanged. The selected artifact's recorded standalone checks
passed on exact Node24.21.0/26.11.1 with 355 source tests and both packed
consumers on each runtime; the PR remains a draft. The selected delta permits
the explicitly declared runtime MCP HTTP URL to change on Codex cold restore,
preserving the actual native policy and every other compatibility field.

The previous [readonly-probe-metadata-v1](readonly-probe-metadata-v1/README.md)
archive remains immutable at `2aa5d730d6ed8c237b3d94a84ea462c49f773a69b20344e04fa486a99fcfbaae`,
from standalone source `8a5759ec1d33edb29109a2193bc98ee24d7bd064`.

Historical extraction baseline: standalone commit
`7aa779d60cdcefaaaf9cb2526d4434ce1e1aee47` physically extracted agent-runtime
`4e37051ed390da84842eb27535c8e9b07a0364b7`. Its 206 provider and 10 SPI emitted
files matched the then-selected archives. The preserved
[typed-quality-validation-v2](typed-quality-validation-v2/README.md) provider
archive has SHA-256 `dad39edf2f02a23ae68768722b5bba2e7beddf2125ae79d0bacb4e8b303d1dce`;
it is historical provenance, not an additional current input.

These packages install without the old agent-runtime engine, PostgreSQL, its
custody implementation or the Claude fork. Provider source belongs in the
standalone repository; do not edit built files here. Host/Team/Runtime ownership
and Desktop adapters remain in this frontend repository.

The pnpm override binds the unpublished SPI dependency to the selected archive.
Other provider dependencies are resolved in the frontend lockfile. Historical P1
and later captures retain their own provenance in their directories and are not
additional selected inputs. Final candidate qualification still requires the
complete Team/Runtime/Desktop and native E2E path; standalone CI does not replace it.

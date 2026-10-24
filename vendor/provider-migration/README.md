# Stage 1 provider artifacts

The current Host selects these immutable local inputs:

| Package | SHA-256 |
| --- | --- |
| [Provider implementations](typed-quality-validation-v2/README.md) | `dad39edf2f02a23ae68768722b5bba2e7beddf2125ae79d0bacb4e8b303d1dce` |
| Session SPI, `finite-claude-custody-v1` | `2a6e0e2cc61d7513b6de352d5cc7e2dba6ade8749e76fb4558520b1ea99bbf2e` |

Source now lives in [old-provider-implementations](https://github.com/agent-teams-ai/old-provider-implementations),
[draft PR #1](https://github.com/agent-teams-ai/old-provider-implementations/pull/1),
commit `7aa779d60cdcefaaaf9cb2526d4434ce1e1aee47`. This is a physical extraction
from agent-runtime `4e37051ed390da84842eb27535c8e9b07a0364b7`: all 206 provider
and 10 SPI emitted files match the selected archives. Public names/exports are
unchanged. Node24/26 checks and packed consumers passed; the PR remains a draft.

These packages install without the old agent-runtime engine, PostgreSQL, its
custody implementation or the Claude fork. Provider source belongs in the
standalone repository; do not edit built files here. Host/Team/Runtime ownership
and Desktop adapters remain in this frontend repository.

The pnpm override binds the unpublished SPI dependency to the selected archive.
Other provider dependencies are resolved in the frontend lockfile. Historical P1
and later captures retain their own provenance in their directories and are not
additional selected inputs. Final candidate qualification still requires the
complete Team/Runtime/Desktop and native E2E path; standalone CI does not replace it.

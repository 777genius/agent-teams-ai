# Stage 1 provider artifacts

Immutable predecessor packages retained for the original P1 proof.
The current host selects [Claude capabilities v1](claude-capabilities-v1/README.md).
These install without the current agent-runtime engine, PostgreSQL, custody
implementation, or Claude fork. Source algorithms remain owned by the provider
repository; do not edit built files here.

Source checkpoint: `c4235e029d6395cdcb385844ad6046d6f94d3449` in the isolated
`feat/provider-host-contracts` lane (base `7805dbf49d298f21bbb489faa99fe79a1116c17a`).
Later owning-repository fixture-only commits do not change these package bytes.

| Artifact                                           | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `agent-teams-provider-implementations-0.0.0.tgz`   | `93d6ecaf571c3496924cf9c68cc3c2055e1ae4f097fbb62ec132d2a01b06a893` |
| `agent-teams-provider-session-contracts-0.0.0.tgz` | `269f80a74b6d9f42d8018b78948e3178cd09c42c2ecd5441e34d0c7e77cf4151` |

The pnpm override binds the unpublished contracts dependency to these exact bytes.
Provider dependencies are resolved in the frontend lockfile. Final candidate
qualification still requires the complete Team/Runtime/Desktop and native E2E path.

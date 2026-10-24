# Claude idle notification

Immutable provider artifact from the isolated `runtime-provider-legacy-host` worktree.
SHA-256: `c3a303cf9172219565fecc3d78cada36af41d3a878d0518ebd1c61898b44db00`.

All 206 dist members match the owning build. Only `claude-sdk/session.js`
differs from probe admission v1. A complete successful native result for the
current idle session is observational and preserves admission of the next input.
It never fabricates a foreground completion. Active unattributed, failed,
malformed, foreign-session and restore-provenance results remain unavailable.

The regression fails before the fix. Focused lifecycle tests: 15/15 PASS.
Build: `2e9ea081bbe04e522597a2dc309dbd00`; pack: `c230da9c3f30983968d94aea69b34103`.
Session SPI is unchanged. Native/Desktop qualification is separate; previous
archives remain immutable.

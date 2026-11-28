# Claude probe admission

Immutable provider artifact from the isolated `runtime-provider-legacy-host` worktree.
SHA-256: `00b440b4bddc5a3fc3a5cf735b4ead6446ec605cb332db08cc956b07e947aa19`.

All 206 dist members match the owning build. Only `claude-sdk/model-probe.js`
differs from close diagnostics v1: seal new probe input before awaiting owner
cleanup, both before releasing the prompt and immediately before yielding it.
Late metadata or a delayed SDK pull cannot submit after timeout. Original
owner-first abort/EOF/close, budgets, codes and Session SPI remain unchanged.

Both new race cases fail before the fix; current source 12/12 PASS.
Build: `9a1fb4e04ee24b969438c5a7b03ff3f1`; pack: `df0d14c04bb792f9fc5df429080afc7a`.
Native/Desktop qualification is separate; previous archives remain immutable.

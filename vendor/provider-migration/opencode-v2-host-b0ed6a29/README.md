# OpenCode V2 Host provider artifacts

Built and packed from `agent-teams-ai/old-provider-implementations` commit `b0ed6a29ecdfff8bc2695ee1dfdd77071b86f276`, tree `0a141f173d312362710804a0522a65f9fbe52dc8` (PR #5). No generated package files were edited.

- Implementations SHA-256: `27076be24ab9ed0a76bfdc639e88e2906f3daa0e5c86de11de60fb02900082e7`.
- Session contracts SHA-256: `aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db`.

Pinned Node 24.21.0 / pnpm 11.18.0 source check: 489 tests; two packed consumer tests. Real 2.1.4 Session SPI proof includes localhost model, MCP permission reject/once, persistent terminal, interrupt and cold restore with no replay. Native read-only model/provider, plugin and saved-grant inventories stay owner-scoped and expose no provider settings or credentials. Typed native shell exit metadata preserves failed-tool results. Host/Bun/Electron/packaging qualification belongs to this repository and is not implied by the provider archive.

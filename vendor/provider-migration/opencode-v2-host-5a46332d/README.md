# OpenCode V2 Host provider artifacts

Built and packed from `agent-teams-ai/old-provider-implementations` commit `5a46332dab8cbfa88eaf5b269947a924a724ba89`, tree `84d6b20e271f3b5e09bb6382867cc810e5e1fcbb` (PR #5). No generated package files were edited.

- Implementations SHA-256: `cad37e034245ca90a797cc6c3b436a132f35f7da61ba41cef436ac7b0a775d18`.
- Session contracts SHA-256: `aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db`.

Pinned Node 24.21.0 / pnpm 11.18.0 source check: 487 tests; two packed consumer tests. Real 2.1.4 Session SPI proof includes localhost model, MCP permission reject/once, persistent terminal, interrupt and cold restore with no replay. Native read-only plugin and saved-grant inventories stay owner-scoped. Typed native shell exit metadata preserves failed-tool results. Host/Bun/Electron/packaging qualification belongs to this repository and is not implied by the provider archive.

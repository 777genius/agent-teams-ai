# External agent connection

This cross-process feature exposes the running desktop app's existing MCP
supervisor and optional native renderer CDP. It follows the
[feature architecture standard](../../../docs/FEATURE_ARCHITECTURE_STANDARD.md).

- `contracts/index.ts`: live connection identity, DTO, API fragment and IPC channels.
- Root `index.ts`: browser-safe prompt policy and connection types.
- `main/index.ts`: desktop composition, root admission fence, native CDP discovery
  and IPC registration. Electron-specific behavior stays here.
- `preload/index.ts`: typed bridge creation.
- `renderer/index.ts`: connection settings and the team-list prompt action;
  consumers inject the connection API, theme and settings navigation.

The feature does not own another MCP process manager, team writer or runtime
provider. Root/context switching closes HTTP admission, drains admitted work and
rebinds the existing supervisor. Child binding is immutable and controller
requests cannot fall back to another app or data root. Loopback identity is an
expectation contract, not authentication.

CDP startup switches are set before Electron readiness. Discovery identifies the
main renderer through Electron's target ownership API, never window titles.
Saved toggles require restart; disabling a preference cannot revoke an already
open native listener.

Verification covers a real HTTP root fence, the existing supervisor lifecycle,
settings restart states, and controller/MCP HTTP contracts. Packaged CDP and a
native external client additionally need isolated desktop E2E proof. All test
state must use disposable sandbox projects and separate userData/data roots.

The prompt popup persists its task by stable profile/root, displays all four
templates through the shared roster presentation, and reads fresh connection
info for each clipboard write. Its current instructions allow creating drafts
only; edit/trash tools and management result notices remain separate planned
extensions. Copy and opening the popup never mutate or launch a team.

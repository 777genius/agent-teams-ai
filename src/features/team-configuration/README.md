# Team Configuration

Owns the Electron IPC workflows for creating and updating saved team configuration,
reading a saved provisioning request, and deleting an unconfigured draft team.

Public entrypoints:

- `@features/team-configuration` exposes pure runtime-selection validation reused by legacy provisioning and roster flows.
- `@features/team-configuration/contracts` exposes browser-safe IPC channel constants.
- `@features/team-configuration/main` exposes main-process composition and IPC registration.

The input adapter deliberately preserves the existing desktop validation and normalization
semantics. Browser mode currently reports team configuration mutation as unsupported, and
the HTTP route parsers have different compatibility rules, so transport unification is out
of scope for this behavior-preserving extraction.

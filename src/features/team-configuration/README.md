# Team Configuration

Owns the Electron IPC workflows for creating and updating saved team configuration,
reading a saved provisioning request, and deleting an unconfigured draft team.

Public entrypoints:

- `@features/team-configuration` exposes pure runtime-selection validation reused by legacy provisioning and roster flows.
- `@features/team-configuration/contracts` exposes browser-safe IPC channel constants.
- `@features/team-configuration/main` exposes main-process composition and IPC registration.
- `@features/team-configuration/renderer` exposes the Hosted saved-draft editor and CSRF-backed
  `promoteDraft` transport. The editor sends only saved draft identity and revision; a successful
  promotion response confirms Owner admission before the browser enables Launch.

The input adapter preserves Desktop validation and normalization semantics. The legacy generic
browser compatibility path may still report team configuration mutation as unsupported. The
production Hosted editor instead uses its dedicated authenticated HTTP routes and Owner admission
for saved drafts and promotion. Do not infer missing Hosted support from the generic `httpClient`
stub or replace the dedicated route with it. Desktop and Hosted transports remain separate; shared
draft and interaction rules are extracted only where their actual contracts agree.

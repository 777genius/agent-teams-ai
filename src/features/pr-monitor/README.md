# PR Monitor feature

Project-scoped GitHub pull requests in a dedicated desktop tab. This feature is
the Agent Teams host adapter for the reusable `@pr-monitor/*` packages. Public
entrypoints are `contracts`, `main`, `preload`, `renderer`, and the browser-safe
root HTTP client factory.

- `contracts`: validated serializable operations; no token or provider payload.
- `core/application`: repository grants and device authorization through small ports.
- `main/composition`: Get Modular reader construction and native account lifecycle.
- `main/adapters`: existing project resolution, trusted IPC and read-only HTTP.
- `main/infrastructure`: bounded CLI/HTTP requests and private system-keychain vault.
- `preload`: named API bridge.
- `renderer`: context-aware polling and login hooks, reusable list/timeline UI.

Domain models and CI/review/merge logic belong to the library. Credentials remain
in main or GitHub CLI. Get Modular constructs fresh readers per grant; main owns
cancellation, identity and token refresh. Renderer hooks use the shared app API;
UI components use props and public contracts.

See [integration design and verification](../../../docs/plans/pr-monitor-desktop.md)
for setup, permission boundaries, native scenarios and delivery gates. The
repository's PR Monitor ESLint configuration enforces public import restrictions
and core/renderer/preload isolation.

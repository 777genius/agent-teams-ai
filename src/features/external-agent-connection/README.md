# External agent connection

This cross-process feature exposes the running desktop app's existing MCP
supervisor and optional native renderer CDP. It follows the
[feature architecture standard](../../../docs/FEATURE_ARCHITECTURE_STANDARD.md).

- `contracts/index.ts`: live connection identity, DTO, API fragment and IPC channels.
- Root `index.ts`: browser-safe prompt policy, connection types and pure process-local
  MCP environment binding. Node bridge consumers use this entrypoint without
  loading Electron. Desktop composition binds the same core state through the
  compatible main entrypoint; renderer bundles have separate process-local state.
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

The prompt popup persists its task by stable profile/root and shows the final
read-only prompt immediately below the request, with its copy action alongside
the label. Four compact real-world team templates follow through the shared
roster presentation. Fresh connection info is read for each clipboard write;
management instructions expose only wired create/edit/trash capabilities.
Copy and opening the popup never mutate or launch a team. Copy prepares a private,
reference-only stdio handoff through a separate IPC/authenticated HTTP operation;
public connection discovery never exposes credentials or authority selectors. The
MCP bootstrap prunes its own inherited environment before loading the controller,
uses only the management tool profile and resolves the existing private API
reference itself. The external agent must not read configuration or credential
files. A local executor is required, including when using the desktop's HTTP UI.
Successful copies survive dialog closure. Repeated copies reuse the same config;
clipboard failure does not revoke another copied prompt. Context/endpoint changes
retire only this service's exact owned config; any context epoch change requires
copying and registering again. Same-origin token rotation follows the stable API
reference. Removing a config does not revoke a running child: API authority
retirement and the existing context admission fence enforce revocation.

The desktop prompt popup also offers native Codex and Claude Code one-shot runs.
Its optional `directRun` contract is absent in HTTP/browser mode: provider process
execution is deliberately desktop-only. Main reserves one active run before
awaiting readiness, validates current app/root/generation again before spawn,
and builds the final prompt from authoritative templates. Native processes use
a fresh temporary cwd and only this app's per-run MCP configuration. Management
tools permit drafts, stopped configuration edits and reversible Trash; launch,
stop, task execution, built-in shell and file edits are unavailable.

Snapshot polling recovers an existing run when reopening the popup. The snapshot
retains its original task, real elapsed time, bounded redacted output and truthful
process completion status. Provider authentication and custom endpoint policy
remain owned by the existing provider services. Root switches and app shutdown
cancel owned runs. Native CLI compatibility still requires sandbox protocol proof
for the installed binary version; unit lifecycle checks do not replace that proof.

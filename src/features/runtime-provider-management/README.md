# Runtime provider management

Public `contracts`, `main`, `preload` and `renderer` entrypoints preserve the existing
settings workflow. `core/application/RuntimeProviderManagementPort.ts` is the
consumer-owned conversation implemented by the CLI and captured Host adapters.

When a Desktop backend descriptor is selected, app composition supplies
`createCapturedRuntimeProviderManagementClient` exclusively. Its catalog/model
metadata, native setup forms, credential set/forget, OAuth and scoped refresh use the
same captured owner/context/config. A failure never falls back to a fork CLI. Model
catalog entries are untested even when free/connected; model execution is not inferred.
With no descriptor the existing release path remains selected.

Native method indices and supported text/select/conditional prompt metadata are
projected without private native extensions. Unknown prompt semantics disable the
method. Main persists only original OAuth routing/fingerprints before native start;
URLs/instructions/codes/field values never enter this intent journal. Code/cancel
restore that exact selection after restart; replay never starts another login.
Browser authorization stays private and safe progress contains app-owned text.
Native device-code/instruction presentation still needs parity work.

Explicit model tests now use `CapturedModelProbe`: only a completed native probe
can produce available. Group cancellation and context changes retain the original
capture, and a cancellation guard prevents deferred probe admission after lazy Host
startup. Lost responses are not retried against a new owner. Host closes the captured
probe process before publishing completion/cancellation; cold unknown work remains held.

Defaults and model-limit writes now use captured project/global preference roots.
A requested limit pair is applied and observed in the native probe before saving;
ordinary model tests/default verification consume saved limits. Historical v1/v2
fields survive writes and restart. Applying those settings to ordinary new Team
launches still needs integration.

`RuntimeProviderStatusPort` preserves the existing Desktop status conversation.
With a selected descriptor, install readiness comes from the captured Host handshake
and OpenCode model metadata comes from its native catalog. This path bypasses fork
binary discovery, unscoped installer caches and legacy status enrichment. IPC replies
retain original frame/context authority. Catalog presentation has an opaque provenance
stamp so another profile cannot inherit displayed models; it never grants launch or
authentication authority. Finite Codex native account/config/model reads now use
its explicitly selected Host profile and provider-implementations client. They
never create a conversation or infer launch/authentication readiness from a catalog.
Account IPC retains the original sender/context; no global native snapshot is reused.
Claude catalog metadata now uses the public provider library's finite
`readClaudeMetadata` API through a captured `claude` management profile. The Host
owns native process custody and confirms cleanup before responding. Metadata has
its own `claude-sdk` source, bounded account/config matching and foreground fences.
The existing model selector receives canonical launch values and named aliases,
without duplicate options for default/opus. Catalog/credential-source metadata
does not grant authentication, model execution or launch readiness.

This cutover is partial: complete ordinary UI, companion/local-provider management,
Claude authentication/model probes, Codex browser/device login/cancel, and ordinary launch settings require integration. Pending actions return explicit
unavailable responses rather than fabricated success. Global management needs no
fake Team. The backend feature has the private exact-target restore primitive;
The actual Main→Host process E2E covers original OAuth intent persistence and
restart control routing; ordinary Electron UI controls are not qualified by it.

Focused mapping/selection tests and `capturedManagement.safe-e2e.test.ts` live in
`test/features/runtime-provider-management`. The latter traverses real IPC handlers,
Main composition, standalone Host and a separate TEST HTTP process, checks native
credential files, code submit, physical auto cancel, Main restart intent restore,
stale code/context refusal, secret-free journals, explicit model success/cancel and
captured-process shutdown. The separate Host native model proof uses actual OpenCode
with one localhost scripted inference request and confirms no tools/replay. It does
not run Electron UI controls, vendor OAuth, real accounts or model inference.

Finite Codex quota reads share the captured account/config source. An unauthenticated
profile returns no quota; an optional native quota read failure never becomes stale
cached data. Forced token refresh/logout use public D account mechanisms with Host durable
command ownership and Main original intents. The existing Desktop 30s policy is enforced
per actual credential namespace across aliases/restarts; completed logout resets it.
Browser/device login and cancellation remain pending. Actual Electron read-only API proof is separate from ordinary
Task UI proof and does not qualify authenticated vendor access.

Codex account preferences come from Desktop composition; they never change native
auth observations into execution proof. Native named `configProfile` is rejected
before effects because pinned app-server selection is namespace-based. TEST
Electron account API refresh/reuse/logout and Native Host alias/restart proofs
are linked from `docs/plans/provider-migration/evidence/p5-codex-auth-handoff.json`.

# OpenCode runtime policy for Core v1

- Decision: 2026-09-24
- Hosted and Electron runtime: official upstream `anomalyco/opencode`
- Current hosted pin: immutable release `v1.18.32`, tag commit `545f51d26cc39a907d2867492d498d9607ea5fa4`
- Electron package: official npm `opencode-ai` at the current stable release

Core v1 uses official upstream OpenCode for hosted execution and the Electron installer. The hosted
lock pins the six upstream CLI archives and their extracted executable SHA-256 digests. Installation
verifies the archive, executable, and exact `--version` before publishing `current.json`; resolution
rechecks the executable digest. A failed update leaves the prior manifest intact. The official
release is immutable and non-prerelease, but each new upstream version still needs a reviewed lock
update and compatibility verification before use.

Core v1 automatic approval uses the official OpenCode API through the Product and owner approval
boundary. The downstream conditional approval work in `777genius/opencode-anomaly` PR #3/#4 is
deferred for separate manual approval. Those PRs are not a Core v1 release gate and their artifacts
must not enter the official hosted runtime lock or Electron installer. The earlier downstream
`v1.18.4-agentteams.1` pin and its PR #1/#2 evidence are historical, not Core v1 runtime authority.

Electron intentionally resolves the official npm `opencode-ai@latest` when installing. Hosted uses
an exact release pin. Both are upstream, but their versions may differ after a new release until the
hosted compatibility review updates its lock. The tracker must surface that drift; equal versions
across surfaces are not a Core v1 precondition.

The official API does not provide the downstream's atomic conditional permission reply. The owner
must retain its existing authorization and stale-state fences; ambiguous or changed approval state
must fail closed. Any later adoption of the fork requires a separate, explicit decision and a new
reviewed artifact lock. It cannot happen through a version tracker or a fallback path.

The daily upstream tracker compares the official hosted pin with the latest stable upstream release.
A newer release opens a review task; it does not authorize an automatic runtime change.

# OpenCode compatibility A0

This thin slice owns browser-safe contracts and pure generation/negotiation rules.
The root public barrel exports policy/decoders; `contracts` exports DTO types only.
The existing shared OpenCode version helper and main version evaluator consume
this policy. Generic version extraction/comparison and free-tier checks retain
existing behavior.

Only stable V1 >=1.16.0 and <2 can enter the existing capability evaluation.
V2 follows the pinned runtime's contract (`runtime.lock.json` `opencodeV2`, copied
from the runtime release manifest): any exact stable release in its range is
recognized with dialect `v2-<version>`, and `productionEligible` is true only for
versions listed in its qualification records for this platform. `openCodeV2Contract.ts`
is the only policy over that contract (import-free, so Node-run proof and CI scripts
load it too); `pinnedOpenCodeV2Contract.ts` binds it to the lock file and the current
platform. Nothing here lists V2 versions, and a peer's readiness claim never
qualifies a version. Recognition feeds native
discovery (which prefers a qualified binary on PATH) and provider setup; it does not
grant launch capabilities.
No SDK, runtime, permission writer, native CAS, or transport
is implemented here.

Protocol2 is a separate opt-in offer/handshake/operation map. Default envelope1
and legacy bootstrap1/delivery2/fileParts2/ledger1/fingerprint2 stay unchanged.
Decoders bound, detach and deeply freeze JSON data and validate structural
bindings. A decoded identity is data, never proof of a live host or authority.
Negotiation compares externally supplied trusted V1 authority/operation
contracts; compatibility does not grant dispatch rights. Command decoding is
syntax validation; later transport must verify handshake hash, observation,
run/tombstone/watermark, revision and durable operation intent before effects.

Permission DTOs retain once/always/reject, full session/endpoint scope, actual
child/root/parent IDs, binding, lease, revision and operationId. Tests live in
`test/features/opencode-compatibility`; integration limits/check results are in
`.task-output/handoff.md`.

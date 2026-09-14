# P2.R0 identity-foundation architecture and security review

Disposition: ACCEPT

Finding counts: P0 0 / P1 0 / P2 0.

Terminal state: HOLD.

## Reviewer independence and authority

This is an independent architecture/security review of the immutable broker-materialized P2.F0
candidate identified by SHA-256
`659b9eb9286b6c9b40e45e43d9aa9871ddae9d26af903d8296d4db7d64f0094f`. The reviewer did not
produce or repair the candidate and used no subagent or additional reviewer.

The reviewed worktree HEAD is the task's canonical base
`39f98d62089a345c58f10bead0e5610b5c2a0b2d`. It has the single parent
`d5afa87e79b1f2badd69e65262e5699c0fb61de7`, and its commit diff is exactly the 12 router paths
declared by `routerExclusiveOwnership`. The packet revision is `phase-02-jit-router-r1`. The accepted
Phase 1 predecessor handoff and freeze review both record ACCEPT with P0/P1/P2 `0/0/0`.

The mandatory authority was read completely in the prescribed order, followed by the P2.F0 packet
and its six numbered source/test reads. No authority, dependency, packet revision, ownership, or path
mismatch was found.

## Exact reviewed scope

The complete candidate diff against canonical HEAD contains exactly these five P2.F0 writable paths:

1. `src/shared/contracts/hosted/identifiers.ts` — SHA-256
   `73978dd8871f3af363810b9a90b4a42b464982a25898eac082677b9557d1dc41`.
2. `src/shared/contracts/hosted/index.ts` — SHA-256
   `a11b722edd3a9fb1b4ea451bbbf2f01703a93897515092ceefc6bef5157bbac2`.
3. `test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts` — SHA-256
   `7e8b88816245e95921dbcef8c444c572ec2d610cf32dee6d4934a65d33d63b42`.
4. `test/architecture/hosted-web/phase-2/identity/canonical-identifiers.test.ts` — SHA-256
   `19c327b55a2d407c623e8eae6bb60d20913eca60d737499f161d180d212ee511`.
5. `.codex-handoff/phase-02-p2-f0.json` — SHA-256
   `53ce2854cad51ac973775d9d43e5573a6d87e1708ae672dc80d7fda9bb6ade3f`.

The five candidate paths are staged and have no unstaged byte differences. The reviewer has written
only this report and `.codex-handoff/phase-02-p2-r0.json`; the final workspace scope is therefore the
five immutable candidate paths plus exactly two reviewer evidence paths, seven paths total. No
candidate source, test, or producer-handoff byte was altered.

## Architecture and identity gate

1. **Opaque and kind-separated bytes — pass.** `TeamId` and `WorkspaceId` are distinct branded string
   types. Canonical parsers require the kind prefix and exactly 32 lowercase hexadecimal payload
   bytes. The focused type assertion proves compile-time separation; cross-kind values fail at
   runtime. The payload is accepted only as an opaque value and is never decoded or interpreted.
2. **Bounded fail-closed parsing — pass.** Parsing performs a string type check, exact total-length
   check, exact prefix check, and anchored fixed-length payload check. It has no unbounded scan,
   normalization, coercion, truncation, fallback, or exception reflection. Failures expose only the
   static `hosted-contract-canonical-identifier-invalid` diagnostic.
3. **Byte-stable serialization — pass.** Valid canonical TeamId and WorkspaceId values survive JSON
   serialization, parse, canonical reparse, and reserialization byte-for-byte. The parser returns the
   original primitive string bytes.
4. **Negative identity controls — pass.** The focused suite rejects non-strings, empty, short, long,
   uppercase, leading/trailing/embedded whitespace, display-name, slug/name, POSIX path, Windows
   path, traversal-shaped, and opposite-kind values for both ID kinds.
5. **Phase 1 compatibility — pass.** The original actor/session/deployment/boot/request fixtures
   remain unchanged and green. `parseSyntheticTeamId` remains an explicitly named compatibility
   surface for frozen Phase 1 list-contract values; the same synthetic value is rejected by the new
   canonical TeamId parser. The existing Phase 1 team-lifecycle contract continues to import only
   the explicit synthetic parser.
6. **No mutable-data derivation — pass.** Neither production source file accepts, reads, hashes, or
   transforms `teamName`, display name, legacy directory key, `projectPath`, root, registration key,
   or any other mutable name/path into identity. The change only brands and validates caller-supplied
   canonical bytes.
7. **Dependency and process boundaries — pass.** The identifier module has no imports. The shared
   barrel only re-exports browser-safe types and parsers through relative contract paths. There is no
   filesystem, persistence, repository, clock, random generator, crypto allocator, transport, IPC,
   HTTP, Electron, Fastify, main-process, composition, provider, or runtime dependency or side
   effect. This is a bounded value/validation responsibility consistent with Clean Architecture,
   DDD, and SOLID.
8. **Security and private-path safety — pass.** The candidate is five regular ASCII/JSON text files
   with no symlink or binary. Classified scans found no secret, credential, token, cookie, bearer,
   authorization payload, private key, provider payload, private/home/task-temporary path, or real
   project path. The `/srv/...` and `C:\\...` strings in the test are synthetic rejection canaries,
   not observed private paths.
9. **Producer self-review — pass.** The P2.F0 handoff records exact base/revision, five-path scope,
   commands and exit codes, proof levels, positive and named negative cases, explicit unverified
   claims, zero blockers/findings, full Clean Architecture/DDD/SOLID/security/scope self-review, and
   strict `terminalState: HOLD`. It does not claim independent P2.R0 acceptance or integration.

Canonical allocation, uniqueness, entropy and collision handling are intentionally not implemented
by this parser foundation. Restart, rename, remount, persistence, registry and legacy-adoption
stability also remain explicitly unverified for their later owning lanes. These are not P2.F0 gate
failures and no broader behavior is inferred.

## Independent replay

- Focused Vitest command: exit `0`; Vitest 3.2.6; 2/2 files and 36/36 tests passed.
- Exact four-TypeScript-path fast lint: exit `0`; no lint error.
- `pnpm typecheck`: exit `1`; exactly seven diagnostics, all inherited from the frozen Phase 0
  baseline, zero P2.F0-owned and zero new/unexpected diagnostics.
- Exact five-path Prettier check: exit `0`.
- `git diff --check`: exit `0`; because the immutable candidate is staged, the material check
  `git diff --cached --check` also exited `0`.
- Exact ownership/status proof: exit `0`; exactly the five declared P2.F0 paths existed before the
  reviewer outputs.
- Candidate secret/credential scan: exit `0`, two match lines, both the scan command and its benign
  classification in the producer handoff.
- Candidate private-path scan: exit `0`, two match lines, both the scan command and its benign
  classification in the producer handoff.
- Additional high-confidence secret/private-key scan: no match.
- Forbidden-dependency scan of the two product contract files: no match; the mutable-data scan found
  only the compatibility comment's word `legacy`.

The exact inherited typecheck classification is:

1. `test/architecture/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.test.ts:25:8`
   `TS7016` — missing declaration for the Phase 0 `auth-artifacts-spike.mjs` module; implicit `any`.
2. The same file at `66:31`, `TS7031` — binding element `code` implicitly has type `any`.
3. The same file at `117:68`, `TS18046` — `session` is of type `unknown`.
4. The same file at `413:48`, `TS7031` — binding element `operation` implicitly has type `any`.
5. The same file at `733:10`, `TS7031` — binding element `artifactId` implicitly has type `any`.
6. `test/architecture/hosted-web/phase-0/host-primitives/evidence-scanner.test.ts:12:8`
   `TS7016` — missing declaration for the Phase 0 `scan-evidence.mjs` module; implicit `any`.
7. `test/architecture/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.test.ts:162:44`
   `TS2352` — the synthetic `providerBackends.gemini` fixture value does not overlap the accepted
   `RuntimeConfig` union.

All seven file/line/column/code/normalized-message identities match the checked-in inherited
diagnostic record and accepted Phase 1 integration/review evidence. No diagnostic names a P2.F0 or
P2.R0 path.

## Findings, disposition, and HOLD

P0 findings: none.

P1 findings: none.

P2 findings: none.

Every P2.F0 architecture/security gate is proved by the current candidate source, complete diff,
focused replay, baseline classification, scans, and complete producer self-review. The formal
disposition is ACCEPT with zero unresolved P0/P1 findings.

The only next action is `P2.IF.INTEGRATION`, which must reconcile and integrate these accepted bytes
without mutation. This review does not commit, push, integrate, launch a successor, claim remote
equality, or claim Phase 2 milestone acceptance. Terminal state remains HOLD.

# Hosted v1 Runtime and Release Topology

- Status: accepted topology; documentation only
- Applies to: Hosted v1 Product, lifecycle-owner Orchestrator, and OpenCode release composition
- Does not authorize: branch creation, retargeting, merge, tag, build, lock update, release, E2E,
  deployment, or activation

This document records the accepted separation between the legacy desktop release line and the
Hosted v1 release line. It supplements the [Core v1 scope lock](hosted-web-core-v1-scope-lock.md)
and does not change that product scope. Current execution status, ownership, and admission remain
controlled only by the live Hosted execution router. The
[OpenCode downstream policy](hosted-opencode-downstream-policy.md) also remains unchanged.

## Release-line separation

The two product release graphs remain separate:

```text
legacy Product main/dev -> desktop release -> runtime.lock.json v0.0.74

Hosted Product refactor/hosted-web-feature-boundaries
  -> future hosted-lifecycle-owner-runtime.lock.json
  -> immutable Hosted lifecycle-owner artifact
  -> immutable OpenCode artifact lock
  -> atomic immutable Hosted stack manifest
```

- Legacy Product `main`/`dev` and their existing `runtime.lock.json` at v0.0.74 remain the desktop
  release line. Hosted work must not change that lock.
- Hosted Product stays on `refactor/hosted-web-feature-boundaries`. Product PR #503 stays based on
  that branch and must not be retargeted to legacy `main` or `dev`.
- Orchestrator PR #44 and PR #45 are isolated Hosted inputs. Neither may merge into Orchestrator
  legacy `main` or `dev`.
- The target for the Hosted-compatible owner is a protected, temporary Orchestrator branch named
  `release/hosted-v1-compat`, created later from an audited Orchestrator `dev` SHA.
- The Hosted owner requires an explicit Hosted-only build profile and fixed built entry. Its tags
  must not match the ordinary bare `v*` desktop release trigger (for example,
  `hosted-owner-v1.0.0-rc.1`), and its artifacts must publish in a distinct Hosted namespace,
  preferably a digest-pinned OCI image or a dedicated Hosted artifact repository.

This is a target topology, not a record that the compatibility branch, build profile, artifact
namespace, tag, lock, manifest, or release already exists.

## Exact PR #45 integration fact

The exact current Orchestrator PR #45 head is
`fac886d9dd7e85fc3c46c035fb8567446dd8d99f`. It already contains the six activation commits that
were formerly unique to PR #44, through integration commit `77267ef`. Those commits carry the
portable WAL ownership, activatable admission, revocable activation session, retained lease, and
recovery-revocation invariants.

An earlier missing-code report was false: it inspected the stale local PR #45 ref `fbf2f9f`.
Therefore the six commits must not be re-cherry-picked. Before disposition of PR #44, the integrated
invariants must instead be mapped to the exact current PR #45 implementation and re-proved by exact
tests after remediation. PR #44 may be closed as superseded only after that explicit
preserved/superseded mapping is independently accepted.

PR #44 and PR #45 remain draft inputs. PR #45 may be retargeted to `release/hosted-v1-compat` only
after all current review findings are resolved, every integrated PR #44 invariant is mapped and
re-proved without regression, and one exact combined candidate is independently reviewed.

## Artifact and trust boundary

Branch separation prevents accidental release-line mixing, but it is not the security or runtime
boundary. The real boundary is the complete, exact chain:

```text
source commit/tree/tag
  -> reproducibly built artifact and complete entry/closure digests
  -> signed artifact digest, SBOM, and attestation
  -> reviewed lock and signed release pin
  -> protocol and capability digests plus capability negotiation
  -> durable-state compatibility
  -> atomic, immutable stack composition and deployment recipe
```

The legacy `runtime.lock.json` stays unchanged. A separate
`hosted-lifecycle-owner-runtime.lock.json` may be added only on the Hosted Product line later, in a
reviewed implementation slice. The trusted launcher or deployment layer must read that reviewed
lock and materialize the signed release pin; Product code must not self-authorize its owner
artifact.

The Hosted owner lock must bind at least the source commit, tree, and tag; build toolchain; complete
entry and closure digests; artifact or image digest; SBOM and attestation; protocol and capability
digests; durable-state compatibility; and explicit `productionEligible` and temporary-runtime
state. The atomic stack manifest must bind the exact Product, owner, OpenCode, contract, toolchain,
and deployment-recipe identities. No mutable branch name, tag alone, source checkout, or separately
rebuilt equivalent may substitute for those byte and contract bindings.

## Release order

The only accepted release sequence is:

1. Freeze the exact cross-repository schemas and contract digests.
2. Produce independently reviewed Orchestrator owner, OpenCode, and Product candidates from clean,
   exact worktrees.
3. Build, sign, and attest the exact Hosted owner and OpenCode artifacts.
4. Add the exact Hosted-only locks while every production and release eligibility field remains
   `false`.
5. Build the Hosted Product image and an atomic stack manifest that binds Product, owner, OpenCode,
   contracts, toolchains, and the deployment recipe.
6. Run deterministic built-artifact gates.
7. Run exactly one no-fake E2E against a newly created disposable sandbox/test project.
8. Independently accept the retained evidence at the exact candidate heads.
9. Land the owner only on `release/hosted-v1-compat`, promote the already-tested bytes without
   rebuilding, and then land Product PR #503 only on `refactor/hosted-web-feature-boundaries`.
10. Publish the immutable stack manifest, canary it, negotiate capabilities, and only then promote
    it.

Documentation acceptance does not satisfy any step in this sequence. In particular, all
`productionEligible`, `releaseEligible`, and production/release activation states remain `false`
until the built no-fake disposable-sandbox E2E succeeds and its exact retained evidence receives
independent acceptance. Source-mode, fixture-only, mocked-boundary, or unbuilt execution cannot make
the candidates eligible.

## Rollback

Rollback selects the preceding immutable stack manifest, rather than rebuilding or independently
repinning one component. Drain and fence the current lifecycle owner before selecting the prior
stack. Old and new lifecycle owners must never run concurrently.

If the prior composition cannot be selected with its exact signed artifacts, locks, contracts,
state-compatibility declaration, capabilities, and deployment recipe intact, rollback stops rather
than constructing a mixed stack.

## Future Orchestrator replacement

The future Orchestrator replaces the temporary compatibility owner behind the same lifecycle-owner
role, signed capability manifest, UDS/wire contracts, state-transfer policy, and exclusive-owner
fencing. Replacement requires the same conformance gates and built no-fake disposable-sandbox E2E,
followed by independent acceptance.

When those contracts remain stable, migration is an artifact-and-lock repin of the immutable stack,
not a Hosted frontend rewrite. After Hosted v1, the temporary `release/hosted-v1-compat` line is
security/critical-fix-only. It is removed after the replacement passes the same conformance,
built-artifact E2E, and independent-acceptance gates. Until then, its temporary status grants no
exception to the release, ownership, provenance, or eligibility rules.

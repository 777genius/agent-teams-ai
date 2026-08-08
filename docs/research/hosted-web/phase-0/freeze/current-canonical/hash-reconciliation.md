# Phase 0 canonical-byte reconciliation

Accepted freeze candidate: `f4fa24aac9615a4ce10632965a2244a2e11a273e`. Phase start:
`a32f509e6d9bd31ba2135940e336729bf90c3d93`.

The evidence index contains the complete lane-level byte inventory. This projection records the bytes
that changed after the former `c958c872…` predecessor and the accepted cross-cutting authorities. The
verifier re-hashes the worktree byte and every stated `git show <commit>:<path>` byte.

| Concern        | Path                                                                            | Current SHA-256                                                    | Exact byte commit                          | Disposition                                                        |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------ |
| W1 raw locator | `docs/research/hosted-web/phase-0/parity-renderer/legacy-bypass-inventory.json` | `674859e100839256f86869b8a72ddf65153001f399d7ba08ba135fdf22b2d0d5` | `a6bd7a39aebb4d822f57707c96c5e071b2aecb2b` | Narrowly integrated; source-observed proof level unchanged.        |
| W1 scanner     | `scripts/hosted-web/phase-0/parity-renderer/scan-api-and-actions.ts`            | `a91bcbdcf383bb06c07517d12ca4c0985591f66057e0a60bd7388c156dc7ad8b` | `a6bd7a39aebb4d822f57707c96c5e071b2aecb2b` | Pack-relative raw locator integrated.                              |
| W6 authority   | `docs/research/hosted-web/phase-0/auth-artifacts/evidence.json`                 | `082f9deced2bf21b5b15c14f9f8f786198e61eceb52b9007605949f45ebb503a` | `3bc0dfa7c00261785c0c752270cb302a9294e751` | Fail-closed target-image narrowing accepted.                       |
| W6 scan        | `docs/research/hosted-web/phase-0/auth-artifacts/observed-artifact-scan.json`   | `3cf85823fc79522f36520911991a134ee7557cbd715e839137a61e610a54d22f` | `3bc0dfa7c00261785c0c752270cb302a9294e751` | Final image/provider limitations retained as implementation risks. |
| Estimate       | `docs/research/hosted-web/phase-0/estimate-reconciliation/estimate-ledger.json` | `4a499adb3dceab512f9011aef355ded611045b25b72fc0e0c2142a54bb6563f5` | `f4fa24aac9615a4ce10632965a2244a2e11a273e` | Accepted 38,300-62,100 non-terminal v1 range.                      |

| Accepted authority     | Commit                                     | Manifest path                                                | Manifest SHA-256                                                   |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Target-image narrowing | `3bc0dfa7c00261785c0c752270cb302a9294e751` | `.codex-handoff/target-image-decision-h2.json`               | `fa6a5c9a7386eb202fdb247d59c4fa6e30c048f90b73b8148c643c1c2c2e39d8` |
| Final gate             | `63ff349e14e44a83d363ccbcdd756af935555aa9` | `.codex-handoff/final-gate-candidate-reconcile-h4.json`      | `f45033d339fca0f436ab52226aa5528416967f1000f80ee9e42c2caf38d30754` |
| Orchestration          | `1587615c751c3cb12b5078ab4b7264b6e9fd42ad` | `.codex-handoff/orchestration-authority-remediation-h5.json` | `32c0a04bb321bd94f80bddc5e1eb2d749d781c9fb5e9ff85785e2510b1b5e3df` |
| Navigation             | `f32be6a6fcb2da7a47ef3553476430ef8052e19a` | `.codex-handoff/document-navigation-h6.json`                 | `58e025f6dfe691b3151bdc2119955f87e303423910a14375354068f126663bcb` |
| Estimate               | `f4fa24aac9615a4ce10632965a2244a2e11a273e` | `.codex-handoff/estimate-semantics-h6.json`                  | `246dac62c31f015ec3601cfb2cc3a6435bfa6f027aff192f05c9e03b06bf5f16` |

No row adopts the rejected h7 or h8 freeze outputs. No row authorizes work beyond Phase 1 `P1.S0`.

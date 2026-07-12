# Phase 0 W2 provider/runtime evidence

This targeted-a1 canonical-base remediation preserves the independently reviewed corrections for
reciprocal-review findings `R12-X-001`, `R12-W2-001` through `R12-W2-005`, and remediation
findings `R12R-W2-001` through `R12R-W2-004`. Claims remain source-observed at
`c72fd201867b9bcd1ef77d5e0f95ba379adb4fca`; no provider, real project, credential value or private
provider payload was used.

## Corrected evidence

- Four provider identities remain separated from two execution backend families. Anthropic, Codex
  and Gemini share the provisioning CLI primary; OpenCode uses its adapter/bridge lanes.
- All five current OpenCode operations record direction, caller, authority, idempotency, body IDs,
  persisted evidence, route and canonical disposition. The proposed route/auth mapping has an empty
  browser/runtime authority intersection: provider settings/auth use `provider.management.*`, team
  launch/stop/delete use `team.lifecycle.*`, and machine ingress cannot make either class of operator
  decision.
- Environment discovery performs a production-source census across `src/main`, Codex account, and
  member-work-sync paths instead of trusting a per-file allowlist. Every exact key or explicit
  wildcard has its own source class, owner, platform scope, execution-unit IDs,
  provider/backend/version bindings, credential-exposure-set membership, secret class, exact probe,
  child visibility, redaction rule, and source-observed/target-unverified status. Windows-only and
  POSIX-primary inputs resolve through separate profiles instead of inheriting a broad portable-row
  classification. Host-only OpenCode policy inputs are distinct from derived or emitted child keys:
  for example, `CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE` is forbidden in the child while the optional
  `OPENCODE_DISABLE_AUTOUPDATE` child key is derived from it. The ten conditional provider-routing
  keys are excluded from the authored expectation table: focused tests execute the real
  provisioning, configured-backend and provider-routing branches across seven provider/backend
  scenarios, then compare their required/optional/forbidden and emit/preserve/remove observations
  with seven distinct ledger profiles. The remaining keys use the independent source-authority
  fixture. Dimension mutations and any omitted key fail. Exposure sets link back to exact per-key
  IDs rather than broad execution-unit prose.
- Six artifact-specific draft-2020-12 schemas require nested acceptance fields and reject unknown
  top-level and nested properties. Provider-assigned profiles require nonempty `providerBindings`;
  the sole providerless target prohibition is explicit and separately constrained. Deliberate
  negatives reject an empty assigned binding and an implicit providerless case.
- The provider matrix binds all 13 required cases to independently addressable positive and
  failing-negative tests. Those 26 tests import and execute canonical planner, provider-preflight,
  OpenCode adapter, capability-response parser and stale-lane recovery seams; no W2-local truth-table
  executor remains. The malformed-capability case sends invalid OpenAPI JSON through the real
  detector and compares it with a complete valid OpenAPI control. The
  repository scanner launches the focused proof suite, verifies every exact test ID passed, and pins
  each case to its canonical source export, so arbitrary prose or an arbitrary existing file cannot
  count as proof. Provider/mode dispositions are derived from execution-topology provider/mode rows and the
  current ingress inventory: four OpenCode modes have the five source-observed OpenCode operations,
  while Anthropic, Codex, and Gemini primary modes explicitly have no current runtime-ingress path.
  No target-unverified Cartesian product is described as supported.
- W2 contributes a 4.3k-6.75k net range only to canonical `EST-LIFECYCLE-RUNTIME`. W4 exclusively owns
  lease, workspace guard, process anchor and native/final-image probes; the controller must replace,
  not add to, the existing canonical range.

## Target-unverified boundaries

The proposed ADR-14 route/auth split is proved disjoint as a contract, but `/api/hosted/v1`,
`/api/runtime/v1`, the ADR-30 relay and lane credential do not exist at the phase-start SHA. Final-image
provider conformance, credential canaries, externally owned process adoption, and final-image
secondary-lane recovery remain Phase 1 or final-shape prerequisites; the deterministic Phase 0
contract fixtures do not claim those final-image probes ran.

## Reproduction

```text
node --experimental-strip-types scripts/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.ts
pnpm exec vitest run test/architecture/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.test.ts test/architecture/hosted-web/phase-0/provider-runtime/fake-runtime-seams.test.ts
pnpm lint:fast:files -- scripts/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.ts test/architecture/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.test.ts test/architecture/hosted-web/phase-0/provider-runtime/fake-runtime-seams.test.ts
pnpm exec prettier --check .codex-handoff/phase-00-w2.json docs/research/hosted-web/phase-0/provider-runtime scripts/hosted-web/phase-0/provider-runtime test/architecture/hosted-web/phase-0/provider-runtime
```

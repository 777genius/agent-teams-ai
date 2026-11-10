# Desktop native tooling: explicit qualification pilot

Base: `777genius/agent-teams-ai` commit
`09da62897b0ec4b19e77df2b9eb875dadfaba431`, tree
`3e28915ea4740a6e77cd3fc47defa93ceb2236c0`.
The three hosted repairs are an explicit native pilot, nested native config
isolation, and exact native diagnostic identity assertions. All existing full
and fast ESLint enforcement remains authoritative. No default script, hook,
CI, existing compiler scope or product source is changed.

Root integration is the additive proposal in
[native-tooling-root-fragments.json](native-tooling-root-fragments.json): pinned
native dependency/platform closure, lock entries, scripts and a separate strict
tooling compiler project. Root owns package/lock integration and final CI.
Pending PR #875 and other owners' ESLint/CI changes remain outside this patch.
The manifest preserves lint-staged and proposes no ESLint rule removals.

After Root integrates the proposed dependencies, these are explicit commands:

```sh
pnpm run lint:native:candidate
pnpm run format:native:check -- src/renderer/components/Example.tsx
pnpm run format:native:proposal -- src/renderer/components/Example.tsx
pnpm run typecheck:native:tooling
pnpm run test:native:parity
pnpm run test:native:retained
```

`test/native-tool-parity/nativeToolParity.pilot.ts` is selected only by
`scripts/local-checks/vitest.native-parity.config.ts`. No default-discovered
`nativeToolParity.test.ts` is added. Missing local oxlint/oxfmt prerequisites
make the explicit pilot fail with installation guidance. Ordinary discovery
and ordinary tests do not need those optional packages. The separate retained
policy audit keeps inherited fallback failures visible; it is never silently
made part of a passing native result.

## Native lint and retained enforcement

The pilot asserts observed `diagnostics.code`, severity, filename and exact
span, rather than inferring coverage from exit status or diagnostic counts.
Rejecting and valid controls exercise `eslint(no-var)`,
`eslint(prefer-const)` and `eslint(eqeqeq)`; the unused binding warning is
actually reported as `eslint(no-unused-vars)`. A real prefer-const diagnostic
has the same count and severity as a no-var diagnostic, and the no-var oracle
rejects it. Independent scope controls cover main, preload, renderer, shared,
feature domain and feature UI. Warning diagnostics retain exit zero.

Every material rule/plugin fallback remains in the existing ESLint configs:
architecture boundaries, restricted imports, unresolved imports and cycles,
comment directives, import/export sorting, Tailwind, React/Hooks/Refresh,
accessibility, typed promises/unsafe rules, Sonar and security rules. The audit
captures installed full and fast effective configurations in sixteen scopes
and preserves all 35 policy assertions and all 33 lint fixture subjects.
Native syntax overlap does not replace typed ESLint or compilation.

Actual retained-policy qualification finds three inherited gaps: the renderer
import into main emits no expected boundary warning, the TypeScript cycle
emits no expected `import/no-cycle`, and unused suppression emits a core
warning with null rule identity rather than the asserted plugin error. The
same audit fails on the native-free baseline and the candidate. These are
FAIL/HOLD for broader parity, not successful rejecting replacement evidence.
No enforcement was removed to hide them; Root owns any separate policy fix.

## Formatter behavior

The helper requires explicit existing eligible `src` paths, rejects symlinks
and escapes, and emits either check status or a JSON proposal with input,
configuration and resolved-options hashes. It never writes the input. A
proposal must be reviewed against those bytes before application; hashes are
not a concurrent-writer guarantee. Current ignores, scalar Prettier options,
JSON/JSONC trailing-comma overrides, Markdown prose behavior and Tailwind v3
custom theme/plugins are preserved. Native import and package-key sorting are
explicitly disabled.

Native invocations use the supported `--disable-nested-config` option and an
explicit approved config. The adversarial test puts a conflicting native
config in a nested source directory. Native file autodiscovery actually adopts
its double quotes/no-semicolon profile; disabling nested discovery restores
the approved root profile. The helper proposal matches that root profile and
leaves exact input bytes unchanged. Oxfmt 0.72.0 already isolates explicit
config/stdin invocations; this test does not claim the previous explicit-config
stdin command reproduced a nested override vulnerability.

Semantic controls compare TypeScript 5.9.3 emission in a disposable VM,
exports, import side-effect order and comments; parsed JSON/JSONC values and
key order; CSS declarations; Markdown prose/fenced code; Tailwind class sets
and exact installed Prettier output; and formatting idempotence. Later
matching overrides are exercised independently. Explicit ignored native
paths return exit 2 with the installed tool's exclusion diagnostic and remain
unchanged. Resolved user plugins or unsupported options use installed
Prettier; plugin-load errors propagate. Check and proposal paths preserve
input bytes for both native and fallback routes.

All eight existing TS7 invocations, nested tool projects, native7 alias
`npm:typescript@7.0.2`, and legacy API TypeScript 5.9.3 scopes remain intact.
The new strict compiler project checks only additional helper/harness paths.
An injected disposable type mismatch produces TS2322 before restoration and
a successful strict check; no production testing hook is introduced.

## Actual hosted evidence and limits

Owned canonical Node 26.10.0 and pnpm 11.22.0 start successfully after primary
release/checksum metadata verification. Native pins are oxlint 1.87.0 and
Oxfmt 0.72.0, verified against current primary registry metadata before their
installation. HOME and CODEX_HOME are never reassigned. Tools, caches, TMPDIR,
disposable source and raw evidence reside in unique job-owned scratch
directories, outside the delivered product tree.
All captured commands are created with NO_COLOR=1, FORCE_COLOR=0 and TERM=dumb;
original output bytes are retained without control stripping.

The native-free frozen baseline install succeeds with lifecycle scripts
disabled. Four safe ordinary default-discovered suites pass (26 tests), and
ordinary discovery retains the same 1,795-suite membership. All eight existing
compiler scopes pass. This is not a claim that all ordinary suites or full CI
ran. No app, service, product smoke, provisioning, build or release is run.

The canonical Root candidate is a standalone checkout with only the reviewed
additive dependency, script and lock fragments. Its original manifest ranges
remain unchanged: pnpm 11.22.0 `--frozen-lockfile --ignore-scripts` succeeds
without normalization. All 2,215 installed baseline package identities are
retained; only oxlint, oxfmt and their two Linux bindings are added.

On this exact composition, all eight existing compiler scopes, the strict
tooling project, owned fast lint and all 14 native/formatter tests pass.
Ordinary discovery still selects exactly the same 1,795 files and excludes
the opt-in pilot. Earlier exact-source missing-native, wrong-diagnostic and
TS2322 controls retain their expected RED results. This evidence does not
claim a full ordinary suite or final CI run.

The exact final retained-audit source runs against unchanged baseline
ESLint/tsconfig and the canonical candidate using the same inherited
installed dependency closure. Both controls report 32 PASS / 3 FAIL, with
only the three inherited gaps above and no additional timeout. Broader
fallback parity and default adoption remain HOLD; no rule is weakened to
turn those failures green.

The delivery PR's validation record binds the exact base, manifest, lock,
source hashes, HOST command exits and final CI runs. Original raw HOST logs
and losslessly reconstructed checkpoint evidence are retained by the
operator outside the product repository; administrative handoff and proof
manifests are not shipped as product files. Binary tool distributions remain
on owned scratch for separate retrieval.

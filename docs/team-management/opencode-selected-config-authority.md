# OpenCode Selected-Config Authority: Incident Context and Durable-Fix Options

**Status:** historical incident and design exploration from the `v0.0.83` / app `v2.13.1` hotfix. The accepted positive launch contract is implemented in runtime `v0.0.84` ([PR #68](https://github.com/777genius/agent_teams_orchestrator/pull/68), commit `b567c93a3f424e5d23301cbce5f6f7ade8273c18`). App [v2.13.2](https://github.com/777genius/agent-teams-ai/releases/tag/v2.13.2) is published; Linux recovery and updater verification passed.

**Current decision:** the calibration-first recommendations in sections 9 and 13 are superseded by the [accepted launch contract plan](opencode-launch-authority-contract-plan.md). It keeps an explicit supported-provider contract and checks effective permission order through `/agent`, without a production calibration host or persisted T0 baseline. The observations, alternatives and verification statements below describe the earlier hotfix investigation; current delivery evidence and outstanding acceptance are recorded at the end of the plan.

**Audience:** an engineer or agent reviewing the incident and the alternatives considered before the accepted fix. This document is written to be self-contained: it explains the incident, the exact mechanics, everything that was verified empirically, the shipped hotfix and why it is deliberately tactical, every design option that was considered (including the ones rejected and *why*), and the traps waiting in each one.

**Where the code lives:** the affected code is in the **private runtime repo** `777genius/agent_teams_orchestrator`, not in this frontend repo. The frontend only pins the runtime through `runtime.lock.json` and surfaces the resulting error text. This document lives here because `docs/team-management/` is the canonical home for Agent Teams runtime knowledge.

---

## 1. The incident

### What users reported

After upgrading to app `v2.13.0`, **every** team containing an OpenCode member failed at the readiness gate before anything spawned. Reported on Windows 11, OpenCode runtime 1.18.29, provider Z.AI Coding Plan (`zai-coding-plan`, GLM models):

```text
glm-5.3-flash - Selected model check failed: OpenCode readiness bridge failed:
provider_error: OpenCode selected readiness host/config/auth/project/MCP authority
is unavailable (selected_config_match:provider)
```

Launch trace:

```text
[validating] Validating OpenCode team launch gate
[spawning]   Starting OpenCode sessions through runtime adapter
[failed]     OpenCode team launch failed readiness gate - configReady=true
```

This blocked both all-OpenCode teams and mixed teams with an Anthropic lead (which worked on `v2.12.0`). It was a hard downgrade for OpenCode users.

### What the reporter had already ruled out (all correct)

- **Not stale retained fingerprints.** They fully cleared state: stopped app and OpenCode processes, deleted `%APPDATA%\agent-teams-ai\opencode-bridge`, `data\cache`, and every team's `launch-state` / `launch-failure-artifacts` / `.opencode-runtime`. An earlier "retained host/profile fingerprint mismatch" error disappeared and was replaced by this one.
- **Not a host-registry mismatch.** After the failure, `host-registry.json` showed `managedConfigFingerprint == resolvedConfigFingerprint` on every registered host, yet the gate still failed. Their inference — that `selected_config_match:provider` compares against some *other* authority than the host registry — was exactly right.
- **Not missing provider auth.** `opencode models zai-coding-plan` returned all 11 models instantly and `auth.json` contained `zai-coding-plan` credentials. Anthropic members in the same team passed their own model checks.
- **Not team config.** Identical failure for a fresh team and for teams that worked the day before.

They also asked whether this was a regression from the watermark fix `44390ec`. **It was not** — that commit (`fix(opencode): allow stop with stale runtime watermark`) touches the stop path and is unrelated.

---

## 2. Root cause

### The mechanism, precisely

`refreshSelectedProfileAuthority()` in
`src/services/opencode/OpenCodeSelectedProfileAuthority.ts` is a strict, fail-closed readiness check. It compares a projection of **twelve** config fields between two sides:

```ts
const SELECTED_CONFIG_FIELDS = ['provider', 'model', 'small_model', 'plugin', 'agent',
  'default_agent', 'permission', 'command', 'share', 'snapshot', 'autoupdate', 'mcp'] as const
```

- **Side A — the prediction:** `profile.managedConfig`, the config the app assembled and handed to the OpenCode server via the `OPENCODE_CONFIG_CONTENT` environment variable (see `OpenCodeProfileManager.ts`, the `env` block that sets `OPENCODE_CONFIG_CONTENT: JSON.stringify(managedConfig)`).
- **Side B — reality:** the response of `GET /config` from the live OpenCode host.

If the two fingerprints differ, the check rejects with `{ check: 'selected_config_match', fields: [...] }`, and `OpenCodeBridgeCommandHandler.ts` turns that into the user-visible `... authority is unavailable (selected_config_match:provider)`.

**The flaw:** between side A and side B sits an opaque transformation. OpenCode merges our config with the user's and the project's config, runs the result through its Zod schema, adds defaults, and **silently drops any field its schema does not know**. Side A is a *prediction* of that transformation's output; side B is the output. Every mismatch between our prediction and OpenCode's actual normalization is a false rejection.

### The specific trigger

The curated catalog in `src/services/opencode/OpenCodeCuratedSubscriptionCatalog.ts` sets `structured_output: true` on **5 of the 7** `ZAI_CODING_PLAN_MODELS` (`glm-5.2`, `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.5-air`). OpenCode's config schema does not know `structured_output`, so `GET /config` returns those model entries **without** it, byte-identical otherwise.

Result: for `zai-coding-plan` the `provider` block could never match. Since the diagnostic lists exactly the fields that differ, the user saw `selected_config_match:provider` and nothing else — the other eleven fields matched fine.

**Deterministic and total:** it fails 100% of launches for that provider, on any OpenCode version, regardless of state resets. `structured_output` appears nowhere else in the catalog, so other curated providers (MiniMax, Kimi, Xiaomi, Kiro, Cursor) were unaffected.

### Why the release pipeline missed it

The check was introduced in runtime `v0.0.82` (PR #52, the mixed-provider e2e work of 2026-08-31). That e2e ran its live OpenCode leg on `opencode/big-pickle` — a **non-curated** provider. For a non-curated provider the managed `provider` block is empty (`{ [providerId]: null }` on both sides), so the comparison passes trivially. The Z.AI path — the one with a large managed provider block — was never exercised live. The same e2e report notes that its OpenAI route failed with a 401 and was explicitly *not* counted as verified.

App `v2.12.0` pinned runtime `v0.0.73`, which predates the check entirely. `v2.13.0` pinned `v0.0.82`. That version jump is the whole regression.

---

## 3. Empirical evidence (all reproduced live, not inferred)

Everything below was measured, not reasoned about. Reproduce it the same way if you need to re-establish trust.

### 3.1 OpenCode drops the field — on both versions

Started an isolated `opencode serve` (empty `HOME`/`XDG_*`, `OPENCODE_CONFIG_CONTENT` = the exact curated Z.AI managed block) and diffed the sent config against `GET /config`:

- **1.18.29** (the reporter's version, installed from npm): provider blocks differ; the diff is exactly `structured_output` missing on 5 models; everything else identical.
- **1.18.4** (the locally installed version): identical behavior.

Conclusion: not version-specific. Applying the same field-strip to both sides made the blocks compare equal.

### 3.2 The published schema confirms it

`https://opencode.ai/config.json` returns HTTP 200 (~39 KB) and **does not contain** `structured_output`. So the schema is a faithful oracle for "which fields the server will keep" — relevant to Option C below.

### 3.3 A/B in the real app (`pnpm dev:mcp`)

Isolated data roots, frontend worktree at clean `origin/main`, same sandbox project, same key:

| Run | Runtime | Result on `glm-5.3-flash` |
|---|---|---|
| A | stock `v0.0.82` | `selected_config_match:provider` — bug reproduced |
| B | build with the fix | error gone; readiness proceeds to a real `401 Authentication Failed` |

### 3.4 The remaining 401 is genuinely the provider's

A direct HTTPS request to `api.z.ai/api/coding/paas/v4/chat/completions` with the user's stored key, bypassing the app entirely, returned `401 {"error":{"code":"1000","message":"Authentication Failed"}}`. The user's Z.AI subscription had lapsed. **This is not our defect**, and it is why an end-to-end successful launch *on Z.AI specifically* remains unverified.

### 3.5 Full launch works after the fix

On a working OpenCode provider (OpenRouter, `qwen/qwen3-coder-flash`): preflight reported "Selected model verified", and the team launched with `launchPhase: finished`, `teamLaunchState: clean_success`, 2/2 members confirmed, 0 failures. Repeated on the *packaged* `v2.13.1` build installed in `/Applications` (see §5).

### 3.6 The config text does not describe the effective runtime

Two measurements that reframe the whole problem — see §7:

- `GET /config/providers` returned **11 models** for `zai-coding-plan` while the managed config declared **7**. The server merged the remote models.dev catalog on top. The UI shows 11, matching what the reporter saw.
- `GET /agent` returns permissions in an **expanded rule form** — `[{permission, pattern, action}, ...]` — whereas the config expresses them as a map like `{'*': 'deny', 'agent-teams_*': 'allow'}`. The shapes are not comparable at all.

---

## 4. The shipped hotfix

Commit `49d44c33` (PR #66), released as runtime `v0.0.83` → app `v2.13.1`.

In `OpenCodeSelectedProfileAuthority.ts`:

```ts
// OpenCode's config schema silently drops model fields it does not know when it
// serves GET /config (verified on 1.18.4 and 1.18.29), so managed catalog
// metadata carrying them can never match the live config. Strip the same fields
// from both sides; every field OpenCode actually keeps still fails closed.
const CONFIG_DROPPED_MODEL_FIELDS = ['structured_output'] as const

function normalizeSelectedProviderModels(provider: unknown): unknown { /* ... */ }
```

applied symmetrically inside `selectedConfig()` to the selected provider's `models` map. 24 lines of production code, 21 lines of test.

**Test coverage:** the existing integration test in `OpenCodeProvisioningProbe.test.ts` (`refreshes selected config/project/auth/MCP authority and fails closed on each mutation`) gained a model carrying `structured_output` in its fixture, a positive case (live without the field still passes) and a negative case (mutating a model `limit` still rejects with `selected_config_match:provider`). Verified that removing the normalization makes the new positive case fail, so the regression is genuinely covered.

**Test suites run green:** ProvisioningProbe + BridgeCommandHandler (214), SelectedSessionAuthority + ProfileManager + SessionStore + CuratedSubscriptionCatalog (119), SessionBridge (75).

---

## 5. Release verification (what the packaged build actually proved)

The `v2.13.1` DMG was downloaded from the draft release, digest-verified against GitHub, signature and notarization checked (`accepted / Notarized Developer ID`), installed into `/Applications`, and launched on the **standard** profile (no `--user-data-dir` override; only `--remote-debugging-port` for automation, removed afterwards).

On that packaged build:

- Selecting Z.AI `glm-5.3-flash`: the `selected_config_match:provider` failure is **gone**; the only remaining blocker is the genuine `Authentication Failed`.
- OpenCode-only team: `clean_success`, 2/2 members.
- Mixed team (Anthropic Opus 4.8 lead + OpenCode `qwen/qwen3-coder-flash` member + Anthropic member): "Team launched - all 2 teammates joined", Running, OpenCode lanes created.

The release then went out through the supported path (`publish_release=true` + `reuse_existing_draft_assets=true`) and `scripts/ci/verify-published-updater-release.sh` returned *"v2.13.1 is public, latest, and updater-ready"*.

---

## 6. Why the hotfix is tactical, and must not be treated as the solution

`CONFIG_DROPPED_MODEL_FIELDS` is a hardcoded list of fields that a **third party's schema** happens to discard. It grows whenever upstream OpenCode changes, and nothing in our CI can predict that. It is the *third* compensation of this exact class already living in that one file:

1. `normalizeSelectedAgentDefaults()` — "OpenCode 1.18.4 ConfigV1 agent.normalize adds empty options."
2. `command: config.command === undefined ? {} : config.command` — "Config.load initializes absent commands to an empty map."
3. `normalizeSelectedProviderModels()` — this incident.

Three independent patches for the same underlying mistake is the signal that the design, not the list, is wrong. The next upstream release can add a fourth, and the failure mode is *total launch blockage for a provider*, discovered by users rather than by tests.

---

## 7. The deeper problem: we compare the wrong thing

The check exists to guarantee a **behavioral** property: *the runtime is operating with the provider, model, permissions, and MCP transport we specified, and that has not changed.*

It implements that guarantee as **textual comparison of a config document**. That proxy is wrong in two independent ways:

1. **It is brittle** against a normalization we neither control nor can predict — the incident above.
2. **It is not even sufficient.** The config text does not determine behavior: `GET /config/providers` reported 11 usable models where our config declared 7, because the server merges a remote catalog. And `GET /agent` reports the *effective* permissions in a different shape than the config expresses them. So the thing we compare is neither stable nor complete.

Any durable fix must start by choosing a better comparison target, not by getting better at predicting the transformation.

---

## 8. Options considered

Notation: `T` = OpenCode's opaque transformation; `managed` = the config we send; `user`/`project` = the user's and project's own OpenCode configs, which are **deliberately** merged in (there is an explicit comment in `OpenCodeProfileManager.ts` about keeping project/global plugin config untouched, and `readSafeOpenCodeRuntimeConfigImport()` merges `~/.config/opencode/opencode.json`, the XDG variant, and `OPENCODE_CONFIG_CONTENT`). So in general:

```text
live = T(managed ⊕ user ⊕ project)
```

### Option A — Directional (subset) comparison + explicit critical-field assertions

**Idea:** stop requiring equality. For every path we set in `managed`, require a match **only if that path exists in `live`**. A path absent from `live` means OpenCode does not know it, therefore it cannot affect behavior. Separately, require *presence* of the fields that carry our safety guarantees (`permission`, `mcp`, the selected `provider`, `model`, `agent`), so a silently-dropped critical field is a hard failure.

**Why it is not "just another hardcoded list":** the list of *critical* fields is derived from our own security model. It changes when we change our requirements. The list of *dropped* fields is derived from upstream's Zod schema and changes on their release cadence. We control the first; we do not control the second. This distinction is the crux of the whole redesign — do not let a reviewer collapse the two.

**Trap:** a field can vanish because it was *invalid*, not because it was unknown. If `permission` disappears that way, the teammate silently gets broader defaults. Hence the mandatory-presence rule above; without it this option is a security regression, not an improvement.

**Effort:** ~40–60 lines of production code plus tests. **Reliability 9/10, confidence 8/10.**

### Option B — Live baseline for subsequent re-checks

**Idea:** stop predicting anything on re-checks. Snapshot the effective state once, at host start, after the start-time validation has passed. Every later `refreshSelectedProfileAuthority()` compares "reality at T0" against "reality at T1". Both sides are responses from the same server, so every normalization quirk — present and future — cancels out exactly.

**What it catches:** any drift after launch, including drift in fields nobody thought to assert.

**What it does NOT catch — the trap that makes this insufficient alone:** if the server started with the *wrong* config (our `OPENCODE_CONFIG_CONTENT` never applied, the user's config won, MCP or permissions substituted), the baseline records that wrong state as the reference and cheerfully confirms it forever. Baseline proves *"nothing changed"*, never *"we started correctly"*. It is a complement to A, never a replacement.

**Implementation weight:** the baseline must be **persisted in `host-registry.json`**, otherwise an adopted persistent host after an app restart has nothing to compare against. That means serialization, record validation, and a registry format migration — this is where the cost is, not in the comparison itself.

**Reliability 7/10 alone, 9/10 combined with A; confidence 9/10.**

### Option C — Use the published JSON Schema as the oracle

**Idea:** fetch `https://opencode.ai/config.json` and compute programmatically which fields will be discarded, instead of listing them.

**Verified:** the schema is reachable (HTTP 200, ~39 KB) and genuinely lacks `structured_output`, so it *would* have predicted this incident.

**Why it is not recommended as the foundation:** it introduces a network dependency in a launch-critical path; the published schema can drift from the actually-installed OpenCode binary's behavior (schema ≠ runtime); and it still leaves us in the business of predicting `T` rather than escaping it. Reasonable as a **test-time** source (e.g. a CI check that flags catalog fields the schema does not know), not as a runtime authority.

**Reliability 5/10, confidence 6/10.**

### Option D — Calibration probe: measure `T` instead of predicting it

**Idea, and the strongest answer to "how do we do this with no hardcoded fields at all":** don't describe the normalization — *observe* it. Once per `(binary identity × managed-config hash)`, start OpenCode in **full isolation** (empty `HOME`/`XDG_*`, only our config on the input) and capture `GET /config`. That response is `T(managed)`: the canonical form of *our* config as seen by *this* version of OpenCode. Cache it keyed by that pair.

Then compare `live` against `T(managed)` rather than against `managed`. Both sides have been through the same transformation, so every quirk cancels — including quirks that do not exist yet.

**Feasibility is proven:** this is literally how the incident was diagnosed. Standing up an isolated `opencode serve` and reading `/config` took a couple of seconds per version.

**Traps:**
- The isolation must be *real*. If the calibration run can see the user's `~/.config/opencode/opencode.json` or an `XDG_CONFIG_HOME` leak, the user's settings get baked into the "canonical" reference and the check silently becomes meaningless.
- The cache key must include the binary identity (there is already `resolveOpenCodeBinaryHostIdentity()` used for host keys) *and* the managed-config hash. Invalidation bugs here degrade to either constant re-probing (slow launches) or a stale reference (wrong verdicts).
- Equality still will not hold against a real host, because the real host also merges `user ⊕ project`. So the comparison against a real `live` is still directional (`T(managed) ⊆ live`), and the strictness for critical fields still comes from Option A.

**Reliability 9/10, confidence 8/10.** Cost: one short extra server start per configuration, amortized by the cache.

### Option E — Fully isolate the launch profile (stop merging user/project config)

**Idea:** run launch hosts with no user or project OpenCode config at all. Then `live == T(managed)` exactly, calibration becomes a clean equality check, and Option A's directional logic mostly disappears.

**Why it is a product decision, not a technical one:** the merge is deliberate. Users' plugins, custom providers, and project-level OpenCode settings would stop applying to Agent Teams launches. Do not adopt this without an explicit product call.

**Reliability 9/10 technically, confidence 6/10 overall because of the product risk.**

### Option F — Keep the hotfix and do nothing else

Works today, blocks nothing, and is honestly a defensible short-term position. But a fourth compensation is a matter of time, and the failure mode is user-visible total blockage of a provider.

**Reliability 6/10, confidence 9/10.**

---

## 9. Historical recommended architecture (superseded)

Three layers. They are complementary, not alternatives, and they should be built in this order because each is independently shippable.

**Layer 1 — Calibration (Option D).** Removes knowledge of the normalization from the codebase entirely. Ship this first: on its own it makes `CONFIG_DROPPED_MODEL_FIELDS` obsolete, which is the thing the user explicitly objected to.

**Layer 2 — Property assertions on effective state (Option A, upgraded).** Rather than diffing config documents, assert the guarantees against the endpoints that report *effective* state — `/config/providers`, `/agent`, `/mcp`. These are already fetched together in `OpenCodeHostManager.getResolvedConfigFingerprint()`, so the plumbing exists. Assertions to express: the selected provider is present with our endpoint; the selected model is actually available; the `teammate` agent exists and its effective permissions match what we configured; the `agent-teams` MCP server is present, connected, and on our transport; no foreign providers when scoped isolation is required.

**Layer 3 — Baseline drift detection (Option B).** After layers 1–2 pass at start, snapshot the effective state and compare T0/T1 on every re-check. Covers whatever layer 2 forgot to assert.

Together: no upstream field lists anywhere; the check finally examines what actually drives behavior; and completeness is preserved.

**Combined reliability 9/10, confidence 8/10.**

---

## 10. Nuances, pitfalls and gotchas for whoever implements this

- **Do not conflate the two lists.** "Fields upstream discards" (bad, uncontrolled) vs "fields we must guarantee" (fine, ours). Every review of this work will drift toward treating them as the same thing.
- **Fail-closed is the existing contract.** `refreshSelectedProfileAuthority()` returns `profile | null` and the observability callback must not change that (`reject()` deliberately swallows `onRejection` exceptions). Preserve this.
- **Diagnostics must not leak secrets.** The `exception` branch deliberately reports only an error *class*, with the comment "Never expose error messages/names: provider errors can include credentials or config." Any new diagnostic must hold that line — provider configs contain API keys.
- **`selectedConfig()` is also used for `contractConfigIdentity`** comparison against the MCP tool-proof; check callers before changing its shape.
- **The check runs twice per launch** — before and after the execution probe (`refreshedBefore` / `refreshedAfter` in `OpenCodeBridgeCommandHandler.ts` around line 2664). The "after" call produces the different message *"authority changed during execution proof"*. A baseline design must make clear which of the two establishes the reference.
- **`host-registry.json`'s `resolvedConfigFingerprint` is a different thing** from this check and uses a different normalization. Their equality proves nothing here — this is exactly what confused the reporter, and it will confuse the next person too.
- **Scoped isolation already rewrites the provider block.** `enforceScopedProviderIsolation()` reduces `config.provider` to just the selected provider and strips `model`/`small_model` that are not prefixed with it. Any comparison logic must run after that, on the same shape.
- **Model limit overrides mutate the provider block too** (`applyOpenCodeModelLimitOverrides`), including per-model `limit`. Those are ours and must keep failing closed if the live side disagrees — the hotfix's negative test asserts exactly this.
- **Do not regress the OpenCode secondary-lane semantics.** OpenCode teammates start after the lead's first successful turn; a missing OpenCode inbox during primary launch is not a bug (see `docs/team-management/debugging-agent-teams.md`).
- **Reproducing the class of bug is cheap.** Start `opencode serve` with `XDG_CONFIG_HOME`/`XDG_DATA_HOME` pointed at empty temp dirs and `OPENCODE_CONFIG_CONTENT` set to a candidate managed config, then diff the config you sent against `GET /config`. Any field that disappears is a future incident.
- **Curated providers that carry a managed `config` block** (and therefore share this exposure) are: `xiaomi-token-plan-{ams,sgp,cn}`, `minimax-coding-plan`, `zai-coding-plan`, `kimi-for-coding`, `kiro`, `cursor-acp`. Non-curated providers (OpenRouter, Vercel AI Gateway, OpenCode Zen…) have an empty managed provider block and pass the comparison trivially — which is precisely why they are useless as regression tests for this code path. **Any e2e intended to cover this must use a curated provider.**

---

## 11. Verified vs unverified

**Verified:**
- The root cause, on live OpenCode 1.18.4 and 1.18.29.
- That the fix removes the false rejection, in dev and in the packaged `v2.13.1` build.
- That the strict check still rejects genuine differences (mutated model `limit` → `selected_config_match:provider`).
- Full team launch, OpenCode-only and mixed, on the packaged release build.
- That the residual Z.AI failure is the provider's own 401, reproduced outside the app.

**Unverified:**
- A successful end-to-end launch **on Z.AI specifically** — the account's subscription had lapsed. Everything up to authentication is verified; the final hop is not.
- Windows behavior. The reporter is on Windows 11; all verification here was macOS (arm64). The defect is platform-independent by construction (it is a string/JSON comparison), but the fix has not been observed on Windows.
- Whether other curated providers carry fields the schema discards. Only `structured_output` was audited, and only within `zai-coding-plan`. A schema-vs-catalog sweep (Option C as a CI check) would answer this cheaply.

---

## 12. Key references

Runtime repo `777genius/agent_teams_orchestrator`, all paths under `src/services/opencode/`:

| Item | Location |
|---|---|
| The strict check | `OpenCodeSelectedProfileAuthority.ts` — `refreshSelectedProfileAuthority()`, `SELECTED_CONFIG_FIELDS` (line ~27), `CONFIG_DROPPED_MODEL_FIELDS` (line ~50) |
| Error thrown to the user | `OpenCodeBridgeCommandHandler.ts` line ~2664 (`refreshedBefore`), line ~2680 (`refreshedAfter`) |
| Managed config assembly, user/project merge, spawn env | `OpenCodeProfileManager.ts` — `buildManagedConfig()`, `readSafeOpenCodeRuntimeConfigImport()`, `enforceScopedProviderIsolation()`, `buildManagedConfigFingerprint()` |
| Curated provider definitions (source of `structured_output`) | `OpenCodeCuratedSubscriptionCatalog.ts` — `ZAI_CODING_PLAN_MODELS` |
| Effective-state endpoints already fetched together | `OpenCodeHostManager.ts` — `getResolvedConfigFingerprint()` (line ~1276): `/config`, `/config/providers`, `/agent`, `/mcp` |
| Host identity / reuse key | `OpenCodeHostManager.ts` — `buildOpenCodeHostProfileIdentity()` |
| Integration test to extend | `OpenCodeProvisioningProbe.test.ts` — "refreshes selected config/project/auth/MCP authority and fails closed on each mutation" |

Fix commit: `49d44c33` (PR #66). Runtime release: `v0.0.83`. App release: `v2.13.1`. Frontend pin: `runtime.lock.json`.

---

## 13. Historical suggested first task (superseded)

Build **Layer 1 (calibration)** behind the existing check, in this order:

1. Add a calibration helper that starts OpenCode in genuine isolation with only the managed config, captures `GET /config`, and caches it under `(binary identity, managed-config hash)`. Assert in tests that no user/project config can reach it.
2. Switch `selectedConfig()`'s comparison base from `managed` to the calibrated `T(managed)`, keeping the comparison directional against the real `live`.
3. Delete `CONFIG_DROPPED_MODEL_FIELDS` and `normalizeSelectedProviderModels()`; the existing hotfix tests must still pass **without** them — that is the acceptance criterion proving calibration subsumes the hardcoded list.
4. Keep `normalizeSelectedAgentDefaults()` and the `command` default until step 3's tests show calibration covers them too, then remove them the same way.

Only then move to Layers 2 and 3.

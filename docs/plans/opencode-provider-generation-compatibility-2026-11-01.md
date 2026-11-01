# OpenCode V1/V2 provider compatibility: scope and qualification

## Product contract

The selected OpenCode generation is a runtime-level decision. New installs default to V1;
installed and explicitly selected V2 stays V2. No automatic per-model fallback to V1.

A provider has one Agent Teams managed-integration compatibility state:

| State | What it proves | Can start connection? |
| --- | --- | --- |
| `supported` | Agent Teams implements the connection route for the generation; it does **not** prove this user's model works | Yes |
| `unverified` | Neither an account login nor a catalog listing proves generation-bound model execution | Yes; user can explicitly test the model |
| `incompatible` | **This Agent Teams-managed route** has not been adapted for the selected generation | No in Quick Connect/wizard; explain the limitation |

The final state is scoped to Agent Teams, not a general claim that an upstream plugin
cannot run on OpenCode V2. Four V2 routes are currently unadapted: Cursor CLI, Kiro
CLI, SuperGrok subscription OAuth, GitHub Copilot subscription OAuth. In particular,
`xai` (API-key provider) is not the same as `supergrok` (subscription OAuth).

Kimi (including region-specific V2 aliases), Z.AI, MiniMax, MiMo, OpenRouter,
Vercel, OpenAI and unknown third-party provider IDs remain `unverified` on V2
until a specific model is actually exercised. Neither a saved credential, model
catalog nor native CLI authorization may automatically upgrade this state.

## Architecture and boundaries

`src/features/runtime-provider-management/core/domain/openCodeProviderCompatibility.ts`
is the single, pure matrix. Existing wizard and quick-connect guards delegate to it.
Quick Connect, the subscription wizard and advanced provider settings consume it
without shadow copies of provider allow/deny lists.

No new persistence, feature flags, provider connection APIs, background network
probes, secrets, runtime switching or server-side model execution are in scope.
Do not change V1 installation policy or migration behavior.

## Checks before merge

1. Matrix unit tests: curated V1, native/alias V2, unsupported managed paths,
   unknown providers, and the xAI API versus SuperGrok subscription split.
2. UI tests: Quick Connect shows a connected account without falsely marking its
   V2 model verified, the wizard disables V1-only routes while clearly marking
   unverified ones, and advanced settings annotate both legacy and live-directory
   providers without deriving generation from missing status.
3. Validate all 29 locale catalogs and the generated dashboard resource types.
4. Run full CI, independent code review, CodeQL, packaged desktop E2E,
   correct every actionable finding, then merge and verify main.

## E2E evidence boundary

Mocks and native catalog reads verify safe behavior, not paid subscription model
execution. Claim successful paid-provider execution only when a real entitled
subscription has produced a generation-bound execution proof; otherwise report
`unverified`. A green installer or login is not that proof.

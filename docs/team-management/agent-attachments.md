# Agent attachments
⚠️ **Историческая документация**: Этот файл содержит дизайн-документацию. Фактическая реализация в `src/features/agent-attachments/` может отличаться от описанной архитектуры.

This document describes the v1 attachment path for Agent Teams.

## Supported runtime paths

- Claude lead/runtime: structured stream-json content blocks.
- Codex native: optimized app-owned image files passed with repeatable `--image <file>`.
- OpenCode: model-gated `file` parts sent through the OpenCode session API.

Do not append base64 to prompt text. Base64 is only valid inside provider-native structured payloads.

## Current non-image file policy

- Claude: `text/*` files and PDFs are allowed through structured document blocks.
- Codex native: non-image files are blocked before provider delivery. Codex receives images only through the native image channel in this phase.
- OpenCode: non-image files are blocked before provider delivery. OpenCode receives verified image file parts only in this phase.
- Unknown or binary file types are blocked before provider delivery.

This policy is intentionally conservative. It avoids silent text-only fallbacks, accidental huge stdin payloads, and provider-specific behavior that is not covered by live smokes.

## Current image model policy

- Claude: image attachments are allowed through structured image blocks.
- Codex native: image attachments are allowed through native image args.
- OpenCode `openai/gpt-5.4-mini`: allowed.
- OpenCode `openrouter/moonshotai/kimi-k2.6`: allowed.
- OpenCode `openrouter/z-ai/glm-4.5v`: allowed.
- OpenCode `openrouter/z-ai/glm-5.1`: blocked for images.
- Unknown OpenCode models: blocked for images until verified.

Text-only messages continue to work for unsupported image models.

## Size and optimization rules

The renderer optimizes images before send. The backend still validates and owns final delivery decisions.

- Original attachments are immutable.
- Optimized variants are derived artifacts.
- If optimized images exceed the runtime budget, sending must fail before provider delivery.
- Multiple images must be delivered together or blocked together. No partial image delivery.

## Diagnostics rules

Diagnostics may include:

- attachment count;
- optimized bytes;
- target runtime and model;
- capability decision;
- provider/runtime error text.

Diagnostics must not include:

- base64 payloads;
- data URLs;
- API keys;
- bearer tokens.

## Smoke tests

The smoke harness generates a deterministic red PNG and checks real CLI transports.

List cases:

```bash
node scripts/smoke/agent-attachments-smoke.mjs --list
```

Run all cases and save a JSON report:

```bash
node scripts/smoke/agent-attachments-smoke.mjs --all --json /tmp/agent-attachments-smoke.json
```

Run Codex native:

```bash
node scripts/smoke/agent-attachments-smoke.mjs --case codex-native-gpt-5-4-mini
node scripts/smoke/agent-attachments-smoke.mjs --case codex-native-gpt-5-4-mini-multi-image
```

Run Claude subscription stream-json:

```bash
node scripts/smoke/agent-attachments-smoke.mjs --case claude-subscription-streaming
node scripts/smoke/agent-attachments-smoke.mjs --case claude-subscription-streaming-multi-image
```

Run OpenCode OpenAI:

```bash
node scripts/smoke/agent-attachments-smoke.mjs --case opencode-openai-gpt-5-4-mini
```

Run OpenRouter cases:

```bash
OPENROUTER_API_KEY=... node scripts/smoke/agent-attachments-smoke.mjs --case opencode-openrouter-kimi-k2-6
OPENROUTER_API_KEY=... node scripts/smoke/agent-attachments-smoke.mjs --case opencode-openrouter-kimi-k2-6-multi-image
OPENROUTER_API_KEY=... node scripts/smoke/agent-attachments-smoke.mjs --case opencode-openrouter-glm-4-5v
OPENROUTER_API_KEY=... node scripts/smoke/agent-attachments-smoke.mjs --case opencode-openrouter-glm-5-1-negative
```

The script extracts assistant/result text from JSONL output before matching expected answers. This prevents false positives from prompts, base64 payloads, or diagnostics. It also redacts stdout/stderr tails for generated image bytes, data URLs, bearer tokens, API keys, environment-provided secrets, and long provider metadata signatures.

## Live verification record

Latest local verification: 2026-05-09.

| Scope | Command or case | Result | Notes |
| --- | --- | --- | --- |
| Claude visual transport | `claude-subscription-streaming` | passed | Real Claude CLI `stream-json` run answered `red` for generated PNG. |
| Claude multi-image transport | `claude-subscription-streaming-multi-image` | passed | Real Claude CLI `stream-json` run received three generated PNGs and answered `red` from extracted assistant text. |
| Codex visual transport | `codex-native-gpt-5-4-mini` | passed | Real Codex native `--image` run answered `red` for generated PNG. |
| Codex multi-image transport | `codex-native-gpt-5-4-mini-multi-image` | passed | Real Codex native run received three repeated `--image` args and answered `red` from extracted assistant text. |
| OpenCode OpenAI visual transport | `opencode-openai-gpt-5-4-mini` | passed | Real OpenCode file attachment run answered `red` after local OpenCode OpenAI auth was refreshed. |
| OpenRouter Kimi visual transport | `opencode-openrouter-kimi-k2-6` | passed | Real OpenCode file attachment run through OpenRouter answered `red` for generated PNG. |
| OpenRouter Kimi multi-image transport | `opencode-openrouter-kimi-k2-6-multi-image` | passed | Real OpenCode file attachment run through OpenRouter received three generated PNGs and answered `red` from extracted assistant text. |
| OpenRouter GLM vision transport | `opencode-openrouter-glm-4-5v` | passed | Real OpenCode file attachment run through OpenRouter answered `red` for generated PNG. |
| OpenRouter GLM non-vision guard | `opencode-openrouter-glm-5-1-negative` | passed as guard | Model responded that it cannot process images. The app policy blocks this model for image attachments before app delivery. |
| CLI process launch | `scripts/prove-agent-cli-launch.mjs` | passed | Real `opencode`, `codex`, and `claude` binaries launched through `execCli` and `spawnCli`. |
| OpenCode team provisioning | `scripts/prove-opencode-team-provisioning.mjs` with `OPENCODE_E2E_MODEL=openai/gpt-5.4-mini` | passed | Real pure OpenCode team created through `TeamProvisioningService`, live members verified, then stopped. |
| Mixed Anthropic + Codex + OpenCode team launch | `MixedProviderTeamLaunch.live.test.ts` | passed | Real mixed team launch passed with Claude subscription auth, Codex subscription auth, and OpenCode. |

`--all` can return non-zero when local provider auth is invalidated. Treat the per-case rows above as the release signal when debugging local credential issues.

## Release checklist

- Text-only messages still work for Claude, Codex, and OpenCode.
- Oversized images fail before provider delivery.
- Claude image send uses structured image blocks.
- Claude text/PDF file send uses structured document blocks.
- Codex image send uses `--image`, not prompt base64.
- Codex non-image files fail before provider delivery.
- OpenCode image send is blocked for unknown/non-vision models.
- OpenCode non-image files fail before provider delivery.
- Attachment retry reuses the same artifacts or fails loudly.
- Copied diagnostics do not include base64 or data URLs.

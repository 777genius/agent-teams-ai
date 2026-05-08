# Agent attachments

This document describes the v1 attachment path for Agent Teams.

## Supported runtime paths

- Claude lead/runtime: structured stream-json content blocks.
- Codex native: optimized app-owned image files passed with repeatable `--image <file>`.
- OpenCode: model-gated `file` parts sent through the OpenCode session API.

Do not append base64 to prompt text. Base64 is only valid inside provider-native structured payloads.

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

Run Codex native:

```bash
node scripts/smoke/agent-attachments-smoke.mjs --case codex-native-gpt-5-4-mini
```

Run OpenCode OpenAI:

```bash
node scripts/smoke/agent-attachments-smoke.mjs --case opencode-openai-gpt-5-4-mini
```

Run OpenRouter cases:

```bash
OPENROUTER_API_KEY=... node scripts/smoke/agent-attachments-smoke.mjs --case opencode-openrouter-kimi-k2-6
OPENROUTER_API_KEY=... node scripts/smoke/agent-attachments-smoke.mjs --case opencode-openrouter-glm-4-5v
OPENROUTER_API_KEY=... node scripts/smoke/agent-attachments-smoke.mjs --case opencode-openrouter-glm-5-1-negative
```

The script redacts nothing from stdout/stderr tails except that it never prints generated image bytes or configured secrets.

## Release checklist

- Text-only messages still work for Claude, Codex, and OpenCode.
- Oversized images fail before provider delivery.
- Claude image send uses structured image blocks.
- Codex image send uses `--image`, not prompt base64.
- OpenCode image send is blocked for unknown/non-vision models.
- Attachment retry reuses the same artifacts or fails loudly.
- Copied diagnostics do not include base64 or data URLs.

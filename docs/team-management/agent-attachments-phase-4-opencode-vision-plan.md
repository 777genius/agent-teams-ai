# Phase 4 - OpenCode file parts and model vision capability gate
⚠️ **Историческая документация**: Этот файл содержит дизайн-документацию. Фактическая реализация в `src/features/agent-attachments/` может отличаться от описанной архитектуры.

## Summary

Goal: support image attachments for OpenCode teammates only when the selected model/runtime can actually accept image parts, and show clear UI errors for text-only models.

Chosen approach: **OpenCode file-part adapter + curated model vision capability catalog + unknown capability fail-safe + optional live smoke tooling**.

🎯 8.3   🛡️ 8.0   🧠 7.2  
Estimated change size: `320-560` LOC across two repos.

Repos:

- `/Users/belief/dev/projects/claude/claude_team`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator`

## Live proof

Validated manually:

```text
opencode run --model openai/gpt-5.4-mini -f red-card-valid.png -> red
opencode run --model openrouter/moonshotai/kimi-k2.6 -f red-card-valid.png -> red
opencode run --model openrouter/z-ai/glm-4.5v -f red-card-valid.png -> red
opencode run --model openrouter/z-ai/glm-5.1 -f red-card-valid.png -> model says it cannot view images
```

OpenCode session export shows file part shape:

```json
{
  "type": "file",
  "mime": "image/png",
  "url": "data:image/png;base64,...",
  "filename": "red-card-valid.png"
}
```

Therefore transport can carry images, but model capability must gate usage.

## Current behavior

Current desktop delivery blocks OpenCode secondary attachments:

```text
opencode_attachments_not_supported_for_secondary_runtime
```

This was safe. Phase 4 replaces the blanket block with a capability-aware path.

## Capability catalog

Create a pure catalog in the attachment feature or shared OpenCode model utilities.

```ts
export type VisionCapability =
  | { kind: 'supported'; source: 'curated' | 'provider-metadata' | 'live-probe' }
  | { kind: 'unsupported'; source: 'curated' | 'model-response' | 'provider-metadata'; reason: string }
  | { kind: 'unknown'; reason: string };

export function resolveOpenCodeVisionCapability(modelId: string): VisionCapability {
  const normalized = normalizeOpenCodeModelId(modelId);

  if (normalized === 'openrouter/z-ai/glm-5.1') {
    return {
      kind: 'unsupported',
      source: 'curated',
      reason: 'GLM 5.1 did not accept image input in live OpenCode/OpenRouter smoke test.',
    };
  }

  if (
    normalized === 'openai/gpt-5.4-mini' ||
    normalized === 'openrouter/moonshotai/kimi-k2.6' ||
    normalized === 'openrouter/z-ai/glm-4.5v'
  ) {
    return { kind: 'supported', source: 'curated' };
  }

  if (/\b(vl|vision|image)\b/i.test(normalized)) {
    return { kind: 'supported', source: 'provider-metadata' };
  }

  return {
    kind: 'unknown',
    reason: 'Image capability for this OpenCode model has not been verified.',
  };
}
```

Policy decision:

- `supported`: allow image delivery.
- `unsupported`: block with clear error.
- `unknown`: block by default for production sends, but allow future manual override only if explicitly designed.

Before release, do not allow unknown models to receive images silently.

## OpenCode adapter

```ts
export class OpenCodeAttachmentAdapter implements AttachmentDeliveryAdapter {
  readonly runtimeKind = 'opencode' as const;

  canDeliver(ctx: AttachmentRuntimeContext, attachment: NormalizedAgentAttachment) {
    if (attachment.kind !== 'image') {
      return block('OpenCode currently supports image attachments only.');
    }

    const capability = resolveOpenCodeVisionCapability(ctx.modelId);
    if (capability.kind === 'unsupported') {
      return block(`${ctx.modelId} does not support image input. ${capability.reason}`);
    }
    if (capability.kind === 'unknown') {
      return block(`Image input support for ${ctx.modelId} is unknown. Choose a verified vision model.`);
    }

    return allowIfMime(attachment, ['image/png', 'image/jpeg', 'image/webp']);
  }

  async prepare(ctx: AttachmentRuntimeContext, attachment: NormalizedAgentAttachment) {
    const variant = selectOpenCodeFilePartVariant(attachment);
    return {
      runtimeKind: 'opencode',
      attachmentId: attachment.id,
      part: {
        kind: 'opencode-file-part',
        value: {
          type: 'file',
          mime: variant.mimeType,
          url: toDataUrl(variant),
          filename: attachment.originalName,
        },
      },
      diagnostics: [`prepared OpenCode file part for ${ctx.modelId}`],
    };
  }
}
```

## Orchestrator OpenCode bridge changes

Current bridge sends text-only parts. Extend to accept file parts.

```ts
export interface OpenCodePromptPart {
  type: 'text' | 'file';
  text?: string;
  mime?: string;
  url?: string;
  filename?: string;
}

export interface SendOpenCodePromptInput {
  sessionId: string;
  parts: OpenCodePromptPart[];
}
```

When no attachments:

```ts
parts: [{ type: 'text', text: params.text }]
```

When attachments:

```ts
parts: [
  { type: 'text', text: params.text },
  { type: 'file', mime: 'image/png', url: 'data:image/png;base64,...', filename: 'screenshot.png' },
]
```

Do not change proof gates. OpenCode delivery success still requires existing response proof:

- visible reply;
- safe plain-text materialization;
- `message_send` with correct relay id;
- work-sync report;
- task/progress evidence.

Attachment accepted by OpenCode is not response proof.

## UI capability behavior

Examples:

```text
GLM 5.1 does not support image input. Choose GLM 4.5V, Kimi K2.6, GPT-5.4-mini, Claude, or Codex.
```

```text
Image input support for this OpenCode model is not verified. Choose a verified vision model before sending screenshots.
```

```text
This image will be sent to Kimi K2.6 through OpenCode/OpenRouter.
```

Keep this next to attachment previews and also validate at send time.

## Edge cases

### OpenRouter provider missing

If OpenCode has no OpenRouter key/provider, model list may not include `openrouter/*`. This is provider auth/config issue, not attachment issue.

Expected error:

```text
OpenRouter is not connected in OpenCode. Connect OpenRouter before using this model.
```

### OpenRouter credits exhausted

Preserve exact provider error. Do not rewrite it as attachment failure.

### Model accepts file part but says cannot see image

Treat this as model capability failure and update curated deny list only after repeated confirmed cases.

Do not mark delivery transport failed if OpenCode accepted the prompt and model responded.

### Unknown model

Block image attachments by default. Text-only messages still work.

### Multiple images

Allow only if total optimized budget is safe. Do not send partial images.

### File part size

Use same optimized variants as Claude/Codex. OpenCode data URL still has base64 overhead, so backend serialized budget applies.

### Retry

Retry must reuse the same original/variant metadata. Do not recompress differently on every retry unless original variant is missing.

## Tests

### Unit

- `openrouter/moonshotai/kimi-k2.6` is supported;
- `openrouter/z-ai/glm-4.5v` is supported;
- `openrouter/z-ai/glm-5.1` is unsupported;
- unknown OpenRouter model is blocked for image;
- OpenCode adapter emits `file` part with data URL;
- no base64 appears in diagnostics;
- text-only OpenCode messages remain unchanged.

### Bridge tests

- OpenCode bridge accepts text-only parts;
- OpenCode bridge accepts text plus file parts;
- unsupported part type rejects before API call;
- response observer/proof semantics unchanged.

### Desktop service tests

- direct OpenCode secondary image send blocks unsupported model;
- direct OpenCode secondary image send prepares file part for supported model;
- provider/API error is preserved;
- attachment accepted does not set delivery success without response proof.

### Live e2e

Only on explicit request:

```bash
OPENROUTER_API_KEY=... opencode run --pure --format json --dir /tmp --model openrouter/moonshotai/kimi-k2.6 "..." -f red-card-valid.png
OPENROUTER_API_KEY=... opencode run --pure --format json --dir /tmp --model openrouter/z-ai/glm-4.5v "..." -f red-card-valid.png
OPENROUTER_API_KEY=... opencode run --pure --format json --dir /tmp --model openrouter/z-ai/glm-5.1 "..." -f red-card-valid.png
```

Expected:

```text
Kimi K2.6 -> red
GLM 4.5V -> red
GLM 5.1 -> unsupported/refusal
```

## Safety checklist

- OpenCode proof gates unchanged.
- Unsupported models blocked before send.
- Provider auth errors preserved.
- No silent fallback to text base64.
- No model-specific prompt hacks.
- Capability catalog is pure and unit-tested.

## Deep implementation details

### Capability resolver should be pure

Do not call OpenCode or OpenRouter inside the send hot path.

```ts
export interface OpenCodeVisionCapabilityResolver {
  resolve(modelId: string): VisionCapability;
}
```

Use static curated rules plus model id heuristics. Live probing belongs in Phase 5 tooling, not every send.

### Capability result examples

```ts
resolve('openrouter/moonshotai/kimi-k2.6')
// { kind: 'supported', source: 'curated' }

resolve('openrouter/z-ai/glm-4.5v')
// { kind: 'supported', source: 'curated' }

resolve('openrouter/z-ai/glm-5.1')
// { kind: 'unsupported', source: 'curated', reason: 'Live smoke returned text-only refusal.' }

resolve('openrouter/qwen/qwen2.5-vl-72b-instruct')
// { kind: 'supported', source: 'provider-metadata' }

resolve('openrouter/minimax/minimax-m2.5')
// { kind: 'unknown', reason: 'No verified vision capability.' }
```

### Model normalization

OpenCode may expose ids in different forms:

```text
openrouter/moonshotai/kimi-k2.6
moonshotai/kimi-k2.6 via openrouter provider context
z-ai/glm-4.5v
```

Normalize consistently:

```ts
export function normalizeOpenCodeModelRef(input: string, providerId?: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.startsWith('openrouter/')) return trimmed;
  if (providerId === 'openrouter') return `openrouter/${trimmed}`;
  return trimmed;
}
```

### OpenCode bridge part schema

Use narrow supported schema. Do not allow arbitrary JSON parts from renderer/main.

```ts
export type OpenCodeBridgePromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: 'image/png' | 'image/jpeg' | 'image/webp'; url: string; filename: string };

function assertOpenCodeBridgePromptPart(part: OpenCodeBridgePromptPart): void {
  if (part.type === 'file') {
    if (!part.url.startsWith(`data:${part.mime};base64,`)) {
      throw new Error('Invalid OpenCode file part data URL.');
    }
    if (part.url.length > OPENCODE_FILE_PART_DATA_URL_MAX_CHARS) {
      throw new Error('OpenCode file part is too large.');
    }
  }
}
```

### Delivery result semantics

Do not change existing OpenCode delivery proof. Attachment support is input preparation only.

```text
file part accepted != response delivered
response text exists != relay proof for peer messages
empty assistant turn != success
provider auth failure != retryable prompt repair
```

### UI capability copy

Keep model-specific text concise:

```text
Images are not supported by GLM 5.1 in OpenCode. Choose GLM 4.5V, Kimi K2.6, GPT-5.4-mini, Claude, or Codex.
```

For unknown:

```text
Image support for this OpenCode model is not verified. Send text only or choose a verified vision model.
```

For missing provider auth:

```text
OpenRouter is not connected for OpenCode. Connect OpenRouter before sending images to this model.
```

### More edge cases

| Edge case | Expected behavior |
|---|---|
| OpenCode provider exists only through env key during tests | live smoke works, app-managed config still needs explicit provider setup |
| User pastes image to OpenCode text-only model | composer blocks send before creating ledger record |
| User sends text-only to GLM 5.1 | allowed, no image capability warning blocking send |
| Kimi accepts image but returns low-quality answer | delivery success if response proof exists; not attachment bug |
| OpenRouter key has quota limit | preserve exact provider error and show advisory/notification if runtime error path triggers |
| OpenCode returns `ProviderModelNotFoundError` | provider/model config error, not attachment serialization |
| File part accepted but no assistant response | existing OpenCode repair policy handles no response, not attachment feature |
| Unsupported image MIME like SVG | block before OpenCode bridge |
| Data URL too large | block before OpenCode API call |

### Negative test for GLM 5.1

```ts
test('blocks GLM 5.1 image send before OpenCode prompt', async () => {
  const result = planner.canPrepare({ runtimeKind: 'opencode', modelId: 'openrouter/z-ai/glm-5.1' }, [image]);
  expect(result.allowed).toBe(false);
  expect(result.blockers[0].code).toBe('attachment_model_vision_unsupported');
});
```

### Positive test for Kimi

```ts
test('allows Kimi K2.6 image send', async () => {
  const result = planner.canPrepare({ runtimeKind: 'opencode', modelId: 'openrouter/moonshotai/kimi-k2.6' }, [image]);
  expect(result.allowed).toBe(true);
});
```

### Regression traps

- Making unknown OpenCode models permissive by default.
- Marking ledger `delivered` just because OpenCode accepted a file part.
- Adding model-specific prompt text like “you can see image” instead of capability gating.
- Writing OpenRouter API key into logs while running live smoke.
- Updating app-managed OpenCode auth store from ephemeral env without explicit user action.

## File-by-file implementation plan

### claude_team

Potential files:

```text
src/features/agent-attachments/core/domain/OpenCodeVisionCapability.ts
src/features/agent-attachments/main/adapters/output/OpenCodeAttachmentAdapter.ts
src/main/services/team/TeamProvisioningService.ts
src/renderer/utils/openCodeRuntimeDeliveryDiagnostics.ts
src/renderer/components/team/messages/MessageComposer.tsx
```

Do not place the capability map inside `TeamProvisioningService`.

### agent_teams_orchestrator

Potential files:

```text
src/services/opencode/OpenCodeSessionBridge.ts
src/services/opencode/OpenCodeBridgeCommandHandler.ts
src/services/opencode/OpenCodeDeliveryResponseObserver.ts
src/services/opencode/*.test.ts
```

Bridge accepts structured parts. Observer/proof logic should remain unchanged except diagnostics may include attachment context.

## Capability map structure

Use a compact data file or pure module.

```ts
const OPENCODE_VISION_CAPABILITY_OVERRIDES: Record<string, VisionCapability> = {
  'openai/gpt-5.4-mini': { kind: 'supported', source: 'curated' },
  'openrouter/moonshotai/kimi-k2.6': { kind: 'supported', source: 'curated' },
  'openrouter/z-ai/glm-4.5v': { kind: 'supported', source: 'curated' },
  'openrouter/z-ai/glm-5.1': {
    kind: 'unsupported',
    source: 'curated',
    reason: 'Live smoke returned model response saying image input is unsupported.',
  },
};
```

Heuristics only after exact overrides:

```ts
if (/\b(vl|vision|image)\b/i.test(modelId)) {
  return { kind: 'supported', source: 'provider-metadata' };
}
```

If no exact/heuristic match:

```ts
return { kind: 'unknown', reason: 'No verified vision capability for this model.' };
```

## UI state transitions

| State | UI |
|---|---|
| supported | normal send enabled |
| unsupported | send disabled with model-specific message |
| unknown | send disabled with `not verified` message |
| provider missing | send disabled with provider connect message |
| provider quota/auth error after send | runtime error notification/advisory, not preflight warning |

## Direct teammate delivery with attachments

For OpenCode secondary direct user message:

```text
user -> OpenCode member
```

The send path must:

1. resolve member provider/model from live config/meta;
2. run attachment capability gate;
3. prepare OpenCode file parts;
4. call bridge with text + file parts;
5. keep existing ledger proof semantics.

Do not let UI-provided model labels drive capability. Backend must resolve actual member model.

## Peer/lead relay with attachments

For v1, be conservative.

If user sends attachment to lead and lead delegates to OpenCode member, do not automatically forward original binary attachment unless a later phase explicitly implements attachment relay. The lead can describe or ask user to send directly.

This avoids accidental broad binary propagation across agents.

## More detailed tests

### Capability resolver

```ts
it.each([
  ['openrouter/moonshotai/kimi-k2.6', 'supported'],
  ['openrouter/z-ai/glm-4.5v', 'supported'],
  ['openrouter/z-ai/glm-5.1', 'unsupported'],
  ['openrouter/minimax/minimax-m2.5', 'unknown'],
])('resolves %s', (modelId, expected) => {
  expect(resolveOpenCodeVisionCapability(modelId).kind).toBe(expected);
});
```

### Bridge part validation

```ts
expect(() => assertOpenCodeBridgePromptPart({
  type: 'file',
  mime: 'image/png',
  url: 'not-a-data-url',
  filename: 'x.png',
})).toThrow('Invalid OpenCode file part data URL');
```

### Ledger preservation

```ts
it('does not mark delivery successful only because file part was accepted', async () => {
  const result = await delivery.sendWithAttachment(...);
  expect(result.delivered).toBe(false);
  expect(result.responsePending).toBe(true);
});
```

## Review checklist

- Unknown OpenCode model does not receive image by default.
- GLM 5.1 image send is blocked before API call.
- Kimi K2.6 and GLM 4.5V are allowed.
- Text-only sends to all models still work.
- OpenCode provider errors are preserved exactly.
- Ledger/proof semantics unchanged.
- No OpenRouter key printed in live test logs.

## Phase 4 exit criteria

Phase 4 is complete only when:

- text-only OpenCode delivery path is unchanged;
- OpenCode image send is allowed only for supported/verified vision models;
- GLM 5.1 image send is blocked before OpenCode call;
- Kimi K2.6 and GLM 4.5V image sends serialize to file parts in tests;
- OpenCode delivery proof semantics are unchanged;
- provider auth/quota/model errors remain exact;
- no automatic live probe runs on normal send.

## Cross-repo sequencing

Recommended order:

1. Orchestrator: extend OpenCode bridge to accept typed `parts` while preserving text-only API.
2. Orchestrator: test file part serialization with fake client.
3. Desktop: add OpenCode capability resolver.
4. Desktop: add OpenCode adapter.
5. Desktop: wire direct OpenCode secondary attachment path.
6. Add UI warnings/blockers for unsupported/unknown models.
7. Run live smoke only after unit/fixture tests pass.

## Backward-compatible bridge API

Keep old text API as wrapper.

```ts
async sendPromptText(input: { sessionId: string; text: string }) {
  return this.sendPromptParts({
    sessionId: input.sessionId,
    parts: [{ type: 'text', text: input.text }],
  });
}
```

New API:

```ts
async sendPromptParts(input: { sessionId: string; parts: OpenCodeBridgePromptPart[] }) {
  validateParts(input.parts);
  return this.client.sendSessionMessage(input.sessionId, { parts: input.parts });
}
```

## Capability resolver detail

Return both machine code and user copy.

```ts
export interface OpenCodeVisionCapabilityDecision {
  kind: 'supported' | 'unsupported' | 'unknown';
  code:
    | 'opencode_vision_supported'
    | 'opencode_model_text_only'
    | 'opencode_model_vision_unknown';
  source: 'curated' | 'heuristic' | 'provider-metadata';
  userMessage?: string;
  diagnostic: string;
}
```

This prevents UI from string-matching diagnostics.

## Provider auth vs capability

Do not require provider auth to decide static capability. A model can be known vision-capable even if auth is missing. Send still fails/preflights on auth separately.

Example:

```text
openrouter/moonshotai/kimi-k2.6 capability = supported
OpenRouter auth missing = provider setup blocker
```

Both may appear in UI, but auth blocker is operational and capability is model-level.

## More OpenCode tests

```ts
it('keeps text-only API as wrapper around parts API', async () => {
  await bridge.sendPromptText({ sessionId: 's', text: 'hello' });
  expect(client.sendSessionMessage).toHaveBeenCalledWith('s', {
    parts: [{ type: 'text', text: 'hello' }],
  });
});
```

```ts
it('serializes image file part without changing response observer', async () => {
  await bridge.sendPromptParts({
    sessionId: 's',
    parts: [
      { type: 'text', text: 'what color?' },
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'x.png' },
    ],
  });
  expect(observer).not.toHaveNewSuccessRule();
});
```

## More OpenCode bug traps

| Trap | Prevention |
|---|---|
| unknown model allowed and silently fails | unknown blocks by default |
| bridge accepts arbitrary part JSON | strict union validation |
| file part accepted marks ledger delivered | tests assert proof unchanged |
| provider key logged in smoke | redactor in smoke script |
| model capability string hardcoded in UI only | backend resolver is source of truth |
| OpenRouter model id normalization inconsistent | shared `normalizeOpenCodeModelRef` tests |

## Detailed Implementation Checklist

### Step 1 - Add OpenCode capability matrix

OpenCode support depends on provider and model, not just provider id.

```ts
export interface OpenCodeModelVisionCapability {
  provider: 'openai' | 'openrouter' | string;
  modelPattern: RegExp;
  vision: 'yes' | 'no' | 'unknown';
  evidence: 'live-smoke' | 'docs' | 'manual' | 'default';
}
```

Initial known evidence from prototype:

- `openai/gpt-5.4-mini`: vision yes.
- `openrouter/moonshotai/kimi-k2.6`: vision yes.
- `openrouter/z-ai/glm-4.5v`: vision yes.
- `openrouter/z-ai/glm-5.1`: vision no or unreliable for images based on smoke result.

Unknown models should not silently accept images. Use warning/block depending on UX decision:

- For release-safe behavior: block unknown vision models and explain.
- For exploratory dev behavior: allow with explicit “model may not support images” warning only if user confirms. Not recommended before release.

### Step 2 - Route OpenCode attachments through file parts

Use OpenCode file attachment mechanism, not base64 text.

Conceptual orchestrator command:

```ts
const args = ['run', '--format', 'json', '--model', model, prompt];
for (const image of request.images) {
  args.push('-f', image.path);
}
```

If using HTTP/server API instead of CLI, keep the same contract: file path/part is transport-native.

### Step 3 - Integrate with delivery ledger safely

Attachment delivery result must still satisfy the existing prompt delivery proof rules.

| Result | Ledger behavior |
|---|---|
| Model returns visible reply | Existing success path. |
| Model returns plain text direct user reply | Existing safe materialization path. |
| Model says it cannot view image | Delivery succeeded, semantic unsupported response. Mark delivered if visible reply exists. |
| Provider rejects file | Delivery failed with provider diagnostic. |
| Empty assistant turn | Existing bounded repair policy applies. |
| Non-visible tool without progress | Existing proof-directed repair applies. |

### Step 4 - Add exact diagnostics

OpenCode attachment diagnostics should include provider/model context but redact secrets.

Examples:

- `OpenCode model openrouter/z-ai/glm-5.1 is not marked vision-capable for image attachments.`
- `OpenCode image artifact missing before delivery.`
- `OpenCode provider rejected image attachment: <redacted error>`
- `OpenCode returned a visible reply saying it cannot inspect images.`

Do not turn a model “I cannot see images” answer into transport failure if the model produced a visible answer. That is useful user feedback.

## OpenCode Edge Cases

| Case | Expected behavior |
|---|---|
| OpenRouter key quota exceeded | Provider failure with exact redacted diagnostic. |
| OpenCode OAuth stale | Auth/session failure, not attachment failure. |
| Model vision unknown | Block or warn according to release setting, default block. |
| Model claims no image support despite capability yes | Visible semantic answer, not retry-loop. |
| File path accepted but model returns empty turn | Existing bounded empty-turn repair. |
| Concurrent messages with images | Ledger correlation by original message id remains authoritative. |
| Retry of failed image delivery | Reuse same managed artifact if still present, otherwise fail artifact missing. |
| User restarts member after image failure | Restart does not delete inbox message or attachment metadata. |

## Capability Governance

Do not scatter model lists across UI and backend.

Recommended single source:

```text
src/features/agent-attachments/shared/opencodeVisionCapabilities.ts
```

Export both backend and renderer-safe functions:

```ts
export function resolveOpenCodeVisionCapability(input: {
  providerId: string;
  model: string;
}): AgentAttachmentCapability {
  // Pure function, no filesystem, no network.
}
```

When adding a new model:

1. Add capability entry with evidence comment.
2. Add unit test.
3. Add manual smoke result to this plan or docs.
4. Do not infer full provider support from one model.

## Manual OpenCode QA

Run at least these visual prompts:

1. `openai/gpt-5.4-mini`: red-card image -> expected `red`.
2. `openrouter/moonshotai/kimi-k2.6`: red-card image -> expected `red`.
3. `openrouter/z-ai/glm-4.5v`: red-card image -> expected `red`.
4. `openrouter/z-ai/glm-5.1`: red-card image -> expected block or clear unsupported warning.
5. Quota/key failure simulation -> exact provider error visible, no teammate offline unless runtime exits.

## Phase 4 Exit Criteria

- OpenCode text-only prompt path unchanged.
- Vision-capable OpenCode models receive real image files.
- Non-vision/unknown OpenCode models do not silently hallucinate image answers.
- Existing OpenCode repair policy remains bounded.
- Provider quota/auth errors remain exact and do not become generic “spawn failed”.


## Implementation Safeguards

### Capability result must be explainable

Users need to understand why one OpenCode model supports screenshots and another does not.

```ts
export interface CapabilityExplanation {
  supported: boolean;
  reason: 'known_vision_model' | 'known_non_vision_model' | 'unknown_model' | 'unsupported_provider';
  displayText: string;
}
```

Examples:

- `openai/gpt-5.4-mini supports image attachments.`
- `openrouter/z-ai/glm-5.1 is not marked as image-capable. Choose a vision-capable model or remove images.`
- `This OpenCode model has unknown image support. Image delivery is blocked for reliability.`

### Do not couple OpenCode vision support to weak-model repair

The proof-directed repair policy handles missing response proof. It should not decide model vision support.

Keep separate:

- `OpenCodeVisionCapability`: can this model receive images?
- `OpenCodePromptDeliveryRepairPolicy`: did a delivered prompt produce required proof?
- `OpenCodeDeliveryLedger`: what happened to this message attempt?

### OpenCode provider rejection mapping

OpenRouter/OpenCode errors should remain exact but redacted.

| Provider error | Mapping |
|---|---|
| Quota/credits/token budget | provider rejected attachment/message, exact diagnostic. |
| Model not found | model/provider config diagnostic. |
| Unsupported file/input | attachment provider rejected. |
| OAuth/session stale | provider auth/session diagnostic. |
| Empty assistant turn | existing bounded no-response repair. |

No regex classification is required to decide business logic. Regex/string matching can be used only for safe redaction and known diagnostic display cleanup.

### OpenCode PR checklist

- Unknown models do not silently receive images.
- Supported models use native file parts.
- No model-specific prompt hacks are added.
- Existing text-only OpenCode tests still pass.
- Existing empty-turn retry remains bounded.
- Provider quota/auth errors are not masked by attachment code.

### Additional OpenCode tests

```ts
it('blocks unknown OpenCode vision model before delivery', () => {
  const decision = resolveOpenCodeVisionCapability({
    providerId: 'openrouter',
    model: 'some/new-model',
  });

  expect(decision.supported).toBe(false);
  expect(decision.reason).toBe('unknown_model');
});

it('does not invoke repair policy for model capability block', () => {
  const result = planOpenCodeAttachmentDelivery(unknownVisionModelInput());
  expect(result.status).toBe('blocked');
  expect(result.retryable).toBe(false);
});
```


## Failure Injection Tests for Phase 4

```ts
describe('OpenCode image capability and delivery', () => {
  it('blocks a known non-vision OpenCode model before prompt delivery', () => {
    const result = planOpenCodeImageDelivery({
      providerId: 'openrouter',
      model: 'z-ai/glm-5.1',
      attachments: [fakeImageAttachment()],
    });

    expect(result.status).toBe('blocked');
    expect(result.failureCode).toBe('attachment_model_unsupported');
  });

  it('does not retry provider quota rejection as proof repair', async () => {
    const result = await deliverOpenCodeImage(fakeOpenRouterQuotaError());

    expect(result.retryKind).not.toBe('proof_directed_repair');
    expect(result.failureCode).toBe('attachment_provider_rejected');
  });
});
```

## OpenCode Multi-Hop Edge Cases

| Scenario | Safe behavior |
|---|---|
| User sends image to lead, lead delegates to OpenCode member | Lead message contains image; delegated message should include image only if explicitly attached/forwarded by lead protocol. Do not automatically leak user image to all teammates. |
| User sends direct image to OpenCode member | Direct delivery uses OpenCode file parts. |
| OpenCode member replies with tool call but no visible reply | Existing proof policy decides, not image layer. |
| OpenCode member starts task from image | Task evidence/progress still required for task state. |
| OpenCode model answers “I cannot access images” | Visible reply delivered; UI can show model limitation, no retry loop. |

## Privacy Boundary for Delegation

Do not automatically fan out attachments to every teammate. Attachment propagation should follow explicit message routing.

Rules:

- Direct `user -> member`: deliver attachment to that member only.
- `user -> lead`: deliver attachment to lead only.
- Lead delegation: attachment forwarded only if the generated structured message includes or references the attachment intentionally.
- System nudges/work-sync: do not include user attachments.

This avoids accidental data exposure across teammates.

## Phase 4 Stop Conditions

Stop and reassess if:

- OpenCode requires model-specific prompt hacks to see images.
- Unknown models must be allowed silently for UX convenience.
- Existing proof repair tests start changing because of image capability logic.
- Provider quota errors get converted into generic delivery proof failures.


## File-Level Implementation Plan

Desktop suggested files:

```text
src/features/agent-attachments/main/providers/opencodeAttachmentAdapter.ts
src/features/agent-attachments/shared/opencodeVisionCapabilities.ts
src/features/agent-attachments/main/providers/opencodeAttachmentAdapter.test.ts
```

Orchestrator suggested files:

```text
src/runtime/opencode/opencodeFileParts.ts
src/runtime/opencode/opencodeFileParts.test.ts
```

### Capability matrix skeleton

```ts
const OPENCODE_VISION_MODELS: OpenCodeModelVisionCapability[] = [
  {
    provider: 'openai',
    modelPattern: /^gpt-5\.4-mini$/,
    vision: 'yes',
    evidence: 'live-smoke',
  },
  {
    provider: 'openrouter',
    modelPattern: /^moonshotai\/kimi-k2\.6$/,
    vision: 'yes',
    evidence: 'live-smoke',
  },
  {
    provider: 'openrouter',
    modelPattern: /^z-ai\/glm-4\.5v$/,
    vision: 'yes',
    evidence: 'live-smoke',
  },
  {
    provider: 'openrouter',
    modelPattern: /^z-ai\/glm-5\.1$/,
    vision: 'no',
    evidence: 'live-smoke',
  },
];
```

Keep comments near each entry with date and smoke summary. Do not infer provider-wide support.

### OpenCode adapter skeleton

```ts
export function buildOpenCodeAttachmentPromptRequest(input: {
  text: string;
  providerId: string;
  model: string;
  attachments: AgentAttachmentPayload[];
}): OpenCodePromptRequest {
  const capability = resolveOpenCodeVisionCapability({ providerId: input.providerId, model: input.model });
  if (!capability.supported) {
    throw new AttachmentDeliveryError('attachment_model_unsupported', capability.displayText);
  }

  return {
    text: input.text,
    files: input.attachments.map((attachment) => selectProviderImageArtifact(attachment, 'opencode').absolutePath),
  };
}
```

### OpenCode warning copy examples

Use precise user-facing copy:

```text
This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.
```

```text
OpenCode provider rejected the image attachment: <redacted provider error>
```

Avoid vague copy:

```text
Message failed.
```

```text
OpenCode error.
```


## Phase 4 Deep Review Addendum

### OpenCode capability decision must be cached but refreshable

Model capability matrix is mostly static, but the user may change provider/model in Edit Team.

Rules:

- Resolve capability from current member metadata at send time.
- Do not cache capability per member forever.
- If member model changes, next send uses new model capability.
- UI warnings should refresh after Edit Team save/restart.

### OpenCode direct vs lead-routed images

Direct user to OpenCode member:

```text
user -> alice(OpenCode) with image
```

Deliver image to Alice only.

User to lead:

```text
user -> lead with image
```

Deliver image to lead only. Lead may choose to ask teammate, but automatic image forwarding should not happen unless future protocol explicitly supports attachment references.

This is a privacy and predictability decision.

### OpenCode unsupported model message examples

For direct send:

```text
Alice is using openrouter/z-ai/glm-5.1, which is not verified for image attachments. Remove the image or switch Alice to a vision-capable model.
```

For team send to lead where lead is not OpenCode:

```text
The lead can receive this image. It will not be automatically forwarded to OpenCode teammates unless the lead explicitly sends it.
```

### OpenCode model capability update procedure

When adding a new OpenCode vision model:

1. Run red-square smoke test.
2. Record provider, exact model id, date, result.
3. Add capability matrix entry.
4. Add unit test.
5. If model is unreliable, mark unsupported or unknown, not supported.


## Phase 4 Implementation Contract Addendum

### Provider/model canonicalization

OpenCode model ids can appear with or without provider prefix depending on UI/runtime source. Normalize before capability lookup.

```ts
export function canonicalizeOpenCodeModel(input: {
  providerId: string;
  model: string;
}): { providerId: string; model: string } {
  const providerId = input.providerId.toLowerCase();
  const model = input.model.replace(/^openrouter\//, '').replace(/^openai\//, '');
  return { providerId, model };
}
```

Capability tests must cover both forms:

- `providerId=openrouter`, `model=moonshotai/kimi-k2.6`
- `providerId=openrouter`, `model=openrouter/moonshotai/kimi-k2.6`

### OpenCode DTO between desktop and orchestrator

```ts
export interface OpenCodePromptRuntimeRequest {
  text: string;
  files?: Array<{
    artifactId: string;
    path: string;
    mimeType: 'image/png' | 'image/jpeg';
    sizeBytes: number;
  }>;
}
```

Rules:

- `files` are provider-native attachments, not arbitrary user paths.
- `files` empty means text-only behavior.
- Orchestrator validates path before passing `-f` or HTTP file part.

### OpenCode ledger interaction examples

```ts
if (capability.supported === false) {
  return {
    accepted: false,
    delivered: false,
    retryable: false,
    failureCode: 'attachment_model_unsupported',
  };
}
```

This must not create a ledger retry attempt because the prompt was not delivered.

If provider accepts prompt but returns empty assistant turn, existing ledger retry applies:

```ts
return {
  accepted: true,
  delivered: false,
  retryable: true,
  failureCode: 'empty_assistant_turn',
};
```


## Implementation Readiness Addendum

### Definition of Ready for Phase 4

Before coding Phase 4:

- Phase 1 normalized artifacts are stable.
- Existing OpenCode delivery ledger tests are green.
- OpenCode text-only direct reply path is green.
- Capability matrix initial entries are accepted.
- Orchestrator OpenCode file-part mechanism is identified.

### OpenCode mocked sender strategy

Use fake OpenCode sender outcomes:

```ts
type FakeOpenCodeOutcome =
  | { kind: 'visible_reply'; text: string }
  | { kind: 'empty_assistant_turn' }
  | { kind: 'provider_error'; message: string }
  | { kind: 'non_visible_tool' };
```

Test attachment adapter and ledger separately:

- Adapter tests: capability and file-part request building.
- Ledger tests: how delivery outcome affects retry/proof.
- Do not combine both in one huge brittle test unless it is e2e.

### OpenCode additional edge cases

| Edge case | Expected behavior |
|---|---|
| Model id casing differs | Canonicalize before capability lookup. |
| Provider prefix duplicated | Canonicalize. |
| OpenRouter key missing | Existing provider auth diagnostic. |
| OpenRouter credits exhausted | Provider diagnostic, no proof repair. |
| Vision model returns empty | Existing bounded empty-turn retry. |
| Non-vision model says cannot see image | If blocked before send, this should not occur. If it occurs from stale capability, visible reply is shown and capability should be corrected. |

### Capability matrix change control

Do not accept capability entries without evidence.

Required evidence for `vision: yes`:

- Real smoke prompt.
- Model id exactly as runtime uses it.
- Date.
- Observed answer.

Required evidence for `vision: no`:

- Real smoke or provider documentation.
- Observed refusal/unsupported behavior.


## Final Phase 4 Acceptance Specs

### Spec 1 - known vision OpenCode model

```gherkin
Given a user sends an image to openrouter/moonshotai/kimi-k2.6
And the capability matrix marks it vision-capable
When delivery is planned
Then the image is sent as a native file part
And existing ledger proof gates decide delivery success
```

### Spec 2 - known non-vision OpenCode model

```gherkin
Given a user sends an image to openrouter/z-ai/glm-5.1
And the capability matrix marks it unsupported
When delivery is planned
Then delivery is blocked before prompt send
And no retry ledger attempt is created
And the UI explains that the model is not verified for image attachments
```

### Spec 3 - OpenCode provider quota error

```gherkin
Given an OpenCode provider rejects a message due to quota
When an image message is sent
Then the exact redacted provider diagnostic is shown
And the failure is not converted into proof repair
And the member launch state is unchanged
```

### Phase 4 exact PR contract

The Phase 4 PR is acceptable only if:

- Capability matrix has tests for every entry.
- Unknown models default safe.
- File-part request builder has tests.
- Existing OpenCode ledger bounded retry tests remain green.
- Unsupported capability block does not create a retry attempt.
- Direct and lead-routed privacy rules are documented in tests or code comments.

### OpenCode capability copy examples

```text
Jack is using openrouter/z-ai/glm-5.1, which is not verified for image attachments. Switch to a vision-capable model or remove the image.
```

```text
Alice can receive this image because openai/gpt-5.4-mini is verified for image attachments.
```


## Phase 4 Pre-Mortem and Extra Safeguards

### Likely OpenCode mistakes

| Mistake | Concrete prevention |
|---|---|
| Unknown model allowed because “maybe vision” | Unknown defaults blocked. |
| Capability lookup misses provider prefix variant | Canonicalization tests. |
| Provider quota error enters proof repair | Provider rejection is terminal for that attempt, not proof repair. |
| Direct user image gets auto-forwarded to teammates | Explicit route-only attachment propagation. |
| Non-vision model gets image-less prompt silently | Capability block before delivery. |

### OpenCode file-part transport abstraction

Do not let high-level delivery know whether OpenCode uses CLI `-f` or HTTP multipart internally.

```ts
export interface OpenCodeFilePartTransport {
  sendPrompt(input: {
    sessionId: string;
    text: string;
    files: OpenCodeRuntimeFilePart[];
  }): Promise<OpenCodePromptOutcome>;
}
```

This allows future switch from CLI to server API without changing capability or ledger logic.

### OpenCode semantic refusal handling

If model responds visibly with “I cannot inspect images”:

- Direct user message: show response as delivered.
- Add optional diagnostic warning that capability matrix may be wrong.
- Do not retry automatically.
- Consider downgrading capability entry after repeated smoke failure.

### OpenCode tests for no silent drop

```ts
it('does not send text-only prompt when image is unsupported', async () => {
  const sender = createFakeOpenCodeSender();
  await expect(deliverImageToUnsupportedOpenCodeModel(sender)).rejects.toMatchObject({
    code: 'attachment_model_unsupported',
  });
  expect(sender.calls).toHaveLength(0);
});
```


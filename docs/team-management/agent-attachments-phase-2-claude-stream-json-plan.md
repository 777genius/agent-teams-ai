# Phase 2 - Claude stream-json attachment delivery adapter
⚠️ **Историческая документация**: Этот файл содержит дизайн-документацию. Фактическая реализация в `src/features/agent-attachments/` может отличаться от описанной архитектуры.

## Summary

Goal: route existing Claude lead attachment delivery through the new attachment planner, preserving current stream-json content block behavior while adding deterministic budgets and diagnostics.

Chosen approach: **extract current Claude serialization into `ClaudeStreamJsonAttachmentAdapter` and call it from `TeamProvisioningService.sendMessageToRun()`**.

🎯 9.0   🛡️ 8.8   🧠 5.8  
Estimated change size: `180-320` LOC.

This phase should not change launch, bootstrap, provider auth, or teammate liveness. It only replaces ad-hoc attachment block assembly with a tested adapter.

## Current behavior to preserve

Current path in `TeamProvisioningService.sendMessageToRun()` builds content blocks:

```ts
const contentBlocks: Record<string, unknown>[] = [{ type: 'text', text: message }];

if (att.mimeType === 'application/pdf') {
  contentBlocks.push({
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: att.data,
    },
    title: att.filename,
  });
} else if (att.mimeType === 'text/plain') {
  // text or base64 document
} else {
  contentBlocks.push({
    type: 'image',
    source: {
      type: 'base64',
      media_type: att.mimeType,
      data: att.data,
    },
  });
}
```

Keep the same Claude content block shape.

## Why use adapter

`TeamProvisioningService` should not know image optimization or provider-specific attachment serialization details. Its responsibility is team lifecycle and message routing.

The adapter gives:

- unit-testable serialization;
- budget diagnostics before stdin write;
- future support for variant selection;
- less risk when adding Codex/OpenCode adapters.

## New adapter sketch

```ts
export class ClaudeStreamJsonAttachmentAdapter implements AttachmentDeliveryAdapter {
  readonly runtimeKind = 'claude-stream-json' as const;

  canDeliver(
    ctx: AttachmentRuntimeContext,
    attachment: NormalizedAgentAttachment,
  ): AttachmentCapabilityDecision {
    if (attachment.kind === 'image') {
      return allowIfMime(attachment, ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    }

    if (attachment.kind === 'document' || attachment.kind === 'text') {
      return allow();
    }

    return block('This attachment type is not supported by Claude.');
  }

  async prepare(
    ctx: AttachmentRuntimeContext,
    attachment: NormalizedAgentAttachment,
  ): Promise<PreparedAttachmentPart> {
    const variant = selectClaudeVariant(attachment);
    return {
      runtimeKind: this.runtimeKind,
      attachmentId: attachment.id,
      part: {
        kind: 'claude-content-block',
        value: toClaudeContentBlock(attachment, variant),
      },
      diagnostics: [`prepared ${attachment.kind} for Claude stream-json`],
    };
  }
}
```

## Serialization helpers

```ts
function toClaudeContentBlock(
  attachment: NormalizedAgentAttachment,
  variant: AgentAttachmentVariant,
): Record<string, unknown> {
  if (attachment.kind === 'image') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: variant.mimeType,
        data: readBase64Variant(variant),
      },
    };
  }

  if (attachment.kind === 'text') {
    return {
      type: 'document',
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: readTextVariant(variant),
      },
      title: attachment.originalName,
    };
  }

  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: attachment.mimeType,
      data: readBase64Variant(variant),
    },
    title: attachment.originalName,
  };
}
```

## `sendMessageToRun` target shape

Before:

```ts
const contentBlocks = buildInlineInService(message, attachments);
```

After:

```ts
const contentBlocks: Record<string, unknown>[] = [{ type: 'text', text: message }];

if (attachments?.length) {
  const prepared = await this.attachmentDeliveryPlanner.prepareAll(
    {
      teamName: run.teamName,
      providerId: run.providerId,
      modelId: run.model,
      runtimeKind: 'claude-stream-json',
      deliveryTarget: 'lead',
    },
    await this.attachmentNormalizer.normalizeLegacyPayloads(attachments),
  );

  for (const part of prepared) {
    if (part.part.kind !== 'claude-content-block') {
      throw new Error('Internal attachment planner returned non-Claude part for Claude runtime');
    }
    contentBlocks.push(part.part.value);
  }
}
```

## Payload write safety

Before writing stdin:

```ts
const payload = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: contentBlocks,
  },
});

this.attachmentBudgetValidator.assertSerializedPayloadWithinBudget(payload);
```

If blocked, return actionable error:

```text
Attachments are too large for Claude stream-json input after optimization. Remove one image or send a smaller screenshot.
```

## Edge cases

### Existing text-only sends

No change. If `attachments` is empty, the planner is not called.

### Existing PDF support

Keep current content block shape. Do not optimize PDFs in this phase.

### Non-UTF text files

Keep current behavior: try UTF-8, fallback to base64 document if replacement characters appear.

### Runtime process exits after send

Do not attribute exit to attachment unless the error path can prove stdin write/payload size failure. This phase should only make pre-send failures visible.

### Claude image support in wrong mode

Team lead is long-lived stream-json, so supported. Do not use `claude -p` as e2e validation for this path.

### Multiple images

Send all if under budget. If over budget, send none.

## Diagnostics

Add bounded diagnostics only:

```text
Prepared 2 attachments for Claude stream-json: image/jpeg 612KB, image/png 124KB.
```

Never log:

- base64 content;
- full file paths unless already user-selected and safe;
- API keys;
- raw JSON payload.

## Test plan

### Unit

- image attachment serializes to Claude `image` block;
- PDF serializes to Claude `document` block;
- UTF-8 text serializes to `document` text source;
- non-UTF text falls back to base64 document;
- planner rejects unsupported mime;
- serialized payload over budget rejects before stdin write.

### Service tests

- text-only `sendMessageToRun` does not call planner;
- safe image calls planner and writes stream-json with image block;
- over-budget image throws user-visible error and does not write stdin;
- failure does not mark team offline by itself.

Suggested focused checks:

```bash
pnpm vitest run src/features/agent-attachments/**/*.test.ts test/main/services/team/TeamProvisioningService.test.ts test/main/ipc/teams.test.ts
pnpm typecheck --pretty false
```

## Safety checklist

- Current Claude content block schema preserved.
- No Codex/OpenCode paths touched.
- No launch/provisioning path touched.
- No live provider calls in unit tests.
- Existing UI attachment workflow remains compatible.

## Deep implementation details

### Refactor target

The desired refactor is small and reversible.

Before:

```ts
private async sendMessageToRun(run, message, attachments) {
  const contentBlocks = [{ type: 'text', text: message }];
  // inline attachment serialization here
  stdin.write(JSON.stringify({ ...contentBlocks }) + '\n');
}
```

After:

```ts
private async sendMessageToRun(run, message, attachments) {
  const contentBlocks = await this.buildClaudeLeadContentBlocks(run, message, attachments);
  const payload = this.buildClaudeStreamJsonUserPayload(contentBlocks);
  this.agentAttachments.assertPayloadBudget(payload, { runtime: 'claude-stream-json' });
  await this.writeToLeadStdin(run, payload);
}
```

This keeps `sendMessageToRun()` readable and moves serialization into testable helpers.

### Helper extraction plan

```ts
private async buildClaudeLeadContentBlocks(
  run: ProvisioningRun,
  message: string,
  attachments?: LegacyAttachmentPayload[],
): Promise<Record<string, unknown>[]> {
  const blocks: Record<string, unknown>[] = [{ type: 'text', text: message }];
  if (!attachments?.length) return blocks;

  const prepared = await this.agentAttachments.prepareForRuntime({
    teamName: run.teamName,
    providerId: run.providerId,
    modelId: run.model,
    runtimeKind: 'claude-stream-json',
    deliveryTarget: 'lead',
  }, attachments);

  for (const item of prepared) {
    assertPreparedPartKind(item, 'claude-content-block');
    blocks.push(item.part.value);
  }
  return blocks;
}
```

### Content block compatibility tests

Snapshot the exact old shape.

```ts
expect(toClaudeContentBlock(imageAttachment)).toEqual({
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/png',
    data: '...',
  },
});
```

For text:

```ts
expect(toClaudeContentBlock(textAttachment)).toEqual({
  type: 'document',
  source: {
    type: 'text',
    media_type: 'text/plain',
    data: 'hello',
  },
  title: 'notes.txt',
});
```

### Error handling

Use typed attachment errors and convert at IPC boundary.

```ts
try {
  await service.sendMessageToTeam(teamName, message, attachments);
} catch (error) {
  if (isAttachmentValidationError(error)) {
    throw new Error(error.userMessage);
  }
  throw error;
}
```

Do not catch and convert provider/runtime errors here.

### More edge cases

| Edge case | Expected behavior |
|---|---|
| Claude lead is alive but stdin not writable | existing `process stdin is not writable` error wins |
| Payload over budget | no stdin write, no message marked delivered |
| Attachment adapter throws unsupported mime | user-visible attachment error, team remains alive |
| Claude process exits after successful stdin write | existing runtime process close handling owns it |
| PDF title contains slash/newline | sanitized title in content block |
| Text file is empty | send empty text document or block? Prefer send with warning `empty text file` |
| Message text empty but image present | allow if composer supports image-only send; text block can be empty or omitted consistently |
| Multiple attachments include one invalid | block all, do not partial-send |
| Optimized variant missing | rebuild from legacy base64 or block with retryable local error |

### Why not change delivery proof

Claude lead message delivery currently depends on process stdin write and subsequent assistant stream/result. This phase does not add proof. It only makes payload construction safe.

Do not add new notifications like “image delivered” because it would imply semantic understanding.

### Regression traps

- Accidentally using optimized JPEG for transparent PNG without user-visible warning.
- Forgetting to include `title` for documents.
- Throwing generic `Internal attachment planner returned...` to user instead of diagnostics.
- Double-validating text-only messages and blocking them due missing attachment metadata.
- Logging full stream-json payload in debug output.

## File-by-file implementation plan

### 1. Add adapter

Create:

```text
src/features/agent-attachments/main/adapters/output/ClaudeStreamJsonAttachmentAdapter.ts
```

This file should depend only on feature contracts/core and small shared helpers.

### 2. Add facade method

In feature composition, expose:

```ts
prepareClaudeStreamJsonContentBlocks(input): Promise<Record<string, unknown>[]>
```

or a generic:

```ts
prepareForRuntime(ctx, attachments): Promise<PreparedAttachmentPart[]>
```

Prefer generic if Phase 3/4 will reuse it soon. Prefer Claude-specific if generic abstraction becomes too abstract too early. The plan's recommendation remains generic, but keep the public facade small.

### 3. Update TeamProvisioningService

Change only the attachment serialization part of `sendMessageToRun()`.

Do not change:

- run tracking;
- process liveness checks;
- stdin writable checks;
- lead activity updates;
- close/error handling.

### 4. Add focused tests

Update existing `TeamProvisioningService.test.ts` only around send message attachment cases. Add adapter unit tests under feature tests.

## Compatibility shim

Because Phase 1 may still use legacy payloads, adapter should accept normalized attachments from a shim.

```ts
async function normalizeForClaudeAdapter(
  legacy: LegacyTeamMessageAttachment[],
): Promise<NormalizedAgentAttachment[]> {
  return this.normalizer.normalizeLegacyPayloads(legacy, {
    preferredRuntime: 'claude-stream-json',
  });
}
```

## Detailed failure cases and expected messages

| Failure | User message | Internal diagnostic |
|---|---|---|
| payload over serialized budget | `Attachments are too large for Claude input after optimization.` | include estimated bytes and limit |
| unsupported MIME | `This attachment type is not supported by Claude.` | include MIME and filename sanitized |
| corrupt image missed by renderer | `Cannot send image because it could not be decoded.` | include attachment id only |
| stdin not writable | existing `Team process stdin is not writable` | not attachment diagnostic |
| Claude API says image invalid | preserve provider error | not rewritten as optimizer error |

## Review checklist

- Adapter output equals previous content block shape for same input.
- Payload budget check happens before `stdin.write`.
- Error handling does not mark team offline.
- No base64 in thrown error message.
- No tests require Claude live auth.
- Text-only send test still passes without creating feature attachments.

## More examples

### Image block

```ts
const block = adapter.toClaudeContentBlock(imageAttachment);
expect(block).toMatchObject({
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/jpeg',
  },
});
expect(String((block.source as any).data)).toHaveLength(imageBase64.length);
```

### Full payload budget assertion

```ts
const payload = buildClaudeStreamJsonPayload([{ type: 'text', text }, imageBlock]);
expect(() => validator.assertWithinBudget(payload)).not.toThrow();
```

### Negative payload budget assertion

```ts
const huge = makeFakeBase64(8_000_000);
expect(() => buildAndValidatePayload(huge)).toThrowAgentAttachmentError(
  'attachment_serialized_payload_too_large',
);
```

## Phase 2 exit criteria

Phase 2 is complete only when:

- old Claude image/PDF/text content block shapes are preserved;
- text-only sends bypass attachment adapter;
- oversized attachment blocks before stdin write;
- adapter errors do not mark team offline;
- copied diagnostics include attachment summary but no base64;
- no Codex/OpenCode path changes are included.

## Migration seam

Replace only this concern in `TeamProvisioningService`:

```text
legacy attachments -> Claude content blocks
```

Do not touch:

```text
run selection
stdin lifecycle
process close handling
lead activity state
message persistence
```

## Claude adapter detailed API

```ts
export interface ClaudeContentBlockBuildInput {
  messageText: string;
  attachments: NormalizedAgentAttachment[];
  budget: AgentAttachmentBudget;
}

export interface ClaudeContentBlockBuildOutput {
  contentBlocks: Record<string, unknown>[];
  estimatedSerializedBytes: number;
  diagnostics: string[];
}
```

This allows tests to assert payload size without writing to stdin.

## Safe payload builder

```ts
export function buildClaudeStreamJsonUserPayload(
  contentBlocks: Record<string, unknown>[],
): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: contentBlocks,
    },
  });
}
```

Keep this helper tiny and deterministic.

## Stdin write failure handling

Attachment errors happen before write. Stdin write errors are runtime errors.

```ts
try {
  const payload = buildClaudeStreamJsonUserPayload(blocks);
  this.agentAttachments.assertPayloadBudget(payload);
  await writeLine(stdin, payload);
} catch (error) {
  if (isAgentAttachmentError(error)) throw error;
  throw new Error(`Team "${run.teamName}" process stdin is not writable`);
}
```

Do not wrap provider/runtime errors as attachment errors.

## More Claude-specific edge cases

| Edge case | Expected behavior |
|---|---|
| `image/webp` sent to Claude | allow only if current existing path allowed it; otherwise block consistently |
| `image/gif` animated | preserve existing behavior if under budget, but warn in Phase 1 |
| empty message with image | allow only if current composer allows it; otherwise composer-level validation |
| PDF over budget | block with attachment size message |
| text file with invalid UTF-8 | fallback base64 document as current code did |
| Claude returns `Could not process image` | show provider error, do not blame optimizer unless image validation failed locally |
| CLI output includes image processing error | include bounded stderr tail in diagnostics through existing runtime mechanisms |

## Test skeleton for no stdin write on budget failure

```ts
it('does not write to stdin when attachment payload exceeds Claude budget', async () => {
  const stdin = fakeWritable();
  await expect(service.sendMessageToRun(runWithStdin(stdin), 'x', [hugeImage]))
    .rejects.toThrow(/too large/i);
  expect(stdin.write).not.toHaveBeenCalled();
});
```

## Code review notes

If the diff shows a new `if (mimeType)` ladder inside `TeamProvisioningService`, the refactor failed. That logic belongs in adapter/helper tests.

## Detailed Implementation Checklist

### Step 1 - Locate and isolate current Claude message serialization

Do not rewrite the full delivery path. Add a seam where text and attachments are converted into Claude input blocks.

Target shape:

```ts
export function buildClaudeInputBlocks(input: {
  text: string;
  attachments: AgentAttachmentPayload[];
}): ClaudeInputBlock[] {
  return [
    { type: 'text', text: input.text },
    ...input.attachments.map(toClaudeImageBlock),
  ];
}
```

### Step 2 - Use provider-native image blocks only

For Claude, image data should be represented as structured image blocks for the SDK/stream-json path. Do not paste base64 into text.

```ts
function toClaudeImageBlock(attachment: AgentAttachmentPayload): ClaudeInputBlock {
  const artifact = selectBestImageArtifact(attachment, 'claude');
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: artifact.mimeType,
      data: artifact.base64,
    },
  };
}
```

Important: this function should live in a Claude adapter, not in the composer or generic delivery service.

### Step 3 - Preserve text-only path

Guard the new block builder so text-only Claude messages produce byte-for-byte equivalent semantic behavior.

```ts
if (attachments.length === 0) {
  return buildExistingClaudeTextPayload(text);
}
```

Only remove this branch after tests prove the generic block path is fully equivalent.

### Step 4 - Add exact diagnostics

Claude attachment failures should say what failed:

- `Claude image artifact missing`
- `Claude image MIME type unsupported: image/webp`
- `Claude image payload exceeds budget after optimization`
- `Claude stream-json image delivery rejected: <redacted provider error>`

Avoid saying “teammate crashed” unless process liveness confirms that.

## Claude-Specific Edge Cases

| Case | Risk | Safe behavior |
|---|---|---|
| Claude subscription not logged in | Could be misread as attachment failure | Preserve existing auth diagnostic. |
| Multiple images | Token/latency spike | Enforce count and total byte budget before SDK call. |
| Image plus task delegation | Tool-call response still expected | Existing proof gates stay unchanged. |
| Lead prompt with images | Lead may consume image but not delegate | This is normal model behavior, not transport failure. |
| Assistant refuses visual task | Delivery succeeded, model response is semantic failure | Do not retry transport automatically. |
| Claude CLI path lacking image support | Attachment delivery blocked with provider capability error | Do not fallback to base64 text. |

## Golden Serialization Tests

Add tests that validate payload shape without hitting Claude.

```ts
it('serializes a png as a Claude image block', () => {
  const blocks = buildClaudeInputBlocks({
    text: 'What color?',
    attachments: [fakePngAttachment({ base64: 'abc' })],
  });

  expect(blocks).toEqual([
    { type: 'text', text: 'What color?' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'abc' },
    },
  ]);
});
```

Negative test:

```ts
it('does not serialize image as plain base64 text', () => {
  const payload = JSON.stringify(buildClaudeInputBlocks(input));
  expect(payload).not.toContain('data:image/png;base64');
});
```

## Manual Claude QA

Use the known-good red-card PNG:

1. Send to Claude lead: “What color is the square? Answer one word.”
2. Expected answer: `red` or equivalent.
3. Send two images if supported by budget.
4. Send oversized image and verify UI blocks before provider call.
5. Temporarily break auth and verify auth error is preserved, not attachment error.

## Phase 2 Exit Criteria

- Claude text-only delivery remains green.
- Claude image delivery answers visual smoke prompt.
- Claude oversized image is blocked before SDK/provider call.
- Claude provider rejection is shown as delivery failure, not launch failure.
- No Codex or OpenCode code path changes are required for Phase 2 to pass.


## Implementation Safeguards

### Claude adapter should be additive

Do not refactor all Claude runtime code just to add image support. Add a small adapter and call it from the existing send path only when attachments are present.

```ts
if (validatedAttachments.length > 0) {
  const payload = await claudeAttachmentAdapter.buildDeliveryParts({
    text,
    attachments: validatedAttachments,
    budget,
  });
  return sendClaudeStructuredPayload(payload);
}

return sendClaudeTextOnlyPayload(text);
```

This limits blast radius.

### Do not infer readiness from Claude image response

A Claude member answering an image prompt proves message delivery, not bootstrap readiness. Keep these concepts separate:

- `bootstrapConfirmed`: launch/runtime proof.
- `messageDelivered`: prompt delivery proof.
- `visibleReply`: user-visible response proof.

### Claude streaming failure mapping

| Failure source | User-facing classification |
|---|---|
| SDK rejects image MIME | `attachment_type_unsupported` |
| SDK rejects payload size | `attachment_too_large` |
| Auth token invalidated | existing provider auth error |
| Runtime exits after request | runtime crash/exit diagnostic |
| Assistant answers “cannot view image” | semantic model response, not transport failure |
| Stream closes without response | delivery failure, eligible for existing bounded retry only if text path already retries |

### Claude PR review checklist

- Does the text-only path avoid new serialization code?
- Are images sent as structured image blocks, not text?
- Is artifact content loaded as late as possible?
- Are size and MIME checked before reading large file into memory?
- Is provider error redacted?
- Does delivery failure preserve the inbox message?

### Additional Claude tests

```ts
it('keeps text-only Claude path unchanged', async () => {
  const result = await buildClaudeDeliveryRequest({ text: 'hello', attachments: [] });
  expect(result.kind).toBe('legacy_text');
});

it('classifies missing optimized artifact before provider call', async () => {
  await expect(buildClaudeDeliveryRequest({
    text: 'see image',
    attachments: [fakeAttachmentWithMissingPath()],
  })).rejects.toMatchObject({ code: 'attachment_artifact_missing' });
});
```


## Failure Injection Tests for Phase 2

```ts
describe('Claude attachment delivery failures', () => {
  it('does not mark teammate offline when Claude rejects image payload', async () => {
    const result = await deliverClaudeMessageWithAttachment(fakeProviderRejectsImage());

    expect(result.delivery.status).toBe('failed');
    expect(result.delivery.failureCode).toBe('attachment_provider_rejected');
    expect(result.memberPatch).toBeUndefined();
  });

  it('preserves existing auth error when Claude token is invalid', async () => {
    const result = await deliverClaudeMessageWithAttachment(fakeInvalidAuth());

    expect(result.error.message).toMatch(/authentication|sign in|token/i);
    expect(result.error.code).not.toBe('attachment_provider_rejected');
  });
});
```

## Claude Serialization Gotchas

- Some Claude SDK/CLI surfaces accept message arrays, some accept stream-json lines, and some accept plain prompt text. Attachments must use the surface that truly supports image blocks.
- If the current runtime path cannot send image blocks safely, Phase 2 must block image send with a clear message instead of falling back to base64 text.
- Do not mix `@file` syntax with image block syntax unless that exact runtime path has been tested.
- If multiple Claude launch contexts exist, validate the one used by the app, not only a standalone prototype.

## Claude Runtime Exit Correlation

If Claude process exits shortly after image delivery, diagnostics should show both facts separately:

```text
Image delivery was attempted using Claude image blocks.
The Claude runtime exited 18s later.
Last stderr: <redacted tail>
```

Do not claim the image caused the exit unless provider stderr explicitly says so.

## Phase 2 Stop Conditions

Stop and reassess if:

- Claude implementation requires changing team bootstrap prompts.
- Claude text-only path must be rewritten broadly.
- Auth/session diagnostics change unexpectedly.
- Provider image block support is not available in the actual app runtime path.


## File-Level Implementation Plan

Suggested files:

```text
src/features/agent-attachments/main/providers/claudeAttachmentAdapter.ts
src/features/agent-attachments/main/providers/claudeAttachmentAdapter.test.ts
```

Existing delivery call site should import only the adapter public function, not internal attachment storage helpers.

### Adapter skeleton

```ts
export async function buildClaudeAttachmentDeliveryParts(input: {
  text: string;
  attachments: AgentAttachmentPayload[];
  readArtifact: AttachmentArtifactReader;
}): Promise<ClaudeDeliveryParts> {
  const blocks: ClaudeInputBlock[] = [];
  if (input.text.trim().length > 0) {
    blocks.push({ type: 'text', text: input.text });
  }

  for (const attachment of input.attachments) {
    const artifact = selectProviderImageArtifact(attachment, 'anthropic');
    const bytes = await input.readArtifact.readBytes(artifact.artifactId);
    blocks.push(toClaudeImageBlock(artifact.mimeType, bytes));
  }

  return { kind: 'claude_structured_blocks', blocks };
}
```

### Artifact reader abstraction

```ts
export interface AttachmentArtifactReader {
  readBytes(artifactId: string): Promise<Buffer>;
  stat(artifactId: string): Promise<{ sizeBytes: number }>;
}
```

This makes adapter unit tests independent from filesystem.

### Claude image block conversion

```ts
function toClaudeImageBlock(mimeType: string, bytes: Buffer): ClaudeInputBlock {
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') {
    throw new AttachmentDeliveryError('attachment_type_unsupported', `Claude image MIME unsupported: ${mimeType}`);
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mimeType,
      data: bytes.toString('base64'),
    },
  };
}
```

This base64 is provider-native structured payload data, not prompt text. That distinction should be documented in code comments because it is easy to confuse.

### Claude phase review traps

- If a reviewer sees `data:image` in prompt text, reject.
- If a reviewer sees `spawnStatus` or `launchState` imports in adapter, reject.
- If a reviewer sees attachment adapter imported by bootstrap/provisioning code, reject.
- If text-only Claude messages start going through `readArtifact`, reject.


## Phase 2 Deep Review Addendum

### Claude adapter contract tests

Test adapter without real Claude first. The real smoke test should only prove provider behavior after contract is stable.

```ts
describe('buildClaudeAttachmentDeliveryParts', () => {
  it('preserves text order before images', async () => {
    const parts = await buildClaudeAttachmentDeliveryParts(fakeInputWithOneImage());
    expect(parts.blocks[0]).toMatchObject({ type: 'text' });
    expect(parts.blocks[1]).toMatchObject({ type: 'image' });
  });

  it('rejects webp until explicitly supported', async () => {
    await expect(buildClaudeAttachmentDeliveryParts(fakeWebpInput()))
      .rejects.toMatchObject({ code: 'attachment_type_unsupported' });
  });
});
```

### Claude delivery proof matrix

| Message target | Required proof after Claude response |
|---|---|
| Direct user ask | visible reply or safe plain text materialization |
| Delegate to teammate | structured relay/message proof if current flow requires it |
| Work-sync | existing work-sync proof, not visual answer |
| Task progress | existing task/progress proof |

Image support must not weaken these proof gates.

### Live smoke minimum

Use a prompt that cannot be answered correctly without image access:

```text
Look at the attached image. What is the single dominant color of the square? Answer with one English word.
```

Passing answer: `red`.

Failing answers:

- `I cannot view images`.
- Any generic guess not grounded in image.
- Empty turn.
- Tool-only response without visible answer for direct ask.


## Phase 2 Implementation Contract Addendum

### Runtime path decision tree

Before implementing, identify the exact Claude runtime path used by team messages.

```text
Does app path support structured image blocks?
  yes -> implement native Claude image blocks
  no -> block image send for Claude with clear unsupported runtime message
```

Do not implement a fallback that pastes base64 text.

### Claude provider adapter return shape

```ts
export type ClaudeAttachmentDeliveryParts =
  | { kind: 'legacy_text'; text: string }
  | { kind: 'structured_blocks'; blocks: ClaudeInputBlock[] };
```

Rules:

- `legacy_text` only when no attachments.
- `structured_blocks` when attachments exist.
- Call site must handle both explicitly.
- Any unsupported attachment throws typed `AgentAttachmentError` before provider call.

### Claude provider smoke record format

Record smoke results in PR notes:

```text
Provider: Claude subscription
Runtime path: <actual app path>
Model: <model>
Prompt: What color is the square? One word.
Image: red-square.png
Expected: red
Observed: red
Date: 2026-05-09
Result: pass
```

This avoids relying on stale memory about prototype success.


## Implementation Readiness Addendum

### Definition of Ready for Phase 2

Before coding Phase 2:

- Phase 1 normalized attachment payload exists and is tested.
- Backend can read optimized artifact bytes by attachment id.
- Exact Claude app runtime path for team messages is identified.
- Text-only Claude delivery tests are green before changes.

### Mocking strategy

Use a fake artifact reader and fake Claude sender.

```ts
const fakeArtifactReader: AttachmentArtifactReader = {
  async readBytes(id) {
    if (id === 'missing') throw new AgentAttachmentError('attachment_artifact_missing', 'missing');
    return Buffer.from([1, 2, 3]);
  },
  async stat() {
    return { sizeBytes: 3 };
  },
};
```

Do not unit-test by invoking real Claude. Real Claude belongs to smoke/e2e only.

### Claude fallback decision

If structured image blocks are unavailable in the actual app runtime:

- Block image send for Claude.
- Keep text-only send working.
- Add diagnostic: `Claude runtime path does not support image attachments yet.`
- Do not fallback to `@file`, Markdown image links, or base64 text unless separately proven.

### Claude additional edge cases

| Edge case | Expected behavior |
|---|---|
| Empty text with image | Allow if UX supports image-only prompt, otherwise require text. Do not crash adapter. |
| Multiple images | Preserve order. |
| Unsupported MIME after hydration | Typed pre-provider error. |
| Artifact read fails | Message saved, delivery fails actionable. |
| Claude returns visible refusal | Delivery succeeded with refusal visible to user. |


## Final Phase 2 Acceptance Specs

### Spec 1 - Claude text-only no regression

```gherkin
Given a user sends a text-only message to a Claude target
When the message is delivered
Then the legacy Claude text path is used
And no artifact reader is invoked
And existing proof gates are unchanged
```

### Spec 2 - Claude image delivered through structured block

```gherkin
Given a user sends a PNG image to a Claude target
When the Claude adapter builds delivery parts
Then it returns structured blocks
And the first block is the text prompt
And the second block is a provider-native image block
And no data:image text is present in the prompt
```

### Spec 3 - Claude artifact missing

```gherkin
Given a message references an optimized image artifact
And the artifact file is missing
When delivery is attempted
Then delivery fails with attachment_artifact_missing
And the member launch state is unchanged
And the message remains available for user action
```

### Phase 2 exact PR contract

The Phase 2 PR is acceptable only if:

- It adds a Claude adapter with fake artifact-reader tests.
- It preserves text-only fast path.
- It maps provider image rejection to attachment delivery failure.
- It preserves Claude auth/session diagnostics.
- It includes one real smoke note or explicitly marks smoke as pending.
- It does not touch Codex/OpenCode delivery code except shared types.

### Claude provider-native base64 comment requirement

If implementation converts bytes to base64 for Claude structured image blocks, add a comment explaining why this is not the forbidden base64-in-text fallback.

```ts
// Claude expects image bytes inside the structured image block as base64.
// This is provider-native payload data, not text appended to the user prompt.
```


## Phase 2 Pre-Mortem and Extra Safeguards

### Likely Claude mistakes

| Mistake | Concrete prevention |
|---|---|
| Testing standalone Claude path but shipping different app path | Smoke actual app-managed team delivery path. |
| Treating Claude visible refusal as transport failure | Visible refusal is delivered response. |
| Weakening relay/work-sync proof gates | Keep existing proof gates after response. |
| Reading large artifact before budget validation | Validate size before reading bytes. |
| Logging structured payload with base64 | Redact image block data in diagnostics. |

### Redaction helper requirement

Claude structured payload may contain base64. Any debug output must redact it.

```ts
export function redactClaudeBlocksForDiagnostics(blocks: ClaudeInputBlock[]): unknown[] {
  return blocks.map((block) => {
    if (block.type !== 'image') return block;
    return {
      ...block,
      source: {
        ...block.source,
        data: `[redacted image bytes: ${block.source.media_type}]`,
      },
    };
  });
}
```

### Claude adapter test for redaction

```ts
it('redacts image bytes in diagnostics', () => {
  const redacted = redactClaudeBlocksForDiagnostics([fakeClaudeImageBlock('SECRET_BASE64')]);
  expect(JSON.stringify(redacted)).not.toContain('SECRET_BASE64');
});
```

### Claude stream handling edge case

If Claude streams partial text then errors:

- Preserve partial visible text only if existing delivery layer already supports partials safely.
- Otherwise report delivery failed with provider diagnostic.
- Do not mark message read if required visible proof was not committed.


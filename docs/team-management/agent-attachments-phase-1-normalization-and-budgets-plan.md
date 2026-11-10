# Phase 1 - Attachment normalization, image optimization, budgets, and UI warnings

⚠️ **Историческая документация**: Этот файл содержит дизайн-документацию для Phase 1. Фактическая реализация в `src/features/agent-attachments/` может отличаться от описанной архитектуры. Для актуального состояния см. код в `src/features/agent-attachments/core/domain/` (budgets.ts, errors.ts, capabilities.ts, types.ts и т.д.).

## Summary

Goal: make attachment intake safe before changing provider delivery paths.

Chosen approach: **new agent-attachments feature skeleton + renderer pica optimizer + backend budget validator + capability warnings**, with current runtime delivery behavior preserved.

🎯 9.4   🛡️ 9.3   🧠 5.8  
Estimated change size: `260-420` LOC.

This phase is intentionally conservative. It reduces crash risk from oversized image payloads without changing Claude/Codex/OpenCode runtime launch or delivery semantics.

## Why this phase first

Current attachment handling stores images as base64 in renderer and validates decoded file size only. This misses the real risk:

```text
image bytes -> base64 expands by ~33% -> JSON wrapper -> stream-json stdin line
```

A 20MB decoded total can become a much larger single-line JSON payload and can destabilize a long-lived lead process.

Phase 1 creates the safety foundation:

- normalize attachments;
- optimize screenshots;
- calculate estimated serialized payload size;
- block too-large sends before stdin write;
- show clear UI warnings;
- do not change runtime adapter logic yet.

## Scope

In scope:

- new `src/features/agent-attachments` contracts/core shell;
- renderer image optimization using `pica@9.0.1`;
- new normalized attachment DTOs;
- backend validation for image dimensions, bytes, base64 size, and estimated serialized payload;
- UI warnings in composer;
- tests for optimizer decisions and validation.

Out of scope:

- Codex `--image` wiring;
- OpenCode file parts;
- model capability catalog beyond basic warnings;
- document/PDF optimization;
- live provider calls.

## Dependency decision

Add:

```bash
pnpm add pica@9.0.1
```

Rationale:

- pure browser-side high-quality resize;
- no native Electron packaging risk;
- good quality for screenshots and UI text;
- safer before release than `sharp` in Electron main.

Do not add:

- `sharp` in Electron main in this phase;
- `@squoosh/lib` due staleness/complexity;
- `jimp` due lower quality/performance for screenshots.

## New feature layout

```text
src/features/agent-attachments/
  contracts/
    api.ts
    dto.ts
    channels.ts
  core/
    domain/
      AttachmentBudget.ts
      AttachmentModel.ts
      AttachmentValidation.ts
    application/
      AttachmentIntakePolicy.ts
      AttachmentBudgetEstimator.ts
  main/
    composition/
      createAgentAttachmentsFeature.ts
    adapters/
      input/ipc/registerAgentAttachmentIpc.ts
    infrastructure/
      ServerAttachmentValidator.ts
  preload/
    createAgentAttachmentsBridge.ts
  renderer/
    hooks/useAttachmentPreparation.ts
    ui/AttachmentCapabilityNotice.tsx
    utils/picaImageOptimizer.ts
```

If this feels too much for phase 1, contracts/domain/application can be created first and IPC can be deferred. But the boundaries should be established now.

## Contract DTOs

```ts
export type AgentAttachmentKind = 'image' | 'document' | 'text' | 'unsupported';

export interface AgentAttachmentDraftDto {
  id: string;
  filename: string;
  mimeType: string;
  kind: AgentAttachmentKind;
  originalBytes: number;
  dataBase64: string;
  width?: number;
  height?: number;
  optimized?: AgentAttachmentOptimizedVariantDto;
  warnings: AgentAttachmentWarningDto[];
}

export interface AgentAttachmentOptimizedVariantDto {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  dataBase64: string;
  bytes: number;
  width: number;
  height: number;
  quality?: number;
  strategy: 'unchanged' | 'resized' | 'converted' | 'resized-and-converted';
}

export interface AgentAttachmentWarningDto {
  code:
    | 'image_resized'
    | 'image_quality_reduced'
    | 'image_too_large'
    | 'animated_gif_unchanged'
    | 'unsupported_mime_type'
    | 'serialized_payload_too_large';
  severity: 'info' | 'warning' | 'error';
  message: string;
}
```

## Budget constants

Start conservative. These can be tuned after e2e.

```ts
export const AGENT_ATTACHMENT_BUDGETS = {
  maxFiles: 5,
  maxOriginalFileBytes: 10 * 1024 * 1024,
  maxTotalOriginalBytes: 20 * 1024 * 1024,
  maxOptimizedImageBytes: 1_500_000,
  maxTotalOptimizedBytes: 4_000_000,
  maxEstimatedStreamJsonPayloadBytes: 7_500_000,
  maxDecodedMegapixels: 24,
  maxLongEdgePx: 2000,
  minJpegQuality: 0.72,
  initialJpegQuality: 0.88,
} as const;
```

Rationale:

- Claude Code docs mention 10MB stdin limit for headless input modes. Use `7.5MB` app budget to leave JSON/base64 overhead headroom.
- Multiple images need a total optimized budget, not only per-image limits.
- Screenshots need enough resolution to read text, so do not crush quality below `0.72` silently.

## Renderer optimizer policy

Use `pica` only for images where this is safe.

```ts
export async function optimizeImageForAgentAttachment(
  input: BrowserImageInput,
  policy = DEFAULT_IMAGE_OPTIMIZATION_POLICY,
): Promise<AgentAttachmentOptimizedVariantDto> {
  if (input.mimeType === 'image/gif') {
    return keepOriginalWithWarning('animated_gif_unchanged');
  }

  if (input.hasAlpha) {
    return resizePngPreservingAlpha(input, policy);
  }

  return resizeRgbScreenshotToJpeg(input, policy);
}
```

Rules:

- Preserve aspect ratio.
- Preserve alpha by staying PNG unless output exceeds budget and user must choose a lower-fidelity conversion explicitly later.
- Do not silently convert animated GIF to a still image.
- Prefer JPEG for large RGB screenshots.
- Try qualities in bounded steps: `0.88`, `0.82`, `0.76`, `0.72`.
- If still too large, show error instead of making unreadable images.

## Payload size estimator

Do not rely only on decoded bytes.

```ts
export function estimateStreamJsonPayloadBytes(input: {
  text: string;
  attachments: AgentAttachmentDraftDto[];
}): number {
  const contentBlocks = input.attachments.map(attachment => ({
    type: attachment.kind === 'image' ? 'image' : 'document',
    source: {
      type: 'base64',
      media_type: attachment.optimized?.mimeType ?? attachment.mimeType,
      data: attachment.optimized?.dataBase64 ?? attachment.dataBase64,
    },
  }));

  return Buffer.byteLength(JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: input.text }, ...contentBlocks],
    },
  }), 'utf8');
}
```

This estimator lives in shared/core if it avoids Node-only APIs, or duplicated as pure helper with `TextEncoder` for renderer and `Buffer.byteLength` for main. Prefer pure `TextEncoder` for cross-process reuse.

## Backend validation

The backend must revalidate everything because renderer optimization is not a security boundary.

```ts
export function validateAgentAttachmentsForSend(input: {
  text: string;
  attachments: AgentAttachmentDraftDto[];
  runtimeHint: RuntimeAttachmentHint;
}): ValidationResult {
  if (input.attachments.length > AGENT_ATTACHMENT_BUDGETS.maxFiles) {
    return error('Too many attachments.');
  }

  const estimatedBytes = estimateStreamJsonPayloadBytes(input);
  if (estimatedBytes > AGENT_ATTACHMENT_BUDGETS.maxEstimatedStreamJsonPayloadBytes) {
    return error(
      `Attachments are too large after optimization (${formatBytes(estimatedBytes)} serialized). ` +
      `Remove an image or reduce screenshot size.`,
    );
  }

  return ok();
}
```

For phase 1, wire this into existing `validateAttachments` before `sendMessageToTeam` accepts attachments.

## Composer UI behavior

Add a small notice near attachment previews.

Examples:

```text
Screenshot optimized to 1920x1080 JPEG, 612 KB.
```

```text
Attachments are too large after optimization. Remove one image or use a smaller screenshot.
```

```text
Animated GIFs are not optimized yet and may be too large for agent delivery.
```

Do not mention provider-specific capability in Phase 1 unless the target runtime is already known in composer state. The main blocker in Phase 1 is size/budget safety.

## Integration points

Existing code to adjust carefully:

```text
src/renderer/utils/attachmentUtils.ts
src/renderer/hooks/useComposerDraft.ts
src/main/ipc/teams.ts
src/main/services/team/TeamProvisioningService.ts
```

Do not move all logic at once. Add wrappers and leave current API shape compatible.

## Edge cases

### Multiple high-resolution screenshots

Expected behavior:

- optimize each image;
- if total serialized payload still too large, block send with clear error;
- do not partially send only some images.

### Transparent PNG

Expected behavior:

- preserve PNG/alpha;
- if too large, ask user to reduce or confirm future lossy conversion in a later phase;
- do not silently flatten transparency.

### Animated GIF

Expected behavior:

- keep original if within budget;
- otherwise block with clear message;
- do not silently first-frame it.

### Corrupt image

Expected behavior:

- show `Cannot read image file`;
- do not pass corrupt base64 to runtime.

### Old draft with base64-only attachment

Expected behavior:

- load draft;
- if no optimized variant exists, optimize on send;
- if optimization fails, block send.

### Unsupported file type

Expected behavior:

- existing path fallback for local files can remain;
- unsupported binary file is not converted to base64 attachment.

## Test plan

### Unit

- `estimateStreamJsonPayloadBytes` includes base64 and JSON overhead.
- RGB PNG screenshot converts/resizes to JPEG under budget.
- Small PNG remains unchanged if already safe.
- Alpha PNG does not become JPEG silently.
- Animated GIF is not converted silently.
- Corrupt image returns error.
- Total optimized bytes over budget blocks send.

### Renderer

- composer shows optimization notice;
- composer shows too-large error;
- removing an attachment clears budget error;
- old drafts trigger optimization before send.

### Main/IPС

- IPC rejects too many attachments;
- IPC rejects payload above serialized budget;
- IPC accepts safe optimized image;
- error messages are user-readable and do not include base64 data.

Suggested focused checks:

```bash
pnpm vitest run src/features/agent-attachments/**/*.test.ts test/main/ipc/teams.test.ts test/renderer/components/team/messages/MessageComposer.test.tsx
pnpm typecheck --pretty false
```

## Safety checklist

- No provider runtime path changed.
- No launch/provisioning path changed.
- Text-only messages still use old path.
- Attachments are blocked before send if unsafe.
- Backend validation cannot be bypassed by renderer state.
- No secrets or base64 blobs in diagnostics.

## Deep implementation details

### Step-by-step implementation sequence

1. Add feature contracts and pure budget estimator.
2. Add renderer-only `picaImageOptimizer` with no imports from main.
3. Add backend `ServerAttachmentValidator` that can validate legacy payloads.
4. Wire backend validator into existing IPC send path before `TeamProvisioningService.sendMessageToTeam()`.
5. Add composer warnings from renderer optimization state.
6. Add tests for estimator and validator.

This order avoids changing provider delivery until validation is proven.

### Pure byte estimator

Use a runtime-neutral helper so both renderer and main can compute comparable values.

```ts
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function estimateBase64JsonStringBytes(base64: string): number {
  // JSON string escaping is normally small for base64, but include quotes.
  return utf8Bytes(JSON.stringify(base64));
}

export function estimateClaudeStreamJsonPayloadBytes(input: {
  text: string;
  attachments: Array<{ mimeType: string; base64: string; kind: 'image' | 'document' }>;
}): number {
  const payload = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: input.text },
        ...input.attachments.map(att => ({
          type: att.kind === 'image' ? 'image' : 'document',
          source: {
            type: 'base64',
            media_type: att.mimeType,
            data: att.base64,
          },
        })),
      ],
    },
  };
  return utf8Bytes(JSON.stringify(payload));
}
```

Avoid using `Buffer` in shared/renderer code.

### Renderer optimizer pseudo-code

```ts
export async function prepareImageAttachmentDraft(file: File): Promise<AgentAttachmentDraftDto> {
  const originalBase64 = await readFileAsBase64(file);
  const metadata = await readImageMetadata(file);

  if (metadata.megapixels > AGENT_ATTACHMENT_BUDGETS.maxDecodedMegapixels) {
    return errorDraft(file, 'Image resolution is too large to process safely.');
  }

  const optimized = await optimizeImageForAgent(file, metadata);
  const warnings = buildOptimizationWarnings(file, optimized);

  return {
    id: stableBrowserDraftId(file, originalBase64),
    filename: file.name,
    mimeType: file.type,
    kind: 'image',
    originalBytes: file.size,
    dataBase64: originalBase64,
    width: metadata.width,
    height: metadata.height,
    optimized,
    warnings,
  };
}
```

### Pica resize pseudo-code

```ts
async function resizeRgbToJpeg(input: ImageBitmap, policy: ImagePolicy) {
  const { width, height } = fitWithinLongEdge(input.width, input.height, policy.maxLongEdgePx);
  const canvas = new OffscreenCanvas(width, height);
  await pica().resize(input, canvas, {
    quality: 3,
    alpha: false,
    unsharpAmount: 80,
    unsharpRadius: 0.6,
    unsharpThreshold: 2,
  });

  for (const quality of [0.88, 0.82, 0.76, 0.72]) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    if (blob.size <= policy.maxOptimizedImageBytes) {
      return toVariant(blob, { width, height, quality, strategy: 'resized-and-converted' });
    }
  }

  throw new AttachmentTooLargeError('Image is still too large after resizing.');
}
```

Fallback if `OffscreenCanvas` is unavailable:

```ts
const canvas = document.createElement('canvas');
canvas.width = width;
canvas.height = height;
await pica().resize(sourceCanvasOrImage, canvas);
```

### Alpha detection

Do not decode full huge images on main thread just to check alpha. In renderer, after image bitmap decode and drawing to a small sampling canvas:

```ts
function likelyHasAlpha(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const sampleWidth = Math.min(width, 256);
  const sampleHeight = Math.min(height, 256);
  const data = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}
```

If uncertain, prefer PNG and warn rather than silently flattening.

### Backend legacy payload normalization

```ts
export function normalizeLegacyAttachmentPayload(input: {
  data: string;
  mimeType: string;
  filename?: string;
}): NormalizedLegacyAttachment {
  const decodedBytes = estimateDecodedBase64Bytes(input.data);
  const kind = classifyMimeType(input.mimeType);

  if (decodedBytes > AGENT_ATTACHMENT_BUDGETS.maxOriginalFileBytes) {
    throw new AttachmentValidationError({
      code: 'attachment_too_large_original',
      userMessage: `${input.filename ?? 'Attachment'} is too large.`,
    });
  }

  return {
    id: stableAttachmentId(input),
    filename: sanitizeAttachmentFilename(input.filename),
    mimeType: input.mimeType,
    kind,
    decodedBytes,
    base64: input.data,
  };
}
```

### Filename sanitization

Never use attachment filenames directly as filesystem paths.

```ts
export function sanitizeAttachmentFilename(name: string | undefined): string {
  const fallback = 'attachment';
  const base = (name ?? fallback)
    .replace(/[\\/\0\r\n\t]/g, '_')
    .replace(/^\.+$/, fallback)
    .slice(0, 120)
    .trim();
  return base || fallback;
}
```

### More edge cases

| Edge case | Expected behavior |
|---|---|
| Browser cannot decode HEIC pasted from iPhone | show unsupported image format, suggest PNG/JPEG screenshot |
| User attaches 5 images each individually under budget but combined over budget | block whole send, show combined payload size |
| Image has huge dimensions but tiny compressed bytes | block before decode if dimensions exceed safe megapixels |
| File extension says `.jpg` but MIME says PNG | trust detected MIME if available, otherwise validate magic bytes in backend later |
| Renderer optimization fails due memory pressure | keep draft but mark send-blocked with retry/remove action |
| User edits message text after optimization | do not recompress image, only recompute serialized payload estimate |
| User removes image | revoke object URLs and release ImageBitmap/canvas refs |
| User switches team while optimization running | cancel or ignore stale optimization result by draft id |
| SVG image | treat as unsupported in v1 unless converted explicitly later |
| WebP | allow if runtime supports, otherwise convert to JPEG/PNG if safe |

### Bug-prevention checklist

- All async optimizer results must check current draft id before writing state.
- Object URLs must be revoked on unmount/remove.
- Do not store huge base64 in React error messages.
- Do not include base64 in Zustand dev logs if avoidable.
- Do not throw raw DOMException to user.
- Backend validation must run even if renderer says optimized.
- Tests should include both `data.length` and decoded byte calculations.

## File-by-file implementation plan

### 1. Contracts

Create:

```text
src/features/agent-attachments/contracts/dto.ts
src/features/agent-attachments/contracts/api.ts
src/features/agent-attachments/contracts/index.ts
```

Keep contracts serializable. Do not expose classes or functions that require DOM/Node.

Example:

```ts
export interface AgentAttachmentBudgetDto {
  maxFiles: number;
  maxOriginalFileBytes: number;
  maxTotalOriginalBytes: number;
  maxOptimizedImageBytes: number;
  maxEstimatedSerializedBytes: number;
}
```

### 2. Core domain

Create:

```text
src/features/agent-attachments/core/domain/AttachmentBudget.ts
src/features/agent-attachments/core/domain/AttachmentMime.ts
src/features/agent-attachments/core/domain/AttachmentErrors.ts
```

This layer must be pure. No `fs`, no `Electron`, no `React`, no `Buffer` if it needs renderer reuse.

### 3. Renderer optimizer

Create:

```text
src/features/agent-attachments/renderer/utils/picaImageOptimizer.ts
```

This file may import `pica`, DOM APIs, and browser canvas APIs. It must not import main process modules.

### 4. Existing renderer integration

Update carefully:

```text
src/renderer/utils/attachmentUtils.ts
src/renderer/hooks/useComposerDraft.ts
```

Do not replace the whole draft flow. Add a narrow call:

```ts
const prepared = await prepareAgentAttachmentDraft(file);
```

### 5. Main validation

Create:

```text
src/features/agent-attachments/main/infrastructure/ServerAttachmentValidator.ts
```

Then call it from existing IPC validation. Do not move all IPC into the new feature in Phase 1 unless it is trivial.

### 6. UI warnings

Add small rendering components only if existing composer can consume warnings without a broad refactor.

Potential target:

```text
src/renderer/components/team/messages/MessageComposer.tsx
```

Keep UI changes minimal.

## Additional code examples

### Domain error class

```ts
export class AgentAttachmentError extends Error {
  constructor(readonly failure: AttachmentFailure) {
    super(failure.userMessage);
    this.name = 'AgentAttachmentError';
  }
}

export function isAgentAttachmentError(error: unknown): error is AgentAttachmentError {
  return error instanceof AgentAttachmentError;
}
```

### MIME classifier

```ts
export function classifyAttachmentMimeType(mimeType: string): AgentAttachmentKind {
  const normalized = mimeType.toLowerCase();
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(normalized)) return 'image';
  if (normalized === 'application/pdf') return 'document';
  if (normalized.startsWith('text/')) return 'text';
  return 'unsupported';
}
```

### Base64 decoded byte estimator

```ts
export function estimateDecodedBase64Bytes(base64: string): number {
  const clean = base64.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}
```

Do not decode huge base64 just to estimate size.

### Safe async draft update pattern

```ts
const generation = ++attachmentPreparationGenerationRef.current;
const result = await prepareAttachment(file);
if (generation !== attachmentPreparationGenerationRef.current) {
  return; // stale result after team/message switch
}
setDraftAttachments(prev => [...prev, result]);
```

## More detailed test cases

### Budget estimator table

| Input | Expected |
|---|---|
| no attachments, short text | under budget |
| one 1MB base64 image | serialized estimate greater than decoded bytes |
| five 1MB images | total serialized limit can fail |
| base64 with whitespace | decoded byte estimator handles it |
| empty base64 | invalid attachment error |

### Optimizer table

| Input | Expected |
|---|---|
| 320x240 PNG under budget | unchanged or tiny optimized variant |
| 6000x4000 screenshot | resized to max long edge |
| transparent PNG | stays PNG |
| animated GIF | not converted, warning |
| corrupt PNG | error draft |
| WebP | accepted if browser decodes, otherwise unsupported |

### UI state table

| Action | Expected |
|---|---|
| attach image then remove | warning disappears, object URL revoked |
| attach too-large image | send disabled with specific reason |
| edit text after attach | only serialized estimate recalculated |
| switch team during optimization | stale result ignored |
| attach unsupported binary | existing path/link fallback or blocked, no base64 blob |

## Extra risk controls

- Keep old constants temporarily and map them to new budget constants to avoid conflicting limits.
- If `pica` import increases renderer bundle unexpectedly, keep it lazy-loaded only when image attachment is selected.
- If optimization fails unexpectedly, fail closed for attachments but do not affect text-only sends.
- Add analytics/log event only with counts/bytes, never filenames if privacy-sensitive.

## Phase 1 exit criteria

Phase 1 is complete only when:

- text-only composer send is unchanged;
- image drafts show optimized size or clear error;
- backend rejects oversized serialized payloads;
- renderer and backend use consistent budget constants;
- no runtime provider delivery code is changed;
- old legacy payload shape still works;
- no base64/data URL appears in UI errors or logs.

## Migration seam from existing code

Existing code should be wrapped, not replaced wholesale.

Current likely call chain:

```text
MessageComposer -> useComposerDraft -> attachmentUtils.fileToAttachmentPayload -> teams IPC -> validateAttachments -> sendMessageToTeam
```

Phase 1 seam:

```text
attachmentUtils.fileToAttachmentPayload
  -> prepareAgentAttachmentDraft
  -> returns legacy-compatible payload plus metadata/warnings

main validateAttachments
  -> ServerAttachmentValidator.validateLegacyPayloads
```

Do not change `sendMessageToTeam` signature in Phase 1.

## More concrete backend validator

```ts
export interface ServerAttachmentValidationInput {
  messageText: string;
  attachments: Array<{ data: string; mimeType: string; filename?: string }>;
  budget?: Partial<AgentAttachmentBudget>;
}

export interface ServerAttachmentValidationOutput {
  ok: true;
  normalized: NormalizedLegacyAttachment[];
  estimatedSerializedBytes: number;
  warnings: AttachmentWarning[];
} | {
  ok: false;
  failure: AttachmentFailure;
};
```

Usage:

```ts
const validation = serverAttachmentValidator.validateLegacyPayloads({
  messageText,
  attachments,
});
if (!validation.ok) {
  throw new Error(validation.failure.userMessage);
}
```

### Validation order

Order matters for predictable user errors.

1. attachment count;
2. base64 validity;
3. decoded bytes per file;
4. total decoded bytes;
5. MIME support;
6. estimated serialized payload bytes;
7. warning collection.

Do not compute JSON payload with unbounded decoded buffers.

## Renderer optimizer cancellation

```ts
export interface AttachmentPreparationJob {
  id: string;
  cancel(): void;
  promise: Promise<AgentAttachmentDraftDto>;
}
```

If using AbortController:

```ts
const controller = new AbortController();
const promise = prepareAgentAttachmentDraft(file, { signal: controller.signal });
return { id, cancel: () => controller.abort(), promise };
```

If pica cannot fully abort, still ignore stale results by generation id.

## Memory safety

Large images can pressure renderer memory. Keep rules strict.

- Reject dimensions above max megapixels before full resize when possible.
- Release `ImageBitmap` with `imageBitmap.close()` after resize.
- Revoke object URLs.
- Avoid storing duplicate base64 strings if optimized variant replaces original for send.
- Do not put raw base64 in React component props beyond draft state if avoidable.

## Phase 1 bug traps and prevention

| Trap | Prevention |
|---|---|
| Backend accepts unsafe payload because renderer already warned | backend validator is mandatory |
| UI warning says optimized but send uses original huge base64 | send path chooses optimized variant or blocks |
| GIF silently becomes static image | explicit GIF policy, test it |
| transparent PNG becomes white/black JPEG | alpha test and PNG preservation |
| stale optimization adds attachment to wrong team draft | generation id check |
| file name path traversal appears in future artifact path | sanitize filenames now |
| tests rely on browser-only APIs in Node | keep optimizer tests in jsdom/browser-compatible environment or mock pica |

## Extra test skeletons

```ts
describe('ServerAttachmentValidator', () => {
  it('rejects payload by serialized size even when decoded bytes are under old limit', () => {
    const image = makeBase64OfSize(6_000_000);
    const result = validator.validateLegacyPayloads({
      messageText: 'x',
      attachments: [{ data: image, mimeType: 'image/png', filename: 'large.png' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('attachment_serialized_payload_too_large');
  });
});
```

```ts
describe('picaImageOptimizer', () => {
  it('does not flatten transparent PNG to JPEG', async () => {
    const result = await optimizeImageForAgentAttachment(transparentPngFile);
    expect(result.mimeType).toBe('image/png');
  });
});
```

## Detailed Implementation Checklist

### Step 1 - Add pure domain module

Create a feature-local domain module with no Electron, DOM, or filesystem dependency.

Suggested files:

```text
src/features/agent-attachments/shared/types.ts
src/features/agent-attachments/shared/budgets.ts
src/features/agent-attachments/shared/capabilities.ts
src/features/agent-attachments/shared/validation.ts
src/features/agent-attachments/shared/index.ts
```

The first implementation should be intentionally boring:

```ts
export function classifyAttachmentMime(mimeType: string): AttachmentKind {
  if (mimeType === 'image/png') return 'image';
  if (mimeType === 'image/jpeg') return 'image';
  if (mimeType === 'image/webp') return 'image';
  if (mimeType === 'application/pdf') return 'file';
  if (mimeType.startsWith('text/')) return 'file';
  return 'unsupported';
}
```

Avoid clever extension guessing in v1. Extension fallback can be a later hardening step if real users need it.

### Step 2 - Add renderer optimizer behind composer-only call site

Keep optimization in renderer because browser APIs are good at image decode and `pica` is browser-oriented.

```ts
export interface OptimizeImageForAgentInput {
  file: File;
  budget: ImageOptimizationBudget;
}

export interface OptimizeImageForAgentResult {
  original: BrowserAttachmentArtifact;
  optimized: BrowserAttachmentArtifact;
  warnings: string[];
}
```

Implementation order:

1. Decode image dimensions with `createImageBitmap` where available.
2. Compute target dimensions from total batch budget and per-image max dimension.
3. Use `pica.resize` into canvas.
4. Encode JPEG/PNG based on input and transparency.
5. Return warnings, not thrown errors, for non-fatal resize degradation.

### Step 3 - Add backend validation

Main process must re-check everything received from renderer.

```ts
export function validateNormalizedAttachmentForSend(input: {
  attachment: AgentAttachmentPayload;
  target: ProviderTarget;
}): AttachmentValidationResult {
  const capability = resolveAgentAttachmentCapability(input.target);
  const sizeResult = validateAttachmentBudget(input.attachment, capability);
  if (!sizeResult.ok) return sizeResult;
  return { ok: true, warnings: [] };
}
```

Backend validation should never trust:

- MIME type from browser alone.
- File name extension.
- Renderer-provided optimized dimensions.
- Renderer-provided `supported: true` capability result.

### Step 4 - Wire UI warnings without changing delivery

Before provider adapters are implemented, UI can show warnings but must not pretend unsupported providers work.

Safe UX:

- Allow attach, show preview.
- On send, block if selected target cannot receive the attachment yet.
- Explain which phase/provider support is missing.
- Keep text-only send untouched.

## Phase 1 Exit Criteria

Phase 1 is complete when:

- Text-only composer behavior is unchanged.
- Image preview still works for small images.
- Large image preview shows optimized size and warnings.
- Unsupported file type produces a clear local validation error.
- Backend rejects forged oversized attachment metadata.
- No provider delivery path receives new attachment data yet unless explicitly wired in later phases.

## Edge Case Matrix

| Case | Expected behavior |
|---|---|
| Animated GIF | Treat as unsupported for image delivery in v1, or convert first frame only with explicit warning if implemented. |
| Transparent PNG | Prefer PNG if small, JPEG only if transparency is absent or user accepts flattened background. |
| Huge panorama | Downscale by max edge and total pixel budget. |
| Tiny image | Do not upscale. |
| Corrupt image | Show decode failed, do not send attachment. |
| HEIC on macOS | Do not promise support unless decode pipeline is explicitly tested. |
| Clipboard image with no filename | Generate stable display name like `clipboard-image.png`. |
| Same image attached twice | Keep two attachment ids, do not dedupe content silently. |
| Multiple images exceed total budget | Optimize all proportionally, then block if still over cap. |
| User switches target after attaching | Recompute warnings for new provider/model before send. |

## Common Bug Patterns to Avoid

- Storing base64 in message JSON. This can bloat inboxes and break process stdin.
- Mutating the original attachment when optimization runs.
- Letting renderer decide final support without backend validation.
- Showing “sent” when attachment was dropped from provider payload.
- Collapsing all failures into generic “delivery failed”.
- Running optimization in Electron main with a new native dependency right before release.
- Changing current file attachment behavior for text/PDF before image flow is stable.

## Focused Test Examples

```ts
describe('attachment budgets', () => {
  it('blocks a single optimized image over hard cap', () => {
    const result = validateAttachmentBudget(
      fakeImage({ sizeBytes: 12 * 1024 * 1024 }),
      codexVisionCapability()
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('attachment_too_large');
  });

  it('does not upscale small images', () => {
    const plan = planImageResize({ width: 320, height: 200 }, { maxEdge: 1600 });
    expect(plan.width).toBe(320);
    expect(plan.height).toBe(200);
  });
});
```

## Manual QA Script

Use a clean dev profile and verify:

1. Attach a 200 KB PNG screenshot - preview appears, no warning.
2. Attach a 12 MB PNG screenshot - preview appears, optimized size shown.
3. Attach three screenshots - total budget warning is deterministic.
4. Attach a `.txt` file - current file behavior remains unchanged.
5. Attach a corrupt image renamed `.png` - decode error appears.
6. Switch target from Claude to non-vision OpenCode model - unsupported warning appears.
7. Remove attachment - warnings clear.

## Rollback Plan

If Phase 1 causes UI instability:

- Keep domain files, but remove composer call to optimizer.
- Leave backend validation unused.
- No persisted migration is needed if message schema was not changed.


## Implementation Safeguards

### Keep Phase 1 read-only for provider delivery

Phase 1 should not change how messages are sent to agents. It should only add normalization, previews, warnings, and backend validation primitives.

Safe call sites:

- Composer attachment selection.
- Composer warning rendering.
- Draft serialization of normalized metadata.
- Backend validation helper tests.

Unsafe call sites for Phase 1:

- Claude delivery transport.
- Codex runtime invocation.
- OpenCode prompt ledger.
- Team launch/provisioning.
- Member runtime liveness.

### Suggested internal state machine

```ts
type AttachmentPrepareState =
  | { status: 'idle' }
  | { status: 'decoding'; attachmentId: string }
  | { status: 'optimizing'; attachmentId: string; progress?: number }
  | { status: 'ready'; attachment: AgentAttachmentPayload }
  | { status: 'blocked'; attachmentId: string; reason: AttachmentDeliveryFailureCode }
  | { status: 'failed'; attachmentId: string; error: string };
```

UI rule:

- `blocked` means user can fix/remove/change target.
- `failed` means local processing failed.
- Neither state should enqueue runtime delivery.

### Budget planning algorithm

Use deterministic, simple budget allocation. Do not optimize each image independently to the max, because a batch can still exceed total budget.

```ts
export function allocateImageBudgets(input: {
  images: ImageCandidate[];
  totalMaxBytes: number;
  perImageMaxBytes: number;
}): ImageBudgetAllocation[] {
  const perImageFairShare = Math.floor(input.totalMaxBytes / Math.max(1, input.images.length));
  const targetBytes = Math.min(input.perImageMaxBytes, perImageFairShare);
  return input.images.map((image) => ({ imageId: image.id, targetBytes }));
}
```

If the optimized output is still above target:

1. Reduce dimensions down to min edge threshold.
2. Reduce JPEG quality down to minimum acceptable quality.
3. If still too large, block and explain.

Do not loop indefinitely.

### Cancellation edge cases

| User action | Safe behavior |
|---|---|
| Removes image during optimization | Cancel or ignore result by generation id. |
| Adds image then switches team | Cancel or detach optimization result from old draft. |
| Switches provider/model | Recompute capability warnings without re-encoding if artifact is reusable. |
| Sends while optimization pending | Disable send or show “attachment still processing”. |
| Closes app mid-optimization | No partially written artifact should be treated as ready. |

### Generation id pattern

```ts
let prepareGeneration = 0;

async function prepareAttachments(files: File[]) {
  const generation = ++prepareGeneration;
  const result = await optimize(files);
  if (generation !== prepareGeneration) return;
  setPreparedAttachments(result);
}
```

This avoids stale async results restoring removed attachments.

### Phase 1 PR checklist

- No provider delivery path changed.
- No launch/runtime tests need snapshot updates.
- Text-only message send still works manually.
- Image preview removal cannot leave hidden payload in draft.
- Backend validation is stricter than renderer validation.
- All user-visible errors are actionable.


## Failure Injection Tests for Phase 1

Add tests that intentionally simulate bad renderer or corrupted local state.

```ts
describe('attachment backend validation hardening', () => {
  it('rejects renderer supplied absolute paths outside managed storage', () => {
    const result = validateAttachmentStorageReference({
      artifactId: 'att_1',
      path: '/Users/belief/.ssh/id_rsa',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('attachment_artifact_path_unsafe');
  });

  it('rejects metadata that claims small size but file is large', async () => {
    const result = await validateAttachmentArtifactOnDisk({
      expectedSizeBytes: 100,
      actualPath: fixturePath('large-image.png'),
      maxBytes: 1024,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('attachment_too_large');
  });
});
```

## Browser and Platform Edge Cases

| Edge case | Safe implementation note |
|---|---|
| Safari/WebKit image decode differences | Use feature detection, not browser assumptions. |
| macOS clipboard TIFF/HEIC | Treat unsupported until explicitly converted/tested. |
| EXIF orientation | Prefer decode path that respects orientation or normalize orientation during canvas draw. |
| Color profiles | Accept minor color shift for screenshots, do not promise color-managed output. |
| Canvas memory pressure | Bound megapixels before drawing. |
| Pica worker failure | Fall back to canvas resize with warning, or block with clear error. |
| Transparent UI screenshot | Avoid JPEG flattening unless transparency absent or user warning is shown. |
| Very long screenshot | Limit max edge and total pixels to prevent huge canvas allocation. |

## Memory Safety Budget

Renderer memory is the main Phase 1 risk.

Recommended starting limits:

```ts
export const ATTACHMENT_IMAGE_LIMITS = {
  maxInputBytes: 20 * 1024 * 1024,
  maxInputPixels: 32_000_000,
  maxOutputBytesPerImage: 4 * 1024 * 1024,
  maxOutputBytesTotal: 8 * 1024 * 1024,
  maxOutputEdge: 2400,
  minJpegQuality: 0.72,
  defaultJpegQuality: 0.86,
};
```

These are release-safe starting values, not final product limits. They should be tuned after real usage.

## Phase 1 Stop Conditions

Stop implementation and reassess if any of these happen:

- Optimized images are stored as base64 in persisted message JSON.
- Main process needs a new native image dependency.
- Existing file attachments stop sending.
- Composer draft state becomes provider-specific.
- Text-only messages require schema migration.


## File-Level Implementation Plan

Suggested new files:

```text
src/features/agent-attachments/shared/types.ts
src/features/agent-attachments/shared/budgets.ts
src/features/agent-attachments/shared/capabilities.ts
src/features/agent-attachments/shared/validation.ts
src/features/agent-attachments/shared/storageIds.ts
src/features/agent-attachments/renderer/optimizeImageForAgent.ts
src/features/agent-attachments/renderer/usePreparedAttachments.ts
src/features/agent-attachments/main/validateAttachmentArtifact.ts
src/features/agent-attachments/main/attachmentArtifactStore.ts
```

Suggested tests:

```text
test/features/agent-attachments/budgets.test.ts
test/features/agent-attachments/capabilities.test.ts
test/features/agent-attachments/validation.test.ts
test/features/agent-attachments/attachmentArtifactStore.test.ts
```

### Storage id validation

```ts
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/;

export function assertSafeAttachmentStorageId(name: string, value: string): void {
  if (!SAFE_ID_RE.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
}
```

Use this for `teamName`, `messageId`, and `attachmentId` before building artifact paths.

### Managed path resolver

```ts
export function resolveAttachmentArtifactPath(input: {
  teamRoot: string;
  teamName: string;
  messageId: string;
  attachmentId: string;
  fileName: 'original.png' | 'original.jpg' | 'optimized.png' | 'optimized.jpg' | 'thumb.jpg' | 'meta.json';
}): string {
  assertSafeAttachmentStorageId('teamName', input.teamName);
  assertSafeAttachmentStorageId('messageId', input.messageId);
  assertSafeAttachmentStorageId('attachmentId', input.attachmentId);

  const base = path.resolve(input.teamRoot, input.teamName, 'attachments', input.messageId, input.attachmentId);
  const resolved = path.resolve(base, input.fileName);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error('Attachment artifact path escaped managed directory');
  }
  return resolved;
}
```

### Renderer optimizer guardrails

```ts
export async function optimizeImageForAgent(input: OptimizeImageForAgentInput): Promise<OptimizeImageForAgentResult> {
  const bitmap = await createImageBitmap(input.file);
  assertPixelBudget(bitmap.width, bitmap.height, input.budget.maxInputPixels);

  const target = planResizeDimensions({
    width: bitmap.width,
    height: bitmap.height,
    maxEdge: input.budget.maxOutputEdge,
  });

  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;

  await resizeWithPicaOrFallback(bitmap, canvas);
  const blob = await encodeCanvasForProvider(canvas, input.budget);
  return buildOptimizationResult(input.file, blob, target);
}
```

Do not implement infinite quality-search loops. Use a small bounded set of quality attempts like `[0.86, 0.8, 0.74, 0.72]`.

### Phase 1 exact acceptance criteria

- Backend path resolver rejects traversal in tests.
- Budget tests cover single, multiple, and oversized images.
- Renderer hook ignores stale optimization result after removal.
- Composer cannot send while any attachment is `optimizing`.
- Existing text-only composer tests do not need behavioral changes.
- No provider delivery module imports renderer optimizer.


## Phase 1 Deep Review Addendum

### Exact UI states

Composer should expose these states clearly:

| State | Send allowed | Copy |
|---|---:|---|
| No attachments | yes | normal text-only behavior |
| Attachments optimizing | no | `Preparing image...` |
| Attachments ready and supported | yes | optional optimized size summary |
| Attachment too large after optimization | no | `Image is too large after optimization. Remove it or use a smaller image.` |
| Target model unsupported | no | `Selected model does not support image attachments.` |
| Decode failed | no | `Could not read this image.` |
| Artifact persistence failed | no | `Could not prepare attachment for sending.` |

### Accessibility and UX guardrails

- Warning text should be readable without relying on color.
- Remove button must remain available for blocked attachments.
- If multiple attachments have warnings, show per-attachment reason and aggregate reason near send.
- Do not hide text draft when attachment fails.
- If user removes the blocked attachment, send button should recover immediately.

### Persistence safety

When user sends a message with attachments:

1. Generate message id first.
2. Persist original/optimized artifacts under message id.
3. Persist message record referencing attachment ids.
4. Begin provider delivery.

Do not begin provider delivery before message record and artifacts are durably written.

This avoids a retry state where ledger knows about a message but artifacts are missing because write happened later.

### Phase 1 anti-regression tests

```ts
it('does not serialize image bytes into message json', () => {
  const message = buildMessageRecordWithAttachment(fakeAttachment());
  expect(JSON.stringify(message)).not.toContain('base64');
  expect(JSON.stringify(message)).not.toContain('data:image');
});

it('restores send button after removing blocked attachment', () => {
  const state = reducer(blockedAttachmentState(), removeAttachment('att_1'));
  expect(selectCanSend(state)).toBe(true);
});
```

### Phase 1 implementation order

Implement in this order to reduce bug risk:

1. Pure budget/capability tests.
2. Safe id/path helpers.
3. Artifact store tests.
4. Renderer optimization hook without composer integration.
5. Composer preview/warning integration.
6. Send blocking.
7. Backend validation on send.

If a later step fails, earlier pure modules remain useful and low-risk.


## Phase 1 Implementation Contract Addendum

### Exact domain types

```ts
export type AttachmentWarningCode =
  | 'image_was_resized'
  | 'image_was_reencoded'
  | 'image_quality_reduced'
  | 'model_support_unknown'
  | 'model_does_not_support_images'
  | 'file_type_not_supported';

export interface AttachmentWarning {
  code: AttachmentWarningCode;
  message: string;
  attachmentId?: string;
}

export interface ImageOptimizationBudget {
  maxInputBytes: number;
  maxInputPixels: number;
  maxOutputBytesPerImage: number;
  maxOutputBytesTotal: number;
  maxOutputEdge: number;
  jpegQualityAttempts: readonly number[];
}
```

Keep these in shared pure code. Renderer and main may import types and pure validators, but renderer-specific optimizer code must not be imported by main.

### Quality strategy

Use a deterministic quality strategy instead of adaptive unbounded loops.

```ts
const JPEG_QUALITY_ATTEMPTS = [0.86, 0.82, 0.78, 0.74, 0.72] as const;

for (const quality of JPEG_QUALITY_ATTEMPTS) {
  const blob = await encodeCanvas(canvas, 'image/jpeg', quality);
  if (blob.size <= targetBytes) return blob;
}

throw new AgentAttachmentError(
  'attachment_too_large',
  'Image is too large after optimization. Remove it or use a smaller image.'
);
```

PNG strategy:

- Keep PNG for small screenshots and transparency.
- Re-encode to JPEG only when transparency is absent and size requires it.
- If transparency exists and PNG remains too large, block with clear reason instead of silently flattening unless product explicitly accepts flattening.

### UI copy table

| Code | Copy |
|---|---|
| `attachment_too_large` | `Image is too large after optimization. Remove it or use a smaller image.` |
| `attachment_type_unsupported` | `This file type is not supported for agent image delivery.` |
| `attachment_model_unsupported` | `Selected model does not support image attachments. Switch model or remove the image.` |
| `attachment_optimization_failed` | `Could not prepare this image for sending.` |
| `attachment_artifact_missing` | `Prepared image file is missing. Remove and attach the image again.` |

Copy should be short in UI. Detailed diagnostics can go into copy diagnostics/logs.

### Batch behavior

Multiple images should preserve user order.

```ts
export function sortAttachmentsForDelivery(attachments: AgentAttachmentPayload[]): AgentAttachmentPayload[] {
  return [...attachments].sort((a, b) => a.order - b.order);
}
```

Do not sort by size or file name because the prompt may refer to “first image” and “second image”.

### Draft persistence edge cases

- Draft can reference attachment ids before final message id exists.
- On send, draft attachment ids should be reparented or copied into message artifact directory.
- If reparenting fails, send should stop before provider delivery.
- Removing attachment from draft should remove draft artifact eventually, but not synchronously block UI.


## Implementation Readiness Addendum

### Definition of Ready for Phase 1

Before coding Phase 1:

- Confirm exact composer components that own attachment state.
- Confirm where message ids are generated for user sends.
- Confirm where existing attachments are persisted today.
- Confirm whether current image previews store bytes, paths, or blobs.
- Confirm no provider delivery changes are included in the Phase 1 PR.

### Exact reducer-style behavior

```ts
type ComposerAttachmentAction =
  | { type: 'attachment_added'; file: File; draftAttachmentId: string }
  | { type: 'attachment_prepare_started'; draftAttachmentId: string; generation: number }
  | { type: 'attachment_prepare_succeeded'; draftAttachmentId: string; generation: number; payload: AgentAttachmentPayload }
  | { type: 'attachment_prepare_failed'; draftAttachmentId: string; generation: number; error: AgentAttachmentErrorJson }
  | { type: 'attachment_removed'; draftAttachmentId: string }
  | { type: 'target_changed'; target: ProviderTarget };
```

Reducer rule:

- Ignore `attachment_prepare_succeeded` if generation is stale.
- Ignore prepare results for removed attachment ids.
- Recompute capability warnings on `target_changed` without reprocessing image bytes.
- Do not clear text draft when attachment fails.

### Backend artifact write order

```ts
async function persistMessageAttachments(input: PersistMessageAttachmentsInput): Promise<PersistedAttachmentBundle> {
  const messageDir = resolveMessageAttachmentDir(input.teamName, input.messageId);
  await fs.mkdir(messageDir, { recursive: true });

  const persisted: PersistedAttachment[] = [];
  for (const attachment of input.attachments) {
    const paths = resolveAttachmentPaths(input.teamName, input.messageId, attachment.id);
    await writeFileAtomic(paths.original, attachment.originalBytes);
    if (attachment.optimizedBytes) await writeFileAtomic(paths.optimized, attachment.optimizedBytes);
    await writeFileAtomic(paths.meta, JSON.stringify(buildMeta(attachment), null, 2));
    persisted.push(toPersistedAttachment(paths, attachment));
  }
  return { attachments: persisted };
}
```

Use atomic writes for metadata and artifacts where practical. A partially written optimized image must not be treated as ready.

### Atomic write requirement

```ts
async function writeFileAtomic(path: string, bytes: Buffer | string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, path);
}
```

If write fails, cleanup tmp best-effort and return typed error.

### Phase 1 additional edge cases

| Edge case | Expected behavior |
|---|---|
| Disk full during artifact write | Send blocked, text draft preserved, typed error shown. |
| App crashes after artifacts written before message record | Orphan artifacts may remain, later GC can clean. No message corruption. |
| App crashes after message record before provider delivery | Message exists with attachments and can be retried later. |
| Thumbnail write fails | Do not block delivery if original/optimized artifact is valid. Show preview fallback. |
| Original write succeeds, optimized write fails | Block image delivery unless original fits provider budget. |


## Final Phase 1 Acceptance Specs

### Spec 1 - small supported image

```gherkin
Given a user attaches a 200 KB PNG screenshot
And the selected target supports images
When the composer prepares the attachment
Then the preview is shown
And the send button remains enabled
And the persisted message references artifact ids
And the message JSON does not contain base64
```

### Spec 2 - oversized image optimized successfully

```gherkin
Given a user attaches a 12 MB PNG screenshot
When optimization completes below provider budget
Then the user sees that the image was optimized
And the send button is enabled
And the optimized artifact is used for provider delivery later
And the original artifact remains available for retry/regeneration
```

### Spec 3 - oversized image still too large

```gherkin
Given a user attaches a huge image
When bounded optimization cannot bring it below budget
Then the send button is disabled
And the text draft remains intact
And the user can remove the image
And no provider delivery is attempted
```

### Spec 4 - stale optimization result

```gherkin
Given a user attaches an image
And removes it while optimization is running
When the optimization promise resolves
Then the removed attachment is not restored
And the send state reflects the current draft only
```

### Phase 1 exact PR contract

The Phase 1 PR is acceptable only if:

- It adds shared attachment domain types.
- It adds budget/capability/validation tests.
- It adds safe managed artifact path/id helpers.
- It adds renderer optimization or a clearly documented placeholder if split.
- It does not change provider delivery behavior.
- It does not import provider runtime code into renderer optimizer.
- It does not import attachment feature into launch/provisioning.

### Phase 1 likely review findings to prevent

| Finding | Prevention |
|---|---|
| Message JSON contains base64 | persist artifact ids only |
| Send starts before artifact write | enforce write-before-delivery order |
| Draft removal race restores attachment | generation id guard |
| Backend trusts renderer size | stat artifact on disk |
| Unsupported model warning only in UI | backend validation also blocks |


## Phase 1 Pre-Mortem and Extra Safeguards

### Likely Phase 1 mistakes

| Mistake | Concrete prevention |
|---|---|
| Optimizer result races with removed attachment | Generation id guard in reducer/hook. |
| Backend trusts renderer MIME | Backend validates by allowlist and artifact metadata. |
| Draft artifacts leak forever | Mark draft artifacts and add later GC policy. |
| UI blocks text-only send after image error removed | Selector tests for `canSend`. |
| Multiple images reorder | Preserve user-provided order field. |
| Image-only send unclear | Product decision before coding: allow image-only with default prompt or require text. |

### Image-only message decision

Top options:

1. Require text with image - 🎯 8.5   🛡️ 9   🧠 2, примерно `20-50` строк.

   Safest release behavior. It avoids confusing empty prompt behavior across providers.

2. Allow image-only with generated prompt - 🎯 7   🛡️ 7.5   🧠 4, примерно `60-120` строк.

   Useful UX, but generated prompts can surprise users and differ by action mode.

3. Allow image-only raw - 🎯 5.5   🛡️ 5   🧠 2, примерно `20-40` строк.

   Some providers may accept it, but behavior is inconsistent.

Recommendation: start with option 1 for release.

### Pica wrapper contract

```ts
export interface ImageResizeEngine {
  resize(input: {
    source: ImageBitmap;
    targetWidth: number;
    targetHeight: number;
  }): Promise<HTMLCanvasElement>;
}
```

Reason:

- Keeps `pica` behind a tiny interface.
- Allows tests with fake resize engine.
- Allows fallback or replacement without changing composer state.

### Quality acceptance rules

- UI screenshots should remain legible at common zoom levels after resize.
- Do not reduce JPEG quality below configured floor.
- If text in screenshot becomes unreadable in manual QA, increase budget before release.
- If multiple images exceed total budget, prefer blocking over making all unreadable.

### Phase 1 contract tests to add before UI wiring

```ts
it('preserves attachment order for delivery', () => {
  const sorted = sortAttachmentsForDelivery([
    fakeImageAttachment({ id: 'b', order: 2 }),
    fakeImageAttachment({ id: 'a', order: 1 }),
  ]);
  expect(sorted.map((item) => item.id)).toEqual(['a', 'b']);
});

it('does not allow send while attachment is optimizing', () => {
  expect(selectCanSend(fakeDraft({ attachmentState: 'optimizing' }))).toBe(false);
});
```


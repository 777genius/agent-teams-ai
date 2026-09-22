# Phase 3 - Codex native image attachment delivery
⚠️ **Историческая документация**: Этот файл содержит дизайн-документацию. Фактическая реализация в `src/features/agent-attachments/` может отличаться от описанной архитектуры.

## Summary

Goal: support image attachments for Codex native teammates by using Codex CLI's supported `--image <FILE>` transport rather than embedding base64 in prompt text.

Chosen approach: **optimized image artifact files + Codex native exec args extension + text-only fallback errors for unsupported attachment kinds**.

🎯 8.6   🛡️ 8.4   🧠 6.6  
Estimated change size: `260-440` LOC across two repos.

Repos:

- `/Users/belief/dev/projects/claude/claude_team`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator`

## Live proof

Validated manually:

```bash
printf '%s\n' 'Look at the attached image. Reply with exactly one word: red, green, or blue.' \
  | codex exec --json --skip-git-repo-check -C /tmp \
      --model gpt-5.4-mini \
      --image /tmp/agent-attachment-prototypes/red-card-valid.png \
      --output-last-message /tmp/agent-attachment-prototypes/codex-last.txt \
      -
```

Result:

```text
red
```

Therefore Codex adapter should pass file paths.

## Current blocker

`agent_teams_orchestrator` currently rejects non-text prompts in Codex native:

```text
Codex native phase 0 only supports text-only prompts. Images, documents, and structured input are not wired yet.
```

Likely locations:

```text
agent_teams_orchestrator/src/services/codexNative/turnExecutor.ts
agent_teams_orchestrator/src/services/codexNative/execRunner.ts
```

Do not remove this guard globally. Replace it with structured extraction for supported image content only.

## Data contract

Add a Codex native input shape that can represent text plus image files.

```ts
export interface CodexNativeTurnInput {
  promptText: string;
  imagePaths: string[];
}
```

If the current internal API only accepts text, introduce a narrow overload or adapter:

```ts
export type CodexNativePromptInput =
  | { kind: 'text'; text: string }
  | { kind: 'text-with-images'; text: string; imagePaths: string[] };
```

Do not pass base64 into Codex prompt text.

## Claude-team side adapter

`CodexNativeAttachmentAdapter` should prepare image artifacts.

```ts
export class CodexNativeAttachmentAdapter implements AttachmentDeliveryAdapter {
  readonly runtimeKind = 'codex-native' as const;

  canDeliver(ctx: AttachmentRuntimeContext, attachment: NormalizedAgentAttachment) {
    if (attachment.kind !== 'image') {
      return block('Codex native currently supports image attachments only.');
    }
    return allowIfMime(attachment, ['image/png', 'image/jpeg', 'image/webp']);
  }

  async prepare(ctx: AttachmentRuntimeContext, attachment: NormalizedAgentAttachment) {
    const variant = selectCodexImageFileVariant(attachment);
    const path = await this.artifactStore.materializeFileVariant(variant, {
      teamName: ctx.teamName,
      runtime: 'codex-native',
    });

    return {
      runtimeKind: this.runtimeKind,
      attachmentId: attachment.id,
      part: { kind: 'codex-image-arg', path },
      diagnostics: [`prepared image file for Codex native: ${formatBytes(variant.byteSize)}`],
    };
  }
}
```

Artifact directory should be app-owned and not user-editable:

```text
~/.claude/teams/<team>/attachments/<message-id>/<attachment-id>/<variant-id>.<ext>
```

If existing team data conventions prefer another base path, use that. The key is deterministic metadata and cleanup safety.

## Orchestrator changes

### Extract Codex image paths from content blocks

```ts
export function toCodexNativeTurnInput(input: string | ContentBlockParam[]): CodexNativeTurnInput {
  if (typeof input === 'string') {
    return { promptText: input, imagePaths: [] };
  }

  const textParts: string[] = [];
  const imagePaths: string[] = [];

  for (const block of input) {
    if (block.type === 'text') {
      textParts.push(block.text);
      continue;
    }

    if (block.type === 'image') {
      const path = materializeCodexImageBlockToTempFile(block);
      imagePaths.push(path);
      continue;
    }

    throw new Error(`Codex native does not support ${block.type} attachments yet.`);
  }

  return {
    promptText: textParts.join('\n\n').trim(),
    imagePaths,
  };
}
```

Preferred path: desktop already materializes artifacts and passes paths, so orchestrator should not need to decode base64 except for compatibility with direct SDK/fork calls.

### Extend exec args

```ts
export function buildCodexNativeExecArgs(options: CodexNativeExecOptions): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C', options.cwd,
    ...options.imagePaths.flatMap(path => ['--image', path]),
    '-',
  ];
}
```

### Preserve stdin prompt behavior

Keep:

```ts
child.stdin.end(options.prompt);
```

Do not switch to putting the prompt in argv if it can be long.

## Edge cases

### Image file path missing before Codex starts

Expected behavior:

- fail before spawn with a clear error;
- do not start Codex with missing `--image` path.

### Multiple images

Codex CLI supports repeatable `--image <FILE>`. Pass one arg pair per image.

### Unsupported document/PDF

Expected behavior:

```text
Codex native does not support PDF attachments yet. Send text or images only.
```

Do not silently convert PDF to text in this phase.

### OpenAI account/session issue

Attachment code must not mask auth errors. If Codex says login required, show Codex auth error unchanged.

### Artifact cleanup

Do not delete image files immediately after spawn. Codex may read after process start. Keep artifacts with message/team data and clean with team cleanup or retention policy.

### Project path sandbox

Codex gets `--image` absolute paths outside project. Confirm current Codex CLI accepts this. Live test used `/tmp`, so it does. If future sandbox blocks, copy artifacts into an app-owned allowed directory.

## Test plan

### Orchestrator unit

- text-only input produces no `--image` args;
- text plus one image produces one `--image` arg;
- multiple images produce repeated args in order;
- unsupported document block throws clear error;
- missing image path throws before spawn;
- prompt still goes to stdin.

### Desktop unit/service

- Codex adapter chooses file variant;
- artifact materialization writes expected file;
- planner blocks PDF for Codex;
- error messages do not include base64.

### Live e2e

Only when explicitly requested:

```bash
codex exec --json --skip-git-repo-check -C /tmp --model gpt-5.4-mini --image red-card-valid.png -
```

Expected final message:

```text
red
```

Suggested focused checks:

```bash
# claude_team
pnpm vitest run src/features/agent-attachments/**/*.test.ts test/main/services/team/TeamProvisioningService.test.ts
pnpm typecheck --pretty false

# agent_teams_orchestrator
bun test src/services/codexNative/*.test.ts
```

## Safety checklist

- Text-only Codex path unchanged.
- Auth/session errors preserved.
- No base64 in prompt text.
- No immediate cleanup of image files after spawn.
- Unsupported files fail before model call.

## Deep implementation details

### Two-repo boundary

Desktop should decide and materialize attachment artifacts. Orchestrator should execute Codex with prepared input.

```text
claude_team:
  normalize/optimize/store image
  decide Codex supports image
  pass prepared prompt + image artifact refs into runtime handoff

agent_teams_orchestrator:
  accept text + imagePaths
  validate files exist/readable
  append --image args
  keep prompt on stdin
```

Avoid making orchestrator depend on desktop feature internals.

### Minimal orchestrator type extension

```ts
export interface CodexNativeExecOptions {
  cwd: string;
  prompt: string;
  model?: string;
  imagePaths?: string[];
  env?: NodeJS.ProcessEnv;
}
```

Default `imagePaths = []` preserves existing callers.

### Args builder exact behavior

```ts
export function buildCodexNativeExecArgs(options: CodexNativeExecOptions): string[] {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    options.cwd,
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  for (const imagePath of options.imagePaths ?? []) {
    args.push('--image', imagePath);
  }

  args.push('-');
  return args;
}
```

Order matters. Keep `-` last so stdin is prompt.

### File validation before spawn

```ts
async function assertCodexImageFilesReady(paths: string[]): Promise<void> {
  for (const imagePath of paths) {
    const stat = await fs.promises.stat(imagePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`Codex image attachment is missing: ${path.basename(imagePath)}`);
    }
    if (stat.size <= 0) {
      throw new Error(`Codex image attachment is empty: ${path.basename(imagePath)}`);
    }
    if (stat.size > CODEX_IMAGE_FILE_MAX_BYTES) {
      throw new Error(`Codex image attachment is too large: ${path.basename(imagePath)}`);
    }
  }
}
```

Do not include full absolute paths in user messages unless copied diagnostics need them and they are redacted/safe.

### Desktop artifact store contract

```ts
export interface AttachmentArtifactStore {
  materializeVariantFile(input: {
    teamName: string;
    messageId: string;
    attachmentId: string;
    variantId: string;
    filename: string;
    base64: string;
    expectedSha256: string;
  }): Promise<{ path: string; bytes: number; sha256: string }>;
}
```

Validation:

- directory created with recursive mkdir;
- filename sanitized;
- write to temp file then rename;
- sha256 verified after write;
- if existing file has same sha256, reuse;
- if existing file mismatch, rewrite from original.

### Artifact write pattern

```ts
const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
await fs.promises.writeFile(tmp, bytes, { flag: 'wx' }).catch(async error => {
  if (error.code === 'EEXIST') {
    await fs.promises.rm(tmp, { force: true });
    await fs.promises.writeFile(tmp, bytes, { flag: 'wx' });
    return;
  }
  throw error;
});
await fs.promises.rename(tmp, target);
```

Prefer a shared atomic write helper if one already exists.

### More edge cases

| Edge case | Expected behavior |
|---|---|
| Codex login expires | Codex auth error shown unchanged |
| Image path contains spaces | args array handles it, no shell quoting needed |
| Artifact deleted between validation and spawn | Codex may fail; surface exact stderr, but pre-spawn validation reduces probability |
| Multiple Codex members use same attachment | artifact store can reuse same variant path by hash |
| User sends image to Codex lead while lead busy | existing lead busy/message delivery semantics remain unchanged |
| Codex model selected is text-only in future | capability gate should block when catalog knows; otherwise live model may error, preserve exact error |
| Image is WebP | if Codex accepts through `--image`, allow; otherwise convert to PNG/JPEG in Phase 1/adapter policy |
| PDF attached to Codex | block in v1 with clear message |

### Test additions in orchestrator

```ts
test('adds repeated --image args before stdin marker', () => {
  expect(buildCodexNativeExecArgs({ cwd: '/tmp', prompt: 'x', imagePaths: ['/a.png', '/b.jpg'] }))
    .toContainSequence(['--image', '/a.png', '--image', '/b.jpg', '-']);
});
```

```ts
test('keeps text-only args unchanged', () => {
  expect(buildCodexNativeExecArgs({ cwd: '/tmp', prompt: 'x' }))
    .not.toContain('--image');
});
```

### Regression traps

- Passing prompt as argv and accidentally truncating/escaping long prompts.
- Deleting artifact file in finally before Codex has read it.
- Allowing arbitrary renderer-supplied paths into `--image`.
- Hiding Codex auth errors behind `Attachment failed`.
- Treating Codex CLI `turn.completed` as image-understood proof without response content.

## File-by-file implementation plan

### claude_team

Potential files:

```text
src/features/agent-attachments/main/adapters/output/CodexNativeAttachmentAdapter.ts
src/features/agent-attachments/main/infrastructure/AttachmentArtifactStore.ts
src/main/services/team/TeamProvisioningService.ts
src/main/ipc/teams.ts
```

Keep the desktop side responsible for app-owned artifact paths.

### agent_teams_orchestrator

Potential files:

```text
src/services/codexNative/turnExecutor.ts
src/services/codexNative/execRunner.ts
src/services/codexNative/*.test.ts
```

Make the orchestrator change backward compatible by defaulting `imagePaths` to `[]`.

## Integration contract between repos

If the desktop already invokes orchestrator through a structured prompt, add image paths explicitly rather than hiding them in text.

Preferred:

```ts
interface NativeRuntimePromptEnvelope {
  text: string;
  attachments?: Array<{
    kind: 'image-file';
    path: string;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    sha256: string;
  }>;
}
```

Avoid:

```text
Here is an image: /tmp/foo.png
```

unless the runtime explicitly cannot accept images and user chose a textual fallback.

## Artifact security rules

- Renderer never supplies final file path.
- Backend chooses artifact path under app-owned directory.
- Path traversal in filename is sanitized.
- Artifact path passed to Codex is absolute.
- Artifact checksum is verified after write.
- Artifact metadata does not include API keys or user prompt text.

## More detailed edge cases

| Edge case | Expected behavior |
|---|---|
| Codex process starts but exits before reading image | surface exact Codex stderr/exit code |
| Artifact file exists but unreadable due permissions | fail before spawn if detectable |
| Two sends with same image and same message id | reuse same artifact variant |
| Two sends with same image but different message id | allow separate metadata, optionally same content-addressed blob |
| Image path has non-ASCII filename | store sanitized ASCII filename plus metadata originalName |
| User cancels send during artifact write | abort write if supported, cleanup temp file |
| Codex CLI changes `--image` flag | tests fail at args builder/live smoke before release |

## Test code skeleton

```ts
describe('CodexNativeAttachmentAdapter', () => {
  it('materializes image variant and returns codex image arg', async () => {
    const adapter = new CodexNativeAttachmentAdapter(fakeArtifactStore);
    const part = await adapter.prepare(ctx, imageAttachment);
    expect(part.part).toEqual({ kind: 'codex-image-arg', path: '/tmp/app/att/red.png' });
  });

  it('blocks PDF attachments', () => {
    const decision = adapter.canDeliver(ctx, pdfAttachment);
    expect(decision.allowed).toBe(false);
    expect(decision.blockers[0].code).toBe('attachment_runtime_unsupported');
  });
});
```

```ts
describe('buildCodexNativeExecArgs', () => {
  it('keeps stdin marker last with image args before it', () => {
    expect(buildCodexNativeExecArgs({ cwd: '/tmp', prompt: 'x', imagePaths: ['/a.png'] }))
      .toEqual(expect.arrayContaining(['--image', '/a.png', '-']));
  });
});
```

## Review checklist

- Existing text-only Codex tests still pass.
- `imagePaths` default is empty.
- No shell string command building for image paths.
- Missing image file fails before spawn where possible.
- Auth errors are not converted to attachment errors.
- The feature works with Codex subscription auth, not only API key.

## Phase 3 exit criteria

Phase 3 is complete only when:

- text-only Codex native still uses the same exec path;
- Codex image send uses `--image <path>` and stdin prompt;
- image paths come only from app-owned artifacts;
- missing artifact fails before spawn;
- unsupported PDFs/documents are blocked before Codex call;
- Codex auth errors remain exact;
- no OpenCode/Claude code changes are included except shared interfaces.

## Cross-repo sequencing

Recommended order:

1. Orchestrator: add optional `imagePaths` to Codex exec runner with tests.
2. Orchestrator: keep turn executor text-only behavior unless image paths are explicitly supplied.
3. Desktop: add Codex adapter that materializes image files.
4. Desktop: wire Codex adapter only for Codex native send path.
5. Live smoke Codex with `gpt-5.4-mini`.

Do not wire desktop before orchestrator can safely accept `imagePaths`.

## Backward compatibility in orchestrator

```ts
function normalizeExecOptions(options: CodexNativeExecOptions): Required<Pick<CodexNativeExecOptions, 'imagePaths'>> {
  return {
    imagePaths: options.imagePaths ?? [],
  };
}
```

Existing tests should not need imagePaths.

## Handling structured content blocks

If orchestrator receives Anthropic-style content blocks, only support image blocks when they already point to app-owned artifacts or can be materialized safely.

V1 preference:

```text
Desktop passes file paths, not base64 blocks, to Codex native.
```

If a direct orchestrator caller passes base64 image blocks, fail with clear TODO unless implementing materialization there too.

```ts
throw new Error('Codex native image blocks must be materialized to file paths before execution.');
```

This prevents duplicate artifact stores across repos.

## Codex path validation nuance

Do not require image file to be inside project cwd. Live test showed `/tmp` works. Requiring cwd-only would break app-owned artifact store. Instead require:

- absolute path;
- file exists;
- file extension/MIME allowed;
- size under budget;
- path was produced by trusted desktop adapter or trusted test input.

## More Codex tests

```ts
it('rejects relative image paths', async () => {
  await expect(runCodexNativeExec({ prompt: 'x', imagePaths: ['foo.png'] }))
    .rejects.toThrow(/absolute/i);
});
```

```ts
it('does not include image path in prompt stdin', async () => {
  const child = fakeCodexChild();
  await runner.run({ prompt: 'describe', imagePaths: ['/tmp/a.png'] });
  expect(child.stdin.end).toHaveBeenCalledWith('describe');
});
```

## More Codex bug traps

| Trap | Prevention |
|---|---|
| prompt accidentally becomes argv | assert `-` remains final arg |
| image path included twice | test exact args |
| artifact path deleted too early | keep artifacts with message retention |
| base64 path from renderer | backend-only artifact store |
| Codex auth failure hidden | do not catch provider errors as attachment errors |
| unsupported PDF converted to prompt text silently | block explicitly |

## Detailed Implementation Checklist

### Step 1 - Define desktop to orchestrator attachment contract

Codex native invocation details should stay in the runtime/orchestrator boundary. Desktop should pass managed artifact references, not raw arbitrary paths.

```ts
export interface CodexNativeAttachmentRequest {
  kind: 'image';
  artifactId: string;
  mimeType: 'image/png' | 'image/jpeg';
  absolutePath: string;
  sizeBytes: number;
}
```

Validation before crossing process boundary:

- Path must be under app-managed attachment artifact directory.
- MIME type must be PNG/JPEG for Phase 3.
- File must exist and match expected size budget.
- File path must not come directly from renderer.

### Step 2 - Add Codex adapter in desktop

Desktop adapter should produce a provider-neutral runtime request, not CLI args directly.

```ts
export function buildCodexAttachmentRuntimeRequest(input: {
  text: string;
  attachments: AgentAttachmentPayload[];
}): CodexRuntimePromptRequest {
  return {
    text: input.text,
    images: input.attachments.map((attachment) => ({
      path: selectBestImageArtifact(attachment, 'codex').path,
      mimeType: selectBestImageArtifact(attachment, 'codex').mimeType,
    })),
  };
}
```

### Step 3 - Add orchestrator CLI serialization

In orchestrator, serialize to Codex-native image args only at the final command builder.

Expected conceptual shape:

```ts
const args = ['exec', '--json', '--model', model];
for (const image of request.images) {
  args.push('--image', image.path);
}
args.push('-');
```

Do not use base64 text fallback.

### Step 4 - Preserve Codex auth behavior

Codex attachment changes must not modify:

- `CODEX_HOME` selection.
- ChatGPT subscription vs API key logic.
- `forced_login_method=chatgpt` propagation.
- existing diagnostics for “ChatGPT login is required”.

If Codex auth fails, the error should remain auth-specific, not attachment-specific.

## Codex-Specific Edge Cases

| Case | Expected behavior |
|---|---|
| Codex ChatGPT subscription logged out | Preserve existing login required diagnostic. |
| Codex API key mode selected but native subscription expected | Preserve existing auth mode diagnostic. |
| Image artifact path deleted before send | Delivery fails with artifact missing. |
| Large image after optimization | Block before Codex CLI. |
| Non-image file | Phase 3 does not route it through `--image`. |
| Multiple images | Pass repeated `--image` args if Codex supports them, otherwise enforce count 1 with clear warning. |
| Codex model without vision | Block based on capability matrix if known. |

## Cross-Repo Contract Test Idea

Add a small pure test in orchestrator for command building:

```ts
it('passes codex images as repeated --image args', () => {
  const command = buildCodexExecCommand({
    prompt: 'What color?',
    images: ['/tmp/a.png', '/tmp/b.jpg'],
  });

  expect(command.args).toContainSequence(['--image', '/tmp/a.png']);
  expect(command.args).toContainSequence(['--image', '/tmp/b.jpg']);
  expect(command.stdin).toBe('What color?');
});
```

Add desktop-side test for path safety:

```ts
it('rejects codex image paths outside managed artifact directory', () => {
  expect(() => validateManagedArtifactPath('/etc/passwd')).toThrow(/outside managed attachment directory/);
});
```

## Manual Codex QA

1. Confirm dashboard shows Codex ChatGPT account ready.
2. Send red-card image to Codex lead or member.
3. Expected answer: `red` or equivalent.
4. Send unsupported model if available and verify warning.
5. Send oversized optimized image and verify block before runtime call.
6. Temporarily invalidate Codex login and verify auth diagnostic remains clear.

## Phase 3 Exit Criteria

- Codex text-only prompt path unchanged.
- Codex image prompt uses native image channel, not base64 text.
- Codex auth diagnostics still match current behavior.
- Desktop never passes renderer-provided arbitrary file paths to orchestrator.
- One real Codex subscription visual smoke test passes.


## Implementation Safeguards

### Keep Codex login/session handling untouched

The recent launch stability work around Codex auth is fragile and should not be mixed with attachment delivery.

Do not change:

- Codex auth discovery.
- ChatGPT account vs API key selection.
- `CODEX_HOME` propagation.
- `forced_login_method=chatgpt` settings.
- preflight auth status copy.

Attachment support should sit after auth has already resolved.

### Avoid stdin bloat

Codex image paths should be CLI args or native request fields. The prompt on stdin should stay text-only.

Bad:

```ts
stdin = `${prompt}\n\nIMAGE_BASE64=${base64}`;
```

Good:

```ts
args.push('--image', managedImagePath);
stdin = prompt;
```

### Artifact lifetime

Codex runtime may read image files after process spawn. Do not delete artifacts immediately after creating command args.

Safe policy:

- Keep managed artifacts at least until delivery result is terminal.
- If message remains retryable, keep artifacts until retry window expires.
- Garbage collect old artifacts by age and reachability from message records.

### Codex retry edge cases

| Case | Safe behavior |
|---|---|
| Retry after artifact GC | Fail with artifact missing, do not send text-only replacement silently. |
| Retry after model switch | Revalidate capability and budgets. |
| Retry after Codex logout | Show auth error, preserve message. |
| Runtime exits after receiving image | Runtime diagnostic, not attachment validation failure. |

### Cross-repo PR checklist

Desktop repo:

- Produces provider-neutral image request.
- Validates managed artifact paths.
- Preserves message/ledger semantics.

Orchestrator repo:

- Converts request to Codex native args.
- Does not inspect renderer metadata.
- Redacts command diagnostics.
- Tests command builder with one and multiple images.


## Failure Injection Tests for Phase 3

```ts
describe('Codex native image delivery', () => {
  it('keeps prompt on stdin and images as args', () => {
    const command = buildCodexNativeCommand({
      prompt: 'What color?',
      images: [managedImage('/tmp/app/attachments/a.png')],
    });

    expect(command.stdin).toBe('What color?');
    expect(command.args).toContain('--image');
    expect(command.stdin).not.toContain('base64');
  });

  it('does not mask Codex login failure as attachment failure', async () => {
    const result = await runCodexImageDelivery(fakeCodexLoggedOut());

    expect(result.error.message).toMatch(/codex login|ChatGPT/i);
    expect(result.error.code).not.toBe('attachment_provider_rejected');
  });
});
```

## Codex Command Builder Invariants

- `--image` args must appear before prompt stdin is consumed if Codex CLI requires it.
- Paths must be absolute managed artifact paths.
- Do not shell-concatenate paths. Use argv array.
- Do not quote manually inside argv array.
- Do not pass images through environment variables.
- Do not write temp prompt files containing base64 image text.

## Codex Existing-Team Edge Case

Existing teams may have members created before attachment support. That must not matter. Attachment capability is based on current provider/model/runtime, not team creation date.

If old metadata lacks provider/model:

- Use existing compatibility probe behavior.
- Do not infer vision support from old inbox names.
- Block image send until team/member metadata is stable.

## Phase 3 Stop Conditions

Stop and reassess if:

- Codex image support requires changing auth detection.
- Codex CLI version in app runtime does not support `--image`.
- Image args only work in standalone shell but not app-managed runtime.
- Provider diagnostics start saying API key mode when ChatGPT subscription was selected.


## File-Level Implementation Plan

Desktop suggested files:

```text
src/features/agent-attachments/main/providers/codexAttachmentAdapter.ts
src/features/agent-attachments/main/providers/codexAttachmentAdapter.test.ts
```

Orchestrator suggested files:

```text
src/runtime/codex/codexImageArgs.ts
src/runtime/codex/codexImageArgs.test.ts
```

Use actual repo structure names during implementation, but keep this separation: desktop plans delivery, orchestrator serializes runtime command.

### Desktop adapter skeleton

```ts
export function buildCodexNativeAttachmentRequest(input: {
  text: string;
  attachments: AgentAttachmentPayload[];
}): CodexNativePromptRequest {
  return {
    text: input.text,
    images: input.attachments.map((attachment) => {
      const artifact = selectProviderImageArtifact(attachment, 'codex');
      return {
        artifactId: artifact.artifactId,
        path: artifact.absolutePath,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      };
    }),
  };
}
```

### Orchestrator command args skeleton

```ts
export function appendCodexImageArgs(args: string[], images: CodexRuntimeImage[]): void {
  for (const image of images) {
    assertManagedRuntimeImagePath(image.path);
    args.push('--image', image.path);
  }
}
```

Never build a shell string like:

```ts
`codex exec --image ${path}`
```

Use argv arrays only.

### Codex provider proof interaction

Codex image delivery should reuse existing delivery proof gates. Image delivery itself is not success.

Success examples:

- Visible direct reply to user.
- Correct `message_send` relay for delegated/peer path.
- Correct work-sync report for work-sync path.

Failure examples:

- Codex command exits before assistant message.
- Codex auth fails.
- Codex returns text saying it cannot inspect image.

The last one may still be a visible reply. Treat it as delivered but semantically unhelpful, not as transport failure.


## Phase 3 Deep Review Addendum

### Codex runtime compatibility probe

Before enabling Codex image delivery in UI, the app should know whether the configured Codex runtime supports image args.

Conservative options:

1. Static capability by known runtime version - 🎯 8   🛡️ 8.5   🧠 4, примерно `80-160` строк.
2. One-time local CLI help parse/cache - 🎯 7.5   🛡️ 8   🧠 5, примерно `120-220` строк.
3. Always attempt and surface provider error - 🎯 6   🛡️ 6.5   🧠 2, примерно `30-80` строк.

Recommended for release: option 1 if runtime version is already controlled by the app, otherwise option 2 with short cache.

Do not run expensive live Codex image probes on every composer render.

### Codex request lifecycle

```text
Composer send
  -> persist message and artifacts
  -> backend validates Codex capability
  -> desktop builds Codex runtime request
  -> orchestrator builds argv with --image
  -> Codex runtime produces response
  -> existing delivery proof gates decide delivered/failed
```

Every arrow should have tests or explicit diagnostics.

### Codex diagnostics examples

Good:

```text
Codex image delivery failed: optimized image artifact is missing. The message was saved but cannot be retried with the image.
```

```text
Codex ChatGPT login is required before sending image attachments.
```

Bad:

```text
Agent failed.
```

```text
Spawn failed.
```

unless process launch actually failed.


## Phase 3 Implementation Contract Addendum

### Codex DTO between desktop and orchestrator

Use a stable JSON-serializable shape.

```ts
export interface CodexImageAttachmentForRuntime {
  artifactId: string;
  path: string;
  mimeType: 'image/png' | 'image/jpeg';
  sizeBytes: number;
}

export interface CodexPromptRuntimeRequest {
  text: string;
  images?: CodexImageAttachmentForRuntime[];
}
```

Rules:

- `images` omitted or empty means exact text-only legacy behavior.
- `images` present means orchestrator appends native `--image` args.
- Unknown fields should be ignored or rejected consistently, not partially consumed.

### Codex compatibility check

If the app bundles/controls Codex CLI version, use static support knowledge. If not, parse `codex exec --help` once and cache whether `--image` exists.

Pseudo-code:

```ts
export async function detectCodexImageArgSupport(runtime: CodexRuntime): Promise<boolean> {
  const cached = codexImageSupportCache.get(runtime.binaryPath);
  if (cached) return cached.supported;

  const help = await runtime.run(['exec', '--help'], { timeoutMs: 5000 });
  const supported = /--image\b/.test(help.stdout + help.stderr);
  codexImageSupportCache.set(runtime.binaryPath, { supported, checkedAt: Date.now() });
  return supported;
}
```

Do not run this on every message send if it is slow.

### Codex error mapping table

| Error text category | Final classification |
|---|---|
| login required / ChatGPT session | provider auth/session error |
| unknown option `--image` | runtime does not support image attachments |
| file not found | attachment artifact missing |
| max tokens/quota | provider rejected message |
| model cannot inspect image | visible semantic response if delivered |

Business logic should not depend on fragile regex except for display cleanup. Prefer structured exit codes/known adapter failures where available.


## Implementation Readiness Addendum

### Definition of Ready for Phase 3

Before coding Phase 3:

- Phase 1 normalized artifact storage is in place.
- Codex text-only delivery tests are green.
- Orchestrator branch/worktree is aligned with desktop branch.
- Actual app-managed Codex runtime has been checked for image support.

### Cross-repo compatibility rule

Desktop must tolerate orchestrator without image support during development by failing safely before send, not by crashing runtime.

```ts
if (!runtimeCapabilities.codexImageArgs) {
  throw new AgentAttachmentError(
    'attachment_runtime_transport_failed',
    'Current Codex runtime does not support image attachments.'
  );
}
```

### Codex no-regression assertions

- Text-only Codex request shape unchanged when `images` is empty.
- Codex ChatGPT account mode still selected when user chose subscription.
- No `OPENAI_API_KEY` fallback is introduced for subscription image send.
- `CODEX_HOME` still points to expected local auth state.
- Provider auth errors are not swallowed by attachment adapter.

### Codex additional edge cases

| Edge case | Expected behavior |
|---|---|
| `--image` unsupported | Block with runtime unsupported diagnostic. |
| Two images but Codex supports one only | Block or reduce with explicit user choice, no silent drop. |
| Image path contains spaces | argv array handles it. Test it. |
| Image path contains shell metacharacters | argv array handles it. No shell interpolation. |
| Codex returns answer in non-English | Accept semantic visual answer if it clearly identifies image. |


## Final Phase 3 Acceptance Specs

### Spec 1 - Codex text-only no regression

```gherkin
Given a user sends a text-only message to a Codex target
When the runtime request is built
Then images is omitted or empty
And the existing Codex text-only path is used
And auth/session handling is unchanged
```

### Spec 2 - Codex image uses native args

```gherkin
Given a user sends a PNG image to Codex
When the orchestrator command is built
Then the prompt remains text-only stdin
And the image path is passed with --image argv
And no shell string interpolation is used
And no base64 appears in stdin
```

### Spec 3 - Codex runtime lacks image support

```gherkin
Given the configured Codex runtime does not support --image
When the user tries to send an image
Then the send is blocked or delivery fails before runtime prompt
And the diagnostic says Codex runtime does not support image attachments
And text-only Codex messages still work
```

### Phase 3 exact PR contract

The Phase 3 PR is acceptable only if:

- Desktop and orchestrator agree on DTO shape.
- Orchestrator command builder has argv tests.
- Codex auth tests or diagnostics are not weakened.
- Runtime support detection is cached or static, not repeated on every render.
- Paths with spaces are covered in tests.
- No API-key fallback is introduced for subscription mode.

### Codex failure copy examples

```text
Codex image delivery is unavailable because the configured Codex runtime does not support --image.
```

```text
Codex ChatGPT login is required before this image can be sent.
```

```text
Prepared image file is missing. Remove and attach the image again.
```


## Phase 3 Pre-Mortem and Extra Safeguards

### Likely Codex mistakes

| Mistake | Concrete prevention |
|---|---|
| `--image` command built through shell string | Use argv arrays only. |
| Image support check runs too often | Cache runtime capability. |
| API key mode accidentally used for subscription | Preserve selected auth mode and existing env rules. |
| Orchestrator receives desktop fields it ignores | Add contract test across DTO. |
| Runtime does not support image but UI allows send | Capability gate checks runtime support. |

### Cross-version DTO tolerance

During development, desktop and orchestrator can briefly be out of sync. The final merged state must be compatible, but code should fail clearly if mismatch happens.

```ts
export function assertCodexRuntimeUnderstandsImages(runtimeCaps: RuntimeCapabilities): void {
  if (!runtimeCaps.codexImages) {
    throw new AgentAttachmentError(
      'attachment_runtime_transport_failed',
      'This Codex runtime does not support image attachments yet.'
    );
  }
}
```

### Codex diagnostic redaction

If command args are included in diagnostics, redact paths if needed and never include prompt text with secrets.

Safe diagnostic:

```json
{
  "provider": "codex",
  "model": "gpt-5.4-mini",
  "imageCount": 1,
  "imageArgsUsed": true,
  "stdinBytes": 31
}
```

Unsafe diagnostic:

```json
{
  "stdin": "full user prompt with private text",
  "imageBase64": "..."
}
```


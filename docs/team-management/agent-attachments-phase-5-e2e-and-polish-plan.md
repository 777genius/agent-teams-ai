# Phase 5 - Cross-runtime attachment E2E, diagnostics, docs, and polish
⚠️ **Историческая документация**: Этот файл содержит дизайн-документацию. Фактическая реализация в `src/features/agent-attachments/` может отличаться от описанной архитектуры.

## Summary

Goal: make the completed attachment system observable, testable, and understandable for users before release.

Chosen approach: **small live smoke harness + deterministic diagnostics + UI copy polish + documentation**, with no new runtime semantics.

🎯 8.8   🛡️ 8.7   🧠 5.4  
Estimated change size: `180-320` LOC plus tests/docs.

This phase should happen after Claude, Codex, and OpenCode adapters are implemented. It should not introduce new delivery behavior.

## Deliverables

- live attachment smoke script;
- reusable test fixture image generator;
- user-visible diagnostics for unsupported models and oversized images;
- docs for supported runtimes/models;
- release checklist.

## Live smoke harness

Create a script that generates a deterministic image and runs each supported runtime.

Suggested location:

```text
scripts/smoke/agent-attachments-smoke.mjs
```

Sketch:

```ts
const cases = [
  {
    id: 'claude-subscription-streaming',
    runtime: 'claude',
    model: 'claude-haiku-4-5',
    expected: /red/i,
  },
  {
    id: 'codex-native-gpt-5-4-mini',
    runtime: 'codex',
    model: 'gpt-5.4-mini',
    expected: /red/i,
  },
  {
    id: 'opencode-openai-gpt-5-4-mini',
    runtime: 'opencode',
    model: 'openai/gpt-5.4-mini',
    expected: /red/i,
  },
  {
    id: 'opencode-openrouter-kimi-k2-6',
    runtime: 'opencode',
    model: 'openrouter/moonshotai/kimi-k2.6',
    envRequired: ['OPENROUTER_API_KEY'],
    expected: /red/i,
  },
  {
    id: 'opencode-openrouter-glm-4-5v',
    runtime: 'opencode',
    model: 'openrouter/z-ai/glm-4.5v',
    envRequired: ['OPENROUTER_API_KEY'],
    expected: /red/i,
  },
  {
    id: 'opencode-openrouter-glm-5-1-negative',
    runtime: 'opencode',
    model: 'openrouter/z-ai/glm-5.1',
    envRequired: ['OPENROUTER_API_KEY'],
    expectedUnsupported: true,
  },
];
```

The harness must:

- redact keys;
- use timeouts;
- kill child processes on timeout;
- write structured JSON result;
- skip cases when required auth/env is missing;
- never print base64 image content.

## Deterministic fixture image

Do not depend on external image files.

Generate a small valid PNG with Node `zlib` and CRC32, like the prototype did.

```ts
export function writeRedCardPng(path: string): void {
  // 320x240 red card with white center marker.
}
```

This avoids flaky fixtures and keeps smoke tests self-contained.

## Diagnostics UX

Add compact diagnostics wherever attachments are shown or rejected.

Examples:

```text
Sent 1 optimized image: screenshot.jpg, 1920x1080, 612 KB.
```

```text
Images are not supported by openrouter/z-ai/glm-5.1. Choose GLM 4.5V, Kimi K2.6, GPT-5.4-mini, Claude, or Codex.
```

```text
Attachment payload is too large after optimization: 8.4 MB serialized. Limit is 7.5 MB.
```

```text
OpenRouter is not connected in OpenCode. Connect OpenRouter before using this model.
```

## Copy diagnostics

When user copies diagnostics for a failed send, include:

```text
Attachment summary:
- files: 2
- optimized bytes: 1.2 MB
- estimated serialized payload: 1.7 MB
- target runtime: opencode
- target model: openrouter/z-ai/glm-5.1
- capability decision: unsupported image input
```

Do not include:

- base64;
- full API keys;
- bearer tokens;
- raw data URLs.

## Documentation

Add docs under:

```text
docs/team-management/agent-attachments.md
```

Contents:

- supported runtimes;
- supported model examples;
- unsupported model examples;
- why images may be resized;
- why some models cannot receive screenshots;
- troubleshooting auth/provider issues;
- how to run smoke tests.

## Release checklist

Before release:

- text-only messages still work for Claude/Codex/OpenCode;
- oversized image blocked before send;
- Claude image send works;
- Codex image send works;
- OpenCode OpenAI image send works;
- OpenCode OpenRouter Kimi works if key configured;
- OpenCode GLM 5.1 image is blocked or clearly marked unsupported;
- no base64 appears in logs, copied diagnostics, or UI error text;
- retry with attachments reuses artifacts or fails loudly;
- removing attachments clears warnings;
- unsupported model warning updates when model changes.

## E2E scenarios

### Scenario 1 - Claude lead screenshot

```text
Create/launch Claude team -> send screenshot to lead -> lead answers about image.
```

Expected:

- no process crash;
- message visible;
- optimized attachment notice visible;
- lead response received.

### Scenario 2 - Codex lead screenshot

```text
Create/launch Codex team -> send screenshot -> Codex sees image via --image.
```

Expected:

- artifact file created;
- Codex args include `--image`;
- no base64 in prompt text;
- response received.

### Scenario 3 - OpenCode supported model

```text
OpenCode Kimi K2.6 secondary -> direct user message with screenshot.
```

Expected:

- file part delivered;
- delivery proof still required;
- response visible.

### Scenario 4 - OpenCode unsupported model

```text
OpenCode GLM 5.1 secondary -> attempt screenshot send.
```

Expected:

- send blocked before model call;
- message explains model does not support image input;
- no fake queued/pending delivery;
- text-only send still works.

### Scenario 5 - Oversized multi-image send

```text
Attach 5 large screenshots.
```

Expected:

- optimizer reduces where safe;
- if still too large, send blocked;
- no partial delivery.

## Test plan

Suggested focused checks:

```bash
pnpm vitest run src/features/agent-attachments/**/*.test.ts test/main/ipc/teams.test.ts test/renderer/components/team/messages/MessageComposer.test.tsx
pnpm vitest run test/main/services/team/TeamProvisioningService.test.ts test/main/services/team/OpenCodePromptDeliveryLedger.test.ts
pnpm typecheck --pretty false
```

Live smoke only when requested:

```bash
node scripts/smoke/agent-attachments-smoke.mjs --case claude-subscription-streaming
node scripts/smoke/agent-attachments-smoke.mjs --case codex-native-gpt-5-4-mini
OPENROUTER_API_KEY=... node scripts/smoke/agent-attachments-smoke.mjs --case opencode-openrouter-kimi-k2-6
```

## Safety checklist

- Smoke harness redacts secrets.
- Live tests have timeouts and cleanup.
- Docs clearly separate transport support from model vision support.
- No new runtime behavior is introduced in this phase.

## Deep implementation details

### Live smoke output contract

The smoke script should write machine-readable JSON and concise console output.

```ts
export interface AttachmentSmokeResult {
  id: string;
  runtime: 'claude' | 'codex' | 'opencode';
  model: string;
  status: 'passed' | 'failed' | 'skipped';
  reason?: string;
  responseText?: string;
  durationMs: number;
  diagnostics: string[];
}
```

Console output example:

```text
PASS claude-subscription-streaming -> red
PASS codex-native-gpt-5-4-mini -> red
SKIP opencode-openrouter-kimi-k2-6 -> OPENROUTER_API_KEY not set
FAIL opencode-openrouter-glm-5-1-negative -> expected unsupported but got red
```

Never print secrets.

### Timeout wrapper

```ts
async function runWithTimeout<T>(label: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out`)), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
```

For child processes, abort must kill process group when possible.

### Redaction helper

```ts
export function redactAttachmentSmokeLog(input: string): string {
  return input
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, 'sk-or-v1-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:image/[REDACTED];base64,[REDACTED]');
}
```

### Docs structure

`docs/team-management/agent-attachments.md` should include:

```text
# Agent attachments

## Supported runtimes
## Supported image models
## Unsupported or unverified models
## Why screenshots are optimized
## Troubleshooting
## Running smoke tests
## Security and privacy notes
```

### UI polish details

Attachment preview should show:

```text
screenshot.jpg
1920x1080 - 612 KB - optimized
```

Unsupported model warning should include direct action:

```text
Change model
Remove image
```

Do not show internal provider ids only. Use friendly label when available:

```text
GLM 5.1 via OpenRouter
```

But copied diagnostics should include exact model id:

```text
modelId=openrouter/z-ai/glm-5.1
```

### More e2e cases

| Scenario | Expected |
|---|---|
| Text-only message after failed image send | succeeds normally |
| User removes unsupported image and sends text | no stale warning blocks send |
| User switches from GLM 5.1 to GLM 4.5V | warning clears and send allowed |
| User switches from OpenCode to Claude | OpenCode model warning disappears, Claude budget warning remains if oversized |
| OpenRouter key missing | OpenRouter smoke skipped, not failed |
| OpenRouter quota exhausted | smoke failed with provider quota diagnostic, no secret printed |
| Codex auth expired | Codex smoke failed with auth diagnostic, attachment system not blamed |
| Claude subscription over limit | Claude smoke failed with provider limit diagnostic, attachment system not blamed |

### Release readiness scoring

Before shipping, score each area:

| Area | Target score |
|---|---:|
| Text-only regression confidence | 9/10 |
| Oversized image protection | 9/10 |
| Claude image path | 8.5/10 |
| Codex image path | 8/10 |
| OpenCode OpenAI image path | 8/10 |
| OpenCode OpenRouter model gating | 7.5/10 |
| User-facing errors | 8.5/10 |

If any score is below target, do not release the whole attachment feature. Ship only earlier phases.

### Regression traps

- Smoke tests accidentally depend on local user secrets and fail in CI.
- UI says “image sent” when only optimization happened.
- Diagnostics copy includes data URL.
- Docs overpromise unknown OpenRouter models.
- Negative model smoke becomes flaky because provider upgrades model capability. If GLM 5.1 starts supporting images, update catalog and test expectation.

## File-by-file implementation plan

### Smoke script

Create:

```text
scripts/smoke/agent-attachments-smoke.mjs
```

Optional helper:

```text
scripts/smoke/lib/write-red-card-png.mjs
scripts/smoke/lib/redact-smoke-log.mjs
```

Do not put live smoke in normal test suite by default.

### Documentation

Create:

```text
docs/team-management/agent-attachments.md
```

Link it from:

```text
docs/team-management/debugging-agent-teams.md
```

only if it helps support/debugging.

### UI polish tests

Potential tests:

```text
test/renderer/components/team/messages/MessageComposer.test.tsx
test/renderer/utils/attachmentUtils.test.ts
src/features/agent-attachments/**/*.test.ts
```

## Smoke script behavior details

### CLI options

```bash
node scripts/smoke/agent-attachments-smoke.mjs --all
node scripts/smoke/agent-attachments-smoke.mjs --case codex-native-gpt-5-4-mini
node scripts/smoke/agent-attachments-smoke.mjs --json /tmp/attachment-smoke.json
```

### Skip logic

```ts
if (case.envRequired?.some(name => !process.env[name])) {
  return { status: 'skipped', reason: `${name} not set` };
}
```

Missing auth should be `failed` if the runtime is expected to be locally logged in, but OpenRouter env cases can be `skipped` if key absent.

### Child process cleanup

```ts
const child = spawn(command, args, { detached: true });
try {
  return await waitForResult(child, timeoutMs);
} finally {
  if (!child.killed) {
    try { process.kill(-child.pid!, 'SIGTERM'); } catch {}
  }
}
```

Be careful on macOS where process groups may differ. If not detached, kill child pid only.

## Docs examples

### Supported model section

```md
## Verified image-capable models

- Claude subscription via stream-json
- Codex native GPT-5.4-mini via `--image`
- OpenCode OpenAI GPT-5.4-mini
- OpenCode OpenRouter Kimi K2.6
- OpenCode OpenRouter GLM 4.5V
```

### Unsupported model section

```md
## Known unsupported or text-only models

- OpenCode OpenRouter GLM 5.1: accepts text but does not support image input in live smoke.
```

### Troubleshooting section

```md
If OpenCode says `Provider not found: openrouter`, connect OpenRouter in provider management or provide `OPENROUTER_API_KEY` for smoke tests.
```

## More polish edge cases

| Edge case | UI/docs behavior |
|---|---|
| User sees “not verified” for a model they know supports vision | docs explain conservative default and how to request/verify model |
| Live smoke passes for a previously unknown model | update capability catalog in separate commit |
| Provider changes model behavior | negative smoke catches mismatch, catalog updated deliberately |
| User reports model saw image but UI blocked | add override only after reproducing or provider metadata confirms |
| User reports image too blurry | adjust Phase 1 quality policy, not provider adapters |
| User reports process crashed with image | diagnostics should include payload bytes and runtime stderr tail, not base64 |

## Final release decision tree

```text
If Phase 1 is green but Phase 2 is risky -> ship safer budget validation only.
If Claude is green but Codex is flaky -> ship Claude only, keep Codex blocked.
If Codex is green but OpenCode model gate is incomplete -> ship Claude+Codex, keep OpenCode blocked.
If OpenCode OpenAI is green but OpenRouter is unstable -> allow OpenAI, block OpenRouter unknowns.
```

Do not hold safer early phases hostage to later dynamic OpenRouter model risk.

## Phase 5 exit criteria

Phase 5 is complete only when:

- smoke harness can run selected cases independently;
- smoke harness redacts secrets and data URLs;
- docs list verified and unsupported models separately;
- UI copy does not overpromise unknown models;
- copied diagnostics include enough metadata to debug without leaking payload;
- release checklist is green or explicitly scoped down.

## Smoke harness case definitions

```ts
const cases: AttachmentSmokeCase[] = [
  {
    id: 'claude-streaming-haiku',
    runtime: 'claude',
    command: 'node',
    args: ['scripts/smoke/runners/claude-sdk-image.mjs'],
    expected: /\bred\b/i,
    timeoutMs: 60_000,
  },
  {
    id: 'codex-native-gpt-5-4-mini',
    runtime: 'codex',
    command: 'codex',
    args: ['exec', '--json', '--skip-git-repo-check', '-C', '/tmp', '--model', 'gpt-5.4-mini', '--image', '$IMAGE', '-'],
    stdin: 'Look at the attached image. Reply with exactly one word: red, green, or blue.',
    expected: /\bred\b/i,
    timeoutMs: 90_000,
  },
  {
    id: 'opencode-openrouter-glm-5-1-negative',
    runtime: 'opencode',
    envRequired: ['OPENROUTER_API_KEY'],
    expectCapabilityBlocked: true,
  },
];
```

For negative cases after Phase 4, prefer testing the app capability gate rather than spending OpenRouter tokens calling known unsupported models.

## Diagnostics copy example

```text
Attachment delivery diagnostic
team: atlas-hq
recipient: jack
runtime: opencode
model: openrouter/z-ai/glm-5.1
attachments: 1 image
optimized bytes: 612 KB
estimated serialized bytes: 842 KB
capability: unsupported
reason: GLM 5.1 is text-only for image input in verified OpenCode/OpenRouter smoke.
```

No base64, no data URL, no API key.

## Documentation warnings

Docs must say:

```text
Verified model support can change. If a model starts or stops accepting images, update the capability catalog and smoke expectations in a separate commit.
```

Docs must not say:

```text
All OpenRouter models support screenshots.
```

## Final pre-release manual checklist

- Send text-only message to Claude lead.
- Send optimized image to Claude lead.
- Send text-only message to Codex lead.
- Send image to Codex lead.
- Send text-only direct message to OpenCode member.
- Send image to OpenCode OpenAI member.
- Send image to OpenCode Kimi K2.6 member if OpenRouter configured.
- Attempt image to OpenCode GLM 5.1 and confirm it blocks before send.
- Attempt oversized image and confirm it blocks before send.
- Copy diagnostics and confirm no data URL/base64/key.

## Phase 5 bug traps

| Trap | Prevention |
|---|---|
| live smoke consumes tokens in normal CI | not part of default test command |
| smoke fails due missing auth and blocks release | missing optional env is skipped, not failed |
| docs become stale | capability catalog references live smoke date |
| unsupported negative model changes behavior | update catalog/test explicitly |
| copied diagnostics leak image data | redaction unit tests |

## Detailed E2E Matrix

Use one tiny deterministic image fixture: a red square with no metadata dependencies.

| Provider path | Model | Prompt | Expected |
|---|---|---|---|
| Claude subscription | current configured Claude model | `What color is the square? One word.` | `red` |
| Codex subscription | `gpt-5.4-mini` or available vision model | same | `red` |
| OpenCode OpenAI | `openai/gpt-5.4-mini` | same | `red` |
| OpenCode OpenRouter | `openrouter/moonshotai/kimi-k2.6` | same | `red` |
| OpenCode OpenRouter | `openrouter/z-ai/glm-4.5v` | same | `red` |
| OpenCode OpenRouter | `openrouter/z-ai/glm-5.1` | same | blocked/unsupported |

## Negative E2E Matrix

| Scenario | Expected |
|---|---|
| Oversized image | UI blocks before send with size/optimization details. |
| Corrupt image | UI blocks with decode error. |
| Missing optimized artifact | Delivery fails actionable, message preserved. |
| Provider quota exhausted | Provider diagnostic shown, no generic spawn failed. |
| Codex logged out | Existing Codex login diagnostic shown. |
| OpenCode model no vision | Unsupported warning/block shown. |
| Multiple images over total budget | Deterministic budget warning. |
| Runtime exits after send | Runtime exit diagnostic separate from attachment validation. |

## Automated Test Layers

### Pure tests

- Budget selection.
- Capability resolution.
- MIME/type classification.
- Provider adapter serialization.
- Redaction.

### Main process tests

- IPC validation rejects invalid attachment ids.
- Backend never accepts raw renderer paths.
- Missing artifacts produce controlled failure.
- Delivery failure does not mutate launch state.

### Renderer tests

- Preview and optimization warnings.
- Target switching recomputes capability warning.
- Send button blocks unsupported attachments.
- Removing attachments clears warnings.

### Safe E2E tests

- Provider command builders receive native attachment parts.
- One real smoke per supported provider before release.

## Release Checklist

Before enabling broadly:

- `pnpm typecheck --pretty false` passes.
- Focused attachment pure tests pass.
- Existing team launch tests still pass.
- Existing OpenCode delivery tests still pass.
- At least one real visual smoke is green for Claude, Codex, and OpenCode.
- No new dependency is added without version/license check.
- App logs do not contain raw base64 image data.
- Copy diagnostics redacts paths/secrets where required.
- User-facing warnings are clear and actionable.

## Observability Additions

Add lightweight diagnostics that help debug without leaking content.

Safe diagnostic fields:

```ts
interface AttachmentDiagnosticSummary {
  attachmentCount: number;
  totalBytes: number;
  optimizedTotalBytes: number;
  providers: string[];
  blockedReason?: AttachmentDeliveryFailureCode;
  warningCodes: string[];
}
```

Unsafe diagnostic fields:

- Base64 content.
- Full OCR/text extracted from images.
- Provider API keys.
- User home directory paths unless already part of explicit local diagnostics.
- Full binary file hashes if privacy-sensitive.

## Post-Release Monitoring

Watch for these regressions after release:

- Users report team going offline after sending images.
- Users report image sent but model says it cannot see image on a supposedly vision-capable model.
- Inbox/message JSON grows unexpectedly large.
- Renderer memory spikes after attaching multiple screenshots.
- Codex/OpenCode diagnostics become generic after attachment failures.
- Retry loops repeat the same image message without bounded attempts.

If any happen:

1. Disable only affected provider adapter path.
2. Keep normalization and UI warnings if stable.
3. Preserve messages and attachment metadata for forensic debugging.
4. Do not revert unrelated bootstrap/process backend changes in the same hotfix.

## Final Safety Review Questions

Before implementation starts, answer these in the PR description:

- Does any provider receive base64 as plain text? If yes, why is that unavoidable?
- Can renderer force backend to read an arbitrary file path? It must not.
- What happens if optimized artifact is deleted before retry?
- What happens if user switches target model after attaching image?
- What happens if a provider supports text but not vision?
- Does this change launch readiness or only message delivery?
- Are all retries bounded by existing ledger/runtime rules?


## Deep Verification Plan

### Deterministic fixture generation

Keep fixture generation local and deterministic so E2E does not depend on external image files.

```ts
export async function createRedSquareFixture(path: string): Promise<void> {
  // Use a tiny PNG fixture committed to test fixtures, or generate with deterministic bytes.
}
```

Preferred:

- Commit a tiny PNG fixture under test fixtures if repository policy allows binary fixtures.
- Otherwise generate once in test setup using a deterministic encoder.

### E2E assertion style

Do not require exact model wording. Normalize response and assert semantic color.

```ts
function answerMentionsRed(text: string): boolean {
  return /\bred\b/i.test(text) || /красн/i.test(text);
}
```

Avoid accepting `I cannot view images` as pass.

### E2E timeout strategy

- Provider smoke tests should have generous but bounded timeout.
- Failure should print provider/model, delivery path, and redacted stderr tail.
- One provider failure should not hide other provider results.

### Release-blocking vs non-blocking tests

Release-blocking:

- Pure unit tests.
- Serialization tests.
- One Claude smoke if Claude support is enabled.
- One Codex smoke if Codex support is enabled.
- One OpenCode OpenAI smoke if OpenCode image support is enabled for OpenAI.

Non-blocking/manual before release:

- Multiple OpenRouter model smokes.
- Very large image performance test.
- HEIC/clipboard platform-specific tests.

### User documentation checklist

Document these user-facing facts:

- Screenshots are automatically optimized before sending.
- Some OpenCode models do not support image attachments.
- If a model cannot receive images, the UI will ask the user to switch model or remove images.
- Raw files are not pasted as base64 into messages.
- If delivery fails, the message is preserved and the error explains whether it was size, model support, auth, quota, or runtime.

### Final PR template section

Each implementation PR should include:

```md
## Attachment safety checklist

- [ ] Text-only messages unchanged.
- [ ] No base64 plain-text prompt fallback.
- [ ] Backend validates attachment ids and paths.
- [ ] Unsupported model behavior tested.
- [ ] Provider auth errors remain provider auth errors.
- [ ] Delivery failure does not mark teammate offline unless runtime exits.
- [ ] Copy diagnostics redacts secrets.
- [ ] E2E smoke listed or intentionally deferred.
```


## Failure Injection E2E Scenarios

These should be run after unit coverage is green.

### Runtime survives attachment failure

1. Start a team with one known working member.
2. Send unsupported oversized image.
3. Verify send is blocked or delivery fails without marking team/member offline.
4. Send text-only message afterward.
5. Verify member still responds.

### Provider auth failure remains auth failure

1. Temporarily use stale/invalid provider auth in test environment.
2. Send image message.
3. Verify diagnostics mention auth/login, not image unsupported.
4. Restore auth.

### Non-vision model blocked

1. Select known non-vision OpenCode model.
2. Attach image.
3. Verify UI blocks before delivery.
4. Remove image.
5. Verify text-only send works.

### Artifact missing on retry

1. Save message with image artifact.
2. Delete artifact file in test harness before retry.
3. Trigger retry.
4. Verify `attachment_artifact_missing` and no text-only fallback.

## Release Candidate Checklist

A release candidate can include attachment support only if:

- All Phase 1 pure/domain tests pass.
- Provider enabled in UI has at least one real visual smoke test green.
- Unsupported model UX has been manually verified.
- Copy diagnostics includes attachment error code and provider/model, but no base64.
- Team launch tests are unchanged or green.
- Existing user message delivery tests are green.
- OpenCode proof repair tests are green.
- Codex auth/preflight tests are green.

## Suggested rollout order in release notes

1. “Image attachments are optimized before sending.”
2. “Claude and Codex vision-capable models receive screenshots through native image channels.”
3. “OpenCode image support depends on the selected model. The UI warns when a model is not image-capable.”
4. “Unsupported images are blocked with actionable diagnostics instead of being pasted as text.”

## Post-Implementation Audit Checklist

After all phases are implemented, search the codebase for these anti-patterns:

```text
base64,
data:image,
--image,
-f,
attachment_provider_rejected,
attachment_model_unsupported,
launch-state,
spawnStatus,
bootstrapConfirmed
```

Audit goals:

- `base64` appears only in provider-native block serialization or tests.
- `data:image` is not inserted into prompt text.
- `--image` appears only in Codex command builder and tests.
- `-f` image usage appears only in OpenCode adapter/command builder and tests.
- Attachment failures do not write launch-state/spawn status.
- Bootstrap code does not import attachment modules.


## Implementation Completion Checklist by Phase

### Phase 1 completion evidence

Attach to PR:

- Unit test output for budget/validation/capability modules.
- Screenshot of composer warning for unsupported/oversized image.
- Screenshot of optimized image metadata display if UI exposes it.
- Confirmation that no provider delivery code changed.

### Phase 2 completion evidence

Attach to PR:

- Claude serialization test output.
- Real Claude visual smoke result.
- Text-only Claude regression result.
- Diagnostic screenshot for oversized image block.

### Phase 3 completion evidence

Attach to PR:

- Codex command builder test output.
- Real Codex visual smoke result using subscription mode.
- Confirmation Codex auth diagnostics unchanged.
- Confirmation no shell string command construction was added.

### Phase 4 completion evidence

Attach to PR:

- OpenCode capability matrix tests.
- OpenCode OpenAI visual smoke result.
- OpenRouter Kimi/GLM visual smoke results if enabled.
- Unsupported GLM/non-vision model warning screenshot.
- Confirmation OpenCode proof repair lifecycle unchanged.

### Phase 5 completion evidence

Attach to PR:

- Full focused test list.
- Manual smoke matrix with provider/model/date.
- Known limitations section.
- Release note draft.

## Final bug-prevention checklist

Before merging the final phase, manually inspect these concerns:

- Does every provider adapter have tests for empty attachments and image attachments?
- Does every adapter reject unsupported MIME types?
- Does every adapter avoid changing text-only behavior?
- Does any code parse provider error text to decide model capability? It should not.
- Does any code write attachment failures into launch state? It must not.
- Does any code drop attachments silently? It must not.
- Does unsupported model UI block send or require explicit user action? It should.
- Does retry preserve attachment identity? It must.
- Does artifact missing produce a clear error? It must.

## Honest risk estimate after this planning

If implemented phase-by-phase exactly as planned:

- Phase 1 risk: `2.5/10`
- Phase 2 risk: `3/10`
- Phase 3 risk: `4/10`
- Phase 4 risk: `5/10`
- Phase 5 risk: `2/10`
- Overall release risk: `3.5/10`

If implemented as one broad refactor:

- Overall release risk: `7/10`

Main reason: the dangerous part is not image resizing itself. The dangerous part is accidentally coupling attachments to delivery proofs, runtime liveness, auth diagnostics, or provider-specific launch code.


## Phase 5 Deep Review Addendum

### Cross-provider E2E script shape

A single script can reduce manual drift, but it should not be required for normal unit tests.

Conceptual CLI:

```bash
pnpm tsx scripts/smoke-agent-attachments.ts \
  --provider claude \
  --model current \
  --image test/fixtures/red-square.png
```

Output should be machine-readable enough for logs:

```json
{
  "provider": "codex",
  "model": "gpt-5.4-mini",
  "image": "red-square.png",
  "result": "pass",
  "answerPreview": "red",
  "durationMs": 18432
}
```

### E2E failure report template

When an image smoke fails, report:

```text
Provider: OpenCode
Model: openrouter/z-ai/glm-5.1
Expected: red
Observed: I cannot view images
Classification: model_not_vision_capable
Action: keep blocked/unsupported in capability matrix
```

Do not report it as generic runtime failure.

### Manual release drill

Before release, do this exact drill:

1. Start app fresh.
2. Create or open a simple team with Claude lead.
3. Send text-only message, confirm normal reply.
4. Send one screenshot to Claude, confirm visual answer.
5. Switch to Codex member, send same screenshot, confirm visual answer.
6. Switch to OpenCode vision member, send same screenshot, confirm visual answer.
7. Switch to OpenCode unsupported model, confirm UI blocks image.
8. Send text-only to unsupported model, confirm it still works.
9. Restart app, verify messages render and attachments do not disappear.
10. Copy diagnostics from failed unsupported send, verify no base64/secrets.

### Final release confidence rating target

Do not ship broad attachment support unless confidence reaches:

- 🎯 at least `8.5/10` for Claude.
- 🎯 at least `8/10` for Codex.
- 🎯 at least `7.5/10` for OpenCode vision-capable known models.
- 🛡️ at least `9/10` that unsupported models fail safely.
- 🛡️ at least `9/10` that launch/readiness is unaffected.


## Phase 5 Implementation Contract Addendum

### Test command matrix

Focused checks after each phase should be small and targeted.

Phase 1:

```bash
pnpm vitest run test/features/agent-attachments/budgets.test.ts test/features/agent-attachments/validation.test.ts
pnpm typecheck --pretty false
```

Phase 2:

```bash
pnpm vitest run test/features/agent-attachments/claudeAttachmentAdapter.test.ts
pnpm vitest run test/main/services/team/TeamProvisioningServiceRelay.test.ts
```

Phase 3:

```bash
pnpm vitest run test/features/agent-attachments/codexAttachmentAdapter.test.ts
# plus orchestrator codex command builder test in agent_teams_orchestrator
```

Phase 4:

```bash
pnpm vitest run test/features/agent-attachments/opencodeAttachmentAdapter.test.ts
pnpm vitest run test/main/services/team/OpenCodePromptDeliveryLedger.test.ts test/main/services/team/OpenCodePromptDeliveryWatchdog.test.ts
```

Phase 5:

```bash
pnpm typecheck --pretty false
pnpm vitest run test/features/agent-attachments/**/*.test.ts
```

Exact test paths may change during implementation, but the test categories should remain.

### Smoke result ledger

Create a simple markdown table in PR or docs after live smokes:

| Date | Provider | Model | Runtime path | Result | Notes |
|---|---|---|---|---|---|
| 2026-05-09 | Claude | current | app team delivery | pass | red-square -> red |
| 2026-05-09 | Codex | gpt-5.4-mini | app team delivery | pass | red-square -> red |
| 2026-05-09 | OpenCode | openai/gpt-5.4-mini | app team delivery | pass | red-square -> red |

This prevents accidental reliance on standalone prototype results when app path differs.

### Final implementation order reminder

Do not start with provider adapters. Start with Phase 1 domain and storage because provider adapters need a stable input contract.

Correct order:

1. Normalize and persist artifacts safely.
2. Block unsupported/oversized sends.
3. Add Claude adapter.
4. Add Codex adapter.
5. Add OpenCode adapter.
6. Add E2E and docs polish.

Wrong order:

1. Hack provider CLI args.
2. Later figure out storage.
3. Later figure out UI warnings.
4. Later discover retries lost files.


## Implementation Readiness Addendum

### Definition of Ready for Phase 5

Before Phase 5:

- All provider adapters have unit tests.
- At least one provider image path works in app-managed runtime.
- Unsupported model UX exists.
- Diagnostics taxonomy is implemented.

### Fixture strategy

Prefer one committed tiny PNG fixture plus optional generated variants.

Fixtures:

```text
test/fixtures/attachments/red-square.png
test/fixtures/attachments/red-square-large.png
test/fixtures/attachments/corrupt.png
test/fixtures/attachments/not-image.txt
```

If binary fixtures are not desired, generate in test setup, but keep generation deterministic.

### Smoke classification helper

```ts
export function classifyVisualSmokeAnswer(answer: string): 'pass' | 'refusal' | 'wrong' | 'empty' {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return 'empty';
  if (/cannot|can't|unable|view|image/.test(normalized) && !/red/.test(normalized)) return 'refusal';
  if (/\bred\b|красн/.test(normalized)) return 'pass';
  return 'wrong';
}
```

Do not overfit this helper to one provider. It is only for smoke classification.

### Release notes limitations section

Document limitations honestly:

```md
Known limitations:

- Image support depends on selected provider and model.
- Some OpenCode/OpenRouter models are intentionally blocked until verified for vision.
- Very large images are optimized and may lose some detail.
- Non-image files continue using existing file behavior and are not part of the new image pipeline.
```

### Final post-merge watchlist

For the first release after merge, watch for:

- Increased renderer memory usage after attaching screenshots.
- Any report of team launch failures after sending images.
- Any report that images appear in message text as base64.
- Any OpenCode model that should be marked unsupported.
- Any Codex auth diagnostic regression.
- Any failed retry due to missing artifacts.


## Final Phase 5 Acceptance Specs

### Spec 1 - cross-provider visual smoke matrix

```gherkin
Given the red-square fixture
When visual smoke runs for each enabled provider path
Then every supported provider/model answers red
And every unsupported model is blocked or classified unsupported
And no failure is reported as generic spawn failure
```

### Spec 2 - diagnostics are safe

```gherkin
Given an attachment delivery fails
When the user copies diagnostics
Then diagnostics include provider, model, failure code, and redacted reason
And diagnostics do not include base64 image bytes
And diagnostics do not include API keys or bearer tokens
```

### Spec 3 - launch unaffected

```gherkin
Given a team launches without attachments
When launch completes
Then launch behavior matches pre-attachment behavior
And no attachment module participates in bootstrap readiness
```

### Phase 5 exact PR contract

The Phase 5 PR is acceptable only if:

- Smoke results are recorded with date/provider/model/runtime path.
- Unsupported model behavior is manually verified.
- Existing launch and delivery focused tests are green.
- Documentation explains limitations honestly.
- Release notes avoid promising universal vision support.
- Post-merge watchlist is included in release checklist.

### Final “do not ship if” list

Do not ship if any of these are true:

- Text-only messages regress for any provider.
- Any provider receives base64 as plain prompt text.
- Unsupported OpenCode models silently accept image messages.
- Attachment failure marks teammate spawn failed without runtime exit evidence.
- Codex subscription auth diagnostics regress.
- Image retry can silently send text without the original image.
- Copy diagnostics leaks base64 or secrets.


## Phase 5 Pre-Mortem and Extra Safeguards

### Likely verification mistakes

| Mistake | Prevention |
|---|---|
| Standalone provider smoke passes but app path fails | Smoke through app-managed team delivery. |
| E2E accepts refusal as pass | Use classifier that rejects “cannot view image”. |
| Only happy path tested | Include unsupported model, artifact missing, and auth failure. |
| Logs leak base64 | Copy diagnostics test searches for base64 markers. |
| Release notes overpromise | Explicit known limitations section. |

### Copy diagnostics acceptance test

```ts
it('copy diagnostics omits image bytes and secrets', () => {
  const text = buildAttachmentFailureDiagnostics(fakeImageFailure());
  expect(text).toContain('attachment_model_unsupported');
  expect(text).not.toContain('data:image');
  expect(text).not.toMatch(/[A-Za-z0-9+/]{200,}={0,2}/);
  expect(text).not.toMatch(/sk-[a-zA-Z0-9_-]+/);
});
```

### App-path smoke script must prove route

Smoke result should include route:

```json
{
  "route": "user->lead",
  "teamName": "attachment-smoke-claude",
  "provider": "anthropic",
  "model": "current",
  "attachmentTransport": "claude_structured_blocks",
  "result": "pass"
}
```

If route is standalone CLI only, mark as prototype evidence, not release evidence.

### Release manager checklist

- Read all `Do not ship if` items.
- Confirm no broad feature flag remains.
- Confirm capability gates are user-visible product behavior.
- Confirm no launch/provisioning files import attachment modules.
- Confirm provider smoke evidence is app-path evidence.
- Confirm rollback by provider is possible without data migration.


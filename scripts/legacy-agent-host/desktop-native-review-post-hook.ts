import assert from 'node:assert/strict';
import { appendFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
// Audited SDK0.3.305 command-hook payload subset; SDK types stay private to D.
type NativeReviewHookInput = { cwd?: unknown; tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown } &
  ({ hook_event_name: 'PostToolUse'; } | { hook_event_name: 'PostToolUseFailure'; error?: unknown; is_interrupt?: unknown });
const argument = process.argv[2];
assert.ok(argument);
const root = await realpath(argument);
assert.equal(root, argument); assert.match(basename(root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
const chunks: Buffer[] = [];
for await (const raw of process.stdin) chunks.push(Buffer.from(raw as Uint8Array));
const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as NativeReviewHookInput;
assert.equal(input.cwd, join(root, 'workspace'));
assert.ok(input.tool_input && typeof input.tool_input === 'object');
if (input.hook_event_name === 'PostToolUseFailure') {
  assert.equal(input.tool_name, 'Bash'); assert.equal(input.tool_use_id, 'native_review_work_3');
  assert.ok(typeof input.error === 'string' && input.error.length > 0);
  assert.notEqual(input.is_interrupt, true);
  assert.equal((input.tool_input as Record<string, unknown>).command,
    "printf 'FAILED\\n' >> native-review-failed.txt; exit 7");
} else {
  assert.equal(input.hook_event_name, 'PostToolUse');
  assert.equal(input.tool_name, 'Write'); assert.equal(input.tool_use_id, 'native_review_work_4');
  assert.equal((input.tool_input as Record<string, unknown>).file_path, join(root, 'workspace/native-review-write.txt'));
}
const log = join(root, 'native-review-post-hook.ndjson');
const entry = { toolUseId: input.tool_use_id, hookEvent: input.hook_event_name };
await appendFile(log, JSON.stringify({ phase: 'started', ...entry }) + '\n');
await new Promise<void>(resolve => setTimeout(resolve, 600));
if (input.hook_event_name === 'PostToolUseFailure') {
  await appendFile(join(root, 'workspace/native-review-failed.txt'), 'FAILED_HOOK\n');
  await appendFile(join(root, 'workspace/native-review-failure-hook-side.txt'), 'FAILURE_HOOK_LATE\n');
} else {
  await appendFile(join(root, 'workspace/native-review-write.txt'), 'HOOK_LATE\n');
  await appendFile(join(root, 'workspace/native-review-hook-side.txt'), 'HOOK_LATE\n');
}
await appendFile(log, JSON.stringify({ phase: 'finished', ...entry }) + '\n');
process.stdout.write('{}\n');

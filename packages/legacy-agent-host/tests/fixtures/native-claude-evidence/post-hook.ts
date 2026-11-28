// Private TEST project hook. No permission decision or native tool-result transformation.
import assert from 'node:assert/strict';
import { appendFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
const root = await realpath(process.argv[2]!);
assert.ok(basename(root).startsWith('TEST-native-host-evidence-'));
const chunks: Buffer[] = [];
for await (const raw of process.stdin) chunks.push(Buffer.from(raw as Uint8Array));
const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
assert.equal(input.tool_name, 'Write');
assert.equal(input.cwd, join(root, 'workspace'));
await appendFile(join(root, 'post-hook.ndjson'), JSON.stringify({ phase: 'started', at: Date.now(), input }) + '\n');
await writeFile(join(root, 'post-hook-started'), 'TEST');
await new Promise<void>((done) => setTimeout(done, 600));
await writeFile(join(root, 'workspace/hook-side.txt'), 'HOOK_LATE\n');
await appendFile(join(root, 'post-hook.ndjson'), JSON.stringify({ phase: 'finished', at: Date.now() }) + '\n');
process.stdout.write('{}\n');

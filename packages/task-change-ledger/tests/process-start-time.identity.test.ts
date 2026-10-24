import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createProcessStartTimeCache,
  readProcessStartTimeMs,
} from '../dist/review/storage/index.js';

test('public portable probe reads actual TEST child identity and absent PID without provider runtime', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-portable-start-time-')));
  const child = spawn(
    process.execPath,
    ['-e', 'process.stdout.write("TEST ready\\n"); process.stdin.resume();'],
    {
      cwd: root,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  let exited = false;
  const closed = once(child, 'close').then(() => {
    exited = true;
  });
  t.after(async () => {
    if (!exited) {
      child.stdin.end();
      child.kill('SIGTERM');
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  await once(child.stdout, 'data');
  assert.ok(child.pid);
  const cached = createProcessStartTimeCache((pid) => readProcessStartTimeMs(pid));
  const [first, joined] = await Promise.all([cached(child.pid), cached(child.pid)]);
  assert.equal(typeof first, 'number');
  assert.ok(first! > Date.now() - 60_000 && first! <= Date.now());
  assert.equal(joined, first);
  assert.equal(await readProcessStartTimeMs(child.pid), first);
  child.stdin.end();
  await closed;
  assert.equal(await readProcessStartTimeMs(child.pid), null);
});

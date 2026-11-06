import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

test('original root EOF cleans both owned foreground services before any UI Stop', { timeout: 20_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  await mkdir(join(root, 'workspace'));
  for (const name of ['process-controlled-root.ts', 'process-foreground-service.ts'])
    await copyFile(join(import.meta.dirname, name), join(root, 'workspace', name));
  const roles = { primary: { nonce: 'TEST-' + randomUUID() }, neighbor: { nonce: 'TEST-' + randomUUID() } };
  await writeFile(join(root, 'process-ui-seed.json'), JSON.stringify({ node: await realpath(process.execPath), roles }));
  const child = spawn(process.execPath, [join(root, 'workspace/process-controlled-root.ts'), root], { stdio: ['pipe', 'ignore', 'pipe'] });
  const exited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  try {
    for (const role of ['primary', 'neighbor'] as const) {
      let service: { pid: number; url: string } | undefined;
      for (const end = Date.now() + 8_000; Date.now() < end && !service;) {
        try { service = JSON.parse(await readFile(join(root, 'workspace', `process-${role}.json`), 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await delay(25); }
      }
      assert.ok(service);
      const response = await fetch(service.url, { signal: AbortSignal.timeout(2_000) });
      assert.deepEqual(await response.json(), { role, nonce: roles[role].nonce, pid: service.pid });
    }
  } finally {
    child.stdin.end();
    await exited;
  }
  assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
  const result = JSON.parse(await readFile(join(root, 'controlled-process-root-result.json'), 'utf8'));
  assert.equal(result.rootPid, child.pid); assert.equal(result.children.length, 2);
  for (const facts of result.children) {
    assert.equal(facts.cleanupSignals, 1); assert.equal(facts.exitCode, 0); assert.equal(facts.signalCode, null);
    const events = (await readFile(join(root, 'workspace', `process-${facts.role}-lifecycle.ndjson`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.event), ['listening', 'closing', 'closed']);
    assert.ok(events.every(event => event.pid === facts.pid));
    assert.equal(events[1].reason, 'SIGTERM'); assert.equal(events[2].reason, 'SIGTERM');
  }
});

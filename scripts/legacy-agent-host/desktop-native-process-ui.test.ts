import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { desktopProcessOwnerExpression } from './desktop-native-process-ui.ts';
import { waitForNativeProcessServices } from './desktop-native-process-model.ts';

const selection = 'TEST-owner', id = 'TEST-process';
const original = { id, processRef: 'TEST-original-ref', observation: 'same-live', canTerminate: true };
const stopped = { id, processRef: 'TEST-stopped-ref', observation: 'absent', stoppedAt: '2026-10-29T00:00:00Z', canTerminate: false };
function observe(candidates: Record<string, unknown>[], reference: string | null) {
  const fibers = candidates.map(process => ({ memoizedProps: { teamName: selection, processes: [process] }, alternate: null, return: null }));
  const node = { __reactFiber$test: { ...fibers[0], alternate: fibers[1], return: fibers[2] }, querySelectorAll: () => [] };
  return Function('document', 'return ' + desktopProcessOwnerExpression(selection, id, reference))({ querySelector: () => node });
}
test('post-Stop observer continues past stale original and pending alternate to fresh stopped props', () => {
  const pending = { ...stopped, pendingStop: { native: 'accepted' } };
  assert.deepEqual(observe([original, pending, stopped], null)?.process, stopped);
  assert.equal(observe([original, pending, { ...stopped, observation: 'unknown' }], null), null);
});
test('initial original-ref observation remains exact and cannot select a replacement ref', () => {
  assert.deepEqual(observe([stopped, original], original.processRef)?.process, original);
  assert.equal(observe([stopped], original.processRef), null);
});
test('background acceptance waits for atomic service publication without masking corrupt readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-service-readiness-'));
  const path = join(root, 'services.json');
  const services = { primary: { role: 'primary', nonce: 'TEST-primary', pid: 123, port: 1234, url: 'http://127.0.0.1:1234/TEST-primary' },
    neighbor: { role: 'neighbor', nonce: 'TEST-neighbor', pid: 456, port: 5678, url: 'http://127.0.0.1:5678/TEST-neighbor' } };
  let reads = 0;
  const publication = delay(100).then(async () => {
    await writeFile(path + '.pending', JSON.stringify(services), { flag: 'wx' });
    await rename(path + '.pending', path);
  });
  try {
    const actual = await waitForNativeProcessServices(async () => {
      reads++;
      return JSON.parse(await readFile(path, 'utf8')) as typeof services;
    });
    assert.deepEqual(actual, services);
    assert.ok(reads >= 2, 'initial missing publication was observed');
    await writeFile(path, '{');
    let invalidReads = 0;
    await assert.rejects(waitForNativeProcessServices(async () => {
      invalidReads++;
      return JSON.parse(await readFile(path, 'utf8')) as typeof services;
    }), SyntaxError);
    assert.equal(invalidReads, 1, 'present but invalid evidence is never retried');
    await assert.rejects(waitForNativeProcessServices(async () => {
      await readFile(join(root, 'never-published'));
      return services;
    }, 25), /did not publish before the deadline/);
  } finally { await publication; await rm(root, { recursive: true, force: true }); }
});

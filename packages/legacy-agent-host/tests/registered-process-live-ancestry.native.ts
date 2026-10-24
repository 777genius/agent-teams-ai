import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createQualifiedDarwinProcessApi } from '../dist/process/DarwinRegisteredProcess.js';
import type { RegisteredProcessCapture } from '../dist/process/registeredProcessContracts.js';
assert.equal(process.env.LEGACY_REGISTERED_PROCESS_NATIVE_GO, '1');
assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
assert.ok(process.env.HOME?.startsWith('/private/tmp/TEST-') && process.env.TMPDIR?.startsWith('/private/tmp/TEST-'));
const [artifactPath, artifactHash, actorPath, actorHash] = process.argv.slice(2);
assert.ok(artifactPath && artifactHash && actorPath && actorHash);
for (const [path, hash] of [[artifactPath, artifactHash], [actorPath, actorHash]]) {
  assert.ok(path && hash && path.startsWith('/private/tmp/TEST-')); assert.equal(await realpath(path), path);
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hash);
}
const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-ancestry-')));
console.log(JSON.stringify({ root, scope: 'Private native proof; audit tokens retained only in its0600 proof.ndjson' }));
const api = createQualifiedDarwinProcessApi({ path: artifactPath, sha256: artifactHash });
const registrar = { backendId: 'TEST-native', teamId: 'TEST-team', runId: 'TEST-run', memberId: 'TEST-member', generation: '1' };
const log = (fact: unknown) => appendFileSync(join(root, 'proof.ndjson'), JSON.stringify(fact) + '\n', { mode: 0o600 });
async function until(check: () => Promise<boolean>) {
  for (const deadline = Date.now() + 3000; Date.now() < deadline;) { if (await check()) return; await delay(20); }
  assert.fail('Finite original observation exhausted; no replay or replacement');
}
const exists = async (path: string) => readFile(path).then(() => true, () => false);
const roots: { name: string; child: ReturnType<typeof spawn>; closed: Promise<void> }[] = [];
async function start(name: string, mode: 'same' | 'cross') {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'fixtures/registered-process-parent.ts'), 'root', root, actorPath!, name, mode], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve())); roots.push({ name, child, closed });
  log({ phase: 'owned-original-spawn', name, pid: child.pid });
  const source = api.captureRoot(child, () => child.exitCode === null && child.signalCode === null); // Original handle, before first yield.
  child.stderr!.on('data', () => {});
  const target = await new Promise<number>((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('Finite TEST actor publication exhausted')), 3000);
    child.stdout!.on('data', (chunk: Buffer) => { text += chunk.toString(); const end = text.indexOf('\n'); if (end >= 0) { clearTimeout(timer); resolve((JSON.parse(text.slice(0, end)) as { pid: number }).pid); } });
  });
  assert.ok(Number.isSafeInteger(target) && target > 1); return { source, target, child, closed };
}
const capsules: RegisteredProcessCapture[] = [];
const observed = (capture: RegisteredProcessCapture) => { const state = api.observe(capture); log({ phase: 'observe-original', capture, state }); return state; };
try {
  const legacy = await start('legacy', 'same'), owned = await start('owned', 'cross'), peer = await start('peer', 'cross'), drift = await start('drift', 'cross');
  const v1 = legacy.source.capture(legacy.target, registrar), v2 = owned.source.capture(owned.target, registrar);
  const neighbor = peer.source.capture(peer.target, registrar), changing = drift.source.capture(drift.target, registrar);
  capsules.push(v1, v2, neighbor, changing);
  log({ phase: 'original-captures', v1, v2, neighbor, changing });
  assert.equal(v1.version, 1); assert.equal(v1.target.sessionId, v1.root.sessionId);
  assert.equal(v2.version, 2); if (v2.version !== 2) assert.fail('Explicit native ancestry admission required');
  assert.equal(v2.admission, 'live-ancestry-v1'); assert.notEqual(v2.target.sessionId, v2.root.sessionId);
  assert.throws(() => owned.source.capture(peer.target, registrar));
  await writeFile(join(root, 'owned.bridge-exit'), '', { flag: 'wx' });
  await until(() => exists(join(root, 'owned.bridge-gone')));
  assert.throws(() => owned.source.capture(owned.target, registrar), 'Late orphan cannot receive new lineage admission');
  assert.equal(observed(v2), 'same-live', 'Cold original target observation does not require surviving ancestors');
  await writeFile(join(root, 'drift.drift'), '', { flag: 'wx' }); await until(() => exists(join(root, 'drift.did-drift')));
  assert.equal(observed(changing), 'unknown', 'Same-token SID change never releases custody as stale');
  log({ phase: 'requested-before-native', target: changing }); assert.throws(() => api.signal(changing));
  log({ phase: 'requested-before-native', target: v2 }); assert.equal(api.signal(v2), 'accepted');
  await until(async () => ['absent', 'stale'].includes(observed(v2)));
  assert.equal(observed(neighbor), 'same-live', 'Exact original signal must leave neighboring private target alive');
  await writeFile(join(root, 'peer.root-exit'), '', { flag: 'wx' }); await peer.closed;
  assert.throws(() => peer.source.capture(peer.target, registrar), 'Reaped original root cannot admit any new target');
  assert.equal(observed(neighbor), 'same-live', 'Cold target lookup never walks/replaces a dead root');
  log({ phase: 'kernel-contract-assertions-completed', scope: 'Controlled kernel negatives; actual SDK background integration is a separate required proof' });
} finally {
  for (const { name } of roots) await writeFile(join(root, name + '.root-exit'), '', { flag: 'a' });
  await Promise.all(roots.map(row => row.closed));
  let absent = false;
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    if ((await Promise.all(roots.map(row => exists(join(root, row.name + '.closed'))))).every(Boolean) &&
        capsules.length === roots.length && capsules.every(capture => ['absent', 'stale'].includes(api.observe(capture)))) { absent = true; break; }
    await delay(100);
  }
  if (!absent) process.exitCode = 1;
  log({ phase: 'original-finite-cleanup-finished', originalTargetsAbsent: absent, scope: 'No numeric/group signal; actual target signal only from saved native capsule; all other TEST targets self-exit after12s' });
}

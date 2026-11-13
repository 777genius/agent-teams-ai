import assert from 'node:assert/strict';
import { once } from 'node:events';
import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeNativeHostInput, startHost } from './fixtures/native-host.ts';
import { createPassiveNativeDiagnosticCapture, readOriginalHostCpuProfile } from './fixtures/native-opencode-team/passive-diagnostics.ts';

test('a failed original Node child retains CPU evidence and bounded file refusals stay distinguishable', {
  timeout: 10000,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-cpu-exit1-')));
  const entry = join(root, 'TEST-exit1.mjs');
  const originalTrace = createPassiveNativeDiagnosticCapture();
  // Synthetic channel publications only; no HTTP/provider/Runtime is invoked by this sole finite child.
  writeFileSync(entry, `import { channel } from 'node:diagnostics_channel';
const secret = 'TEST-private-undici-token';
const publish = (name, request) => channel(name).publish({ request, headers: secret,
  socket: { privatePath: ${JSON.stringify(root)} }, chunk: Buffer.from(secret) });
for (const path of ['/api/plugin', '/api/model', '/api/info']) {
  const request = { origin: 'http://127.0.0.1:65530', path: path + '?private=' + secret, method: 'GET' };
  publish('undici:request:create', request);
  for (const name of ['undici:client:sendHeaders', 'undici:request:bodySent']) {
    publish(name, { ...request });
    publish(name, request);
    publish(name, request);
  }
}
const end = Date.now() + 50; while (Date.now() < end) Math.sqrt(Date.now()); process.exit(1);
`, { mode: 0o600 });
  const host = startHost({ node: process.execPath, entry, root, profile: join(root, 'TEST-profile.json'),
    profileHash: 'a'.repeat(64), testCpuProfile: true,
    testImports: [new URL('./fixtures/native-opencode-team/passive-diagnostics.ts', import.meta.url).href],
    onDiagnostic: chunk => originalTrace.accept(chunk, 1) });
  const originalClose = once(host.child, 'close');
  try {
    const [code, signal] = await once(host.child, 'exit');
    assert.equal(code, 1); assert.equal(signal, null);
    await assert.rejects(host.close(), /Host exit zero confirms/);
    await originalClose;
    assert.deepEqual(originalTrace.entries.map(row => [row.event, row.request, row.route]), [
      ['request', 1, 'plugins'], ['request-send-headers', 1, 'plugins'], ['request-body-sent', 1, 'plugins'],
      ['request', 2, 'model-catalog'], ['request-send-headers', 2, 'model-catalog'], ['request-body-sent', 2, 'model-catalog'],
      ['request', 3, 'info'],
    ], 'same-object targeted phases appear once; foreign objects and untargeted phases are ignored');
    assert.ok(originalTrace.entries.every(row => row.epoch === 1 && row.method === 'GET' &&
      typeof row.atMs === 'number' && (row.event === 'request' ? row.durationMs === null :
        typeof row.durationMs === 'number' && row.durationMs >= 0)));
    assert.equal(JSON.stringify(originalTrace.entries).includes('TEST-private-undici-token'), false);
    assert.equal(JSON.stringify(originalTrace.entries).includes(root), false);
    const path = host.testCpuProfilePath!;
    assert.equal(host.testCpuProfileIntervalUs, 10000);
    assert.ok(host.child.spawnargs.includes('--cpu-prof-interval=10000'));
    const result = await readOriginalHostCpuProfile(path, true, host.testCpuProfileIntervalUs);
    assert.equal(result.status, 'available');
    assert.equal(result.samplingIntervalUs, 10000);
    assert.equal(result.rawDiscarded, true);
    assert.equal(result.fileOverLimit, false);
    assert.ok(result.fileBytes !== undefined && result.fileBytes > 0 && result.fileBytes <= 16 * 1024 * 1024);
    assert.equal(JSON.stringify(result).includes(root), false, 'closed evidence has no source URLs or paths');
    assert.equal(existsSync(path), false);
    assert.deepEqual(await readOriginalHostCpuProfile(path, true), {
      status: 'unavailable', reason: 'missing', rawDiscarded: true,
    });
    writeFileSync(path, '', { mode: 0o600 });
    assert.deepEqual(await readOriginalHostCpuProfile(path, true), {
      status: 'unavailable', reason: 'empty-profile', rawDiscarded: true, fileBytes: 0, fileOverLimit: false,
    });
    const fd = openSync(path, 'w', 0o600);
    try { ftruncateSync(fd, 32 * 1024 * 1024); } finally { closeSync(fd); }
    assert.deepEqual(await readOriginalHostCpuProfile(path, true), {
      status: 'unavailable', reason: 'profile-over-limit', rawDiscarded: true,
      fileBytes: 16 * 1024 * 1024 + 1, fileOverLimit: true,
    });
    assert.equal(existsSync(path), false);

    // Synthetic stack attribution only: the original finite sampler above is the sole child.
    const privateSource = `file://${root}/TEST-private-cpu-token`;
    const frame = (source: string, functionName: string) => ({ url: `${privateSource}/${source}`, functionName });
    const clone = { url: 'node:internal/worker/js_transferable', functionName: 'structuredClone' };
    const profile = { startTime: 100, endTime: 1100, nodes: [
      { id: 1, callFrame: { url: '', functionName: '(root)' }, children: [2, 12] },
      { id: 2, callFrame: frame('composition/captureMemberProviderAuthority.js', 'assertCurrent'), children: [3, 9, 10, 11] },
      { id: 3, callFrame: frame('adapters/team/TeamOwnerStore.js', 'fenced'), children: [4] },
      { id: 4, callFrame: frame('team/TeamOwner.js', 'state'), children: [5, 6] },
      { id: 5, callFrame: frame('team/TeamRuntimeRegistration.js', 'validate'), children: [] },
      { id: 6, callFrame: frame('adapters/team/FileTeamRuntimeBindings.js', 'current'), children: [7, 8] },
      { id: 7, callFrame: frame('adapters/team/FileTeamRuntimeBindings.js', 'read'), children: [14] },
      { id: 8, callFrame: clone, children: [] },
      { id: 9, callFrame: frame('foreign/FileTeamRuntimeBindings.js', 'current'), children: [] },
      { id: 10, callFrame: clone, children: [] },
      { id: 11, callFrame: frame('adapters/providers/OpenCodeV2CredentialScope.js', 'selected'), children: [] },
      { id: 12, callFrame: frame('adapters/team/FileTeamRuntimeBindings.js', 'current'), children: [13] },
      { id: 13, callFrame: clone, children: [] },
      { id: 14, callFrame: clone, children: [] },
    ], samples: [3, 4, 5, 6, 14, 8, 9, 10, 11, 13], timeDeltas: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] };
    writeFileSync(path, JSON.stringify(profile), { mode: 0o600 });
    const projected = await readOriginalHostCpuProfile(path, true, 10000);
    assert.equal(projected.status, 'available');
    assert.equal(projected.sampledUs, 550); assert.equal(projected.unsampledUs, 450);
    assert.deepEqual(projected.categories.map(row => [row.category, row.exclusiveSamples,
      row.exclusiveSampledUs, row.inclusiveSamples, row.inclusiveSampledUs]), [
      ['configuration-read', 0, 0, 0, 0], ['credential-read', 1, 90, 1, 90],
      ['team-writer-authority', 8, 360, 9, 450], ['custody-image', 0, 0, 0, 0],
      ['provider-transport', 0, 0, 0, 0], ['other', 1, 100, 1, 100], ['idle', 0, 0, 0, 0],
    ], 'original broad totals and inclusive overlap remain unchanged');
    assert.deepEqual(projected.teamWriterDetails, [
      { family: 'namespace-fence', exclusiveSamples: 1, exclusiveSampledUs: 10 },
      { family: 'team-state', exclusiveSamples: 1, exclusiveSampledUs: 20 },
      { family: 'team-state-validation', exclusiveSamples: 1, exclusiveSampledUs: 30 },
      { family: 'launch-binding-read', exclusiveSamples: 1, exclusiveSampledUs: 50 },
      { family: 'launch-binding-current', exclusiveSamples: 1, exclusiveSampledUs: 40 },
      { family: 'launch-binding-clone', exclusiveSamples: 1, exclusiveSampledUs: 60 },
      { family: 'other-writer', exclusiveSamples: 2, exclusiveSampledUs: 150 },
    ]);
    assert.equal(projected.teamWriterDetails.reduce((sum, row) => sum + row.exclusiveSampledUs, 0), 360);
    assert.equal(JSON.stringify(projected).includes(root), false);
    assert.equal(JSON.stringify(projected).includes('TEST-private-cpu-token'), false);
    assert.equal(projected.rawDiscarded, true); assert.equal(existsSync(path), false);
    writeFileSync(path, JSON.stringify({ ...profile, samples: [99], timeDeltas: [1] }), { mode: 0o600 });
    const malformed = await readOriginalHostCpuProfile(path, true, 10000);
    assert.equal(malformed.status, 'unavailable'); assert.equal(malformed.reason, 'invalid-profile');
    assert.equal('teamWriterDetails' in malformed, false);
    assert.equal(malformed.rawDiscarded, true); assert.equal(existsSync(path), false);

    // Synthetic receipt decoding only: no additional native child or raw diagnostics are retained.
    const passive = createPassiveNativeDiagnosticCapture(), prefix = 'TEST_OPENCODE_V2_DIAGNOSTIC ';
    const secret = 'TEST-private-native-token';
    const fifth = prefix + JSON.stringify({ event: 'child-ready', atMs: 7, child: 5,
      raw: secret, path: root }) + '\n';
    passive.accept(Buffer.from(fifth.slice(0, 23)), 1);
    assert.equal(passive.entries.length, 0, 'a partial line does not invent an observation');
    passive.accept(Buffer.from(fifth.slice(23)), 1);
    passive.accept(Buffer.from(prefix + JSON.stringify({ event: 'child-exit', atMs: 9,
      child: 6, exitCode: 0, unknownNativeField: secret }) + '\n' + secret + '\n'), 2);
    assert.equal(passive.entries.length, 2);
    assert.equal(passive.entries[0]!.child, 5, 'the source-derived metadata child remains observable');
    assert.equal(passive.entries[0]!.epoch, 1);
    assert.equal(passive.entries[1]!.child, null, 'an ordinal beyond the finite bound is not accepted');
    assert.equal(passive.entries[1]!.epoch, 2);
    assert.equal(JSON.stringify(passive.entries).includes(secret), false);
    assert.equal(JSON.stringify(passive.entries).includes(root), false);
  } finally {
    if (host.child.exitCode === null && host.child.signalCode === null) await host.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('native fixture observes advertised disposal before signaling the original child', async () => {
  const original = { now: 0, endCalls: 0, signals: [] as number[], waits: [] as number[] };
  // Runtime may already be closed; final backup is still allowed to finish at 45 s.
  await closeNativeHostInput(
    {
      endInput() {
        original.endCalls++;
      },
      async waitExit(timeoutMs) {
        original.waits.push(timeoutMs);
        const deadline = original.now + timeoutMs;
        if (deadline >= 45_000) {
          original.now = 45_000;
          return true;
        }
        original.now = deadline;
        return false;
      },
      terminate() {
        original.signals.push(original.now);
      },
    },
    60_000
  );
  assert.equal(original.endCalls, 1);
  assert.equal(original.now, 45_000);
  assert.deepEqual(original.waits, [62_000]);
  assert.deepEqual(
    original.signals,
    [],
    'same original child finishes naturally within its contract'
  );
});

test('native fixture retains failure after one bounded original-child fallback', async () => {
  let now = 0,
    endCalls = 0;
  const signals: number[] = [];
  await assert.rejects(
    closeNativeHostInput(
      {
        endInput() {
          endCalls++;
        },
        async waitExit(timeoutMs) {
          now += timeoutMs;
          return false;
        },
        terminate() {
          signals.push(now);
        },
      },
      60_000
    ),
    /captured Host must confirm provider cleanup before exiting/
  );
  assert.equal(endCalls, 1);
  assert.deepEqual(signals, [62_000]);
  assert.equal(now, 74_000, 'unconfirmed exit remains a bounded failure');
});

test('native fixture refuses invalid disposal budgets before touching the original child', async () => {
  const effects: string[] = [];
  for (const invalid of [60_001, Number.MAX_SAFE_INTEGER, Number.NaN]) {
    await assert.rejects(
      closeNativeHostInput(
        {
          endInput() {
            effects.push('end');
          },
          async waitExit() {
            effects.push('wait');
            return true;
          },
          terminate() {
            effects.push('signal');
          },
        },
        invalid
      ),
      /within the captured TeamHost contract/
    );
  }
  assert.deepEqual(effects, []);
});
